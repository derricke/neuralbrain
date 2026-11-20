import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { deserializeEmbedding, embedQuery, resolveEmbedderRecipe } from './embedding';
import { verifyOrCreateStoreMeta } from './storeMeta';
import { getQdrantClient } from './embedWorker';
import type { SearchRequest, SearchResponse, SearchResultItem } from './types';

const MAX_OBS_RECORD_CHARS = 2000;

function docKey(grain: string, id: string): string {
  return `${grain}:${id}`;
}

function truncateObsField(value: string | null): string | null {
  if (!value || value.length <= MAX_OBS_RECORD_CHARS) return value;
  return `${value.slice(0, MAX_OBS_RECORD_CHARS)}...`;
}

function tokenize(text: string): string[] {
  if (!text) return [];
  const matches = text.toLowerCase().match(/[a-z0-9_./-]+/g);
  return matches ? matches : [];
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

interface CandidateDoc {
  id: string;
  grain: 'note' | 'trajectory' | 'observation' | 'summary';
  record: Record<string, any>;
  text: string;
  embedding: Buffer | null;
  claims?: Array<{ id: string; summary_id: string; text: string; ordinal: number }>;
  sources?: Array<{ summary_id: string; claim_id: string; record_id: string; grain: string }>;
  bm25Score?: number;
  denseScore?: number;
  rrfScore?: number;
}

export function buildQdrantFilter(
  params: SearchRequest,
  grains: string[],
  includeGlobal: boolean
): Record<string, any> | undefined {
  const must: any[] = [];

  // Grains filter
  if (grains.length === 1) {
    must.push({ key: 'grain', match: { value: grains[0] } });
  } else if (grains.length > 1) {
    must.push({ key: 'grain', match: { any: grains } });
  }

  // Scope filter
  if (params.scope === 'unknown') {
    must.push({ key: 'scope', match: { value: 'unknown' } });
  } else if (params.scope === 'global' || !params.project_id) {
    must.push({ key: 'scope', match: { value: 'global' } });
  } else if (params.project_id) {
    if (includeGlobal) {
      must.push({
        should: [
          {
            must: [
              { key: 'scope', match: { value: 'project' } },
              { key: 'project_id', match: { value: params.project_id } },
            ],
          },
          { key: 'scope', match: { value: 'global' } },
        ],
      });
    } else {
      must.push({ key: 'scope', match: { value: 'project' } });
      must.push({ key: 'project_id', match: { value: params.project_id } });
    }
  }

  // Metadata filters
  if (params.filters?.type && params.filters.type.length > 0) {
    must.push(
      params.filters.type.length === 1
        ? { key: 'type', match: { value: params.filters.type[0] } }
        : { key: 'type', match: { any: params.filters.type } }
    );
  }
  if (params.filters?.kind) {
    must.push({ key: 'kind', match: { value: params.filters.kind.trim() } });
  }
  if (params.filters?.task_type) {
    must.push({ key: 'task_type', match: { value: params.filters.task_type.trim() } });
  }
  if (params.filters?.file_path) {
    must.push({ key: 'file_path', match: { value: params.filters.file_path.trim() } });
  }
  if (params.filters?.agent) {
    must.push({ key: 'agent', match: { value: params.filters.agent.trim() } });
  }
  if (params.filters?.success !== undefined) {
    must.push({ key: 'success', match: { value: !!params.filters.success } });
  }
  if (params.filters?.note_ref) {
    must.push({ key: 'note_ref', match: { value: params.filters.note_ref.trim() } });
  }
  if (params.filters?.task_ref) {
    must.push({ key: 'task_ref', match: { value: params.filters.task_ref.trim() } });
  }
  if ((params.filters as any)?.session_id) {
    must.push({ key: 'session_id', match: { value: (params.filters as any).session_id.trim() } });
  }

  if (must.length === 0) return undefined;
  return { must };
}

export async function hybridSearch(params: SearchRequest): Promise<SearchResponse> {
  const q = params.q?.trim() || '';
  const requestedTypes =
    params.record_types && params.record_types.length > 0
      ? params.record_types
      : params.grains;
  const grains =
    requestedTypes && requestedTypes.length > 0 ? requestedTypes : ['note', 'trajectory'];
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 100);
  const includeGlobal = params.include_global !== false;
  const db = getDb();

  // Scope filter helper
  const buildScopeClause = (tablePrefix: string): { clause: string; params: unknown[] } => {
    const colScope = tablePrefix ? `${tablePrefix}.scope` : 'scope';
    const colProject = tablePrefix ? `${tablePrefix}.project_id` : 'project_id';

    if (params.scope === 'unknown') {
      return { clause: `${colScope} = 'unknown'`, params: [] };
    }

    if (params.scope === 'global' || !params.project_id) {
      return { clause: `${colScope} = 'global'`, params: [] };
    }

    if (params.project_id) {
      if (includeGlobal) {
        return {
          clause: `((${colScope} = 'project' AND ${colProject} = ?) OR ${colScope} = 'global')`,
          params: [params.project_id],
        };
      } else {
        return {
          clause: `(${colScope} = 'project' AND ${colProject} = ?)`,
          params: [params.project_id],
        };
      }
    }

    return { clause: `${colScope} != 'unknown'`, params: [] };
  };

  const candidates: CandidateDoc[] = [];

  // 1. Helpers to fetch & hydrate candidate records from SQLite (shared between initial LIMIT 500 and Qdrant ID hydration)
  const fetchNotes = (ids?: string[]): CandidateDoc[] => {
    const scopeFilter = buildScopeClause('n');
    const conditions: string[] = ['n.is_latest = 1', scopeFilter.clause];
    const queryParams: unknown[] = [...scopeFilter.params];

    if (params.filters?.type && params.filters.type.length > 0) {
      const placeholders = params.filters.type.map(() => '?').join(',');
      conditions.push(`n.type IN (${placeholders})`);
      queryParams.push(...params.filters.type);
    }
    if (params.filters?.file_path) {
      conditions.push(
        `EXISTS (SELECT 1 FROM note_files nf WHERE nf.note_id = n.id AND nf.file_path = ?)`
      );
      queryParams.push(params.filters.file_path.trim());
    }
    if (params.filters?.agent) {
      conditions.push(`n.author = ?`);
      queryParams.push(params.filters.agent.trim());
    }
    if (ids) {
      if (ids.length === 0) return [];
      conditions.push(`n.id IN (${ids.map(() => '?').join(',')})`);
      queryParams.push(...ids);
    }

    const sql = ids
      ? `SELECT * FROM notes n WHERE ${conditions.join(' AND ')}`
      : `SELECT * FROM notes n WHERE ${conditions.join(' AND ')} ORDER BY n.created_at DESC LIMIT 500`;
    const rows = db.prepare(sql).all(...queryParams) as any[];
    if (rows.length === 0) return [];

    const noteIds = rows.map((r) => r.id);
    const placeholders = noteIds.map(() => '?').join(',');

    const allConcepts = db
      .prepare(`SELECT note_id, concept FROM note_concepts WHERE note_id IN (${placeholders})`)
      .all(...noteIds) as Array<{ note_id: string; concept: string }>;
    const conceptsByNoteId = new Map<string, string[]>();
    for (const row of allConcepts) {
      let list = conceptsByNoteId.get(row.note_id);
      if (!list) {
        list = [];
        conceptsByNoteId.set(row.note_id, list);
      }
      list.push(row.concept);
    }

    const allFiles = db
      .prepare(`SELECT note_id, file_path FROM note_files WHERE note_id IN (${placeholders})`)
      .all(...noteIds) as Array<{ note_id: string; file_path: string }>;
    const filesByNoteId = new Map<string, string[]>();
    for (const row of allFiles) {
      let list = filesByNoteId.get(row.note_id);
      if (!list) {
        list = [];
        filesByNoteId.set(row.note_id, list);
      }
      list.push(row.file_path);
    }

    return rows.map((row) => {
      const concepts = conceptsByNoteId.get(row.id) || [];
      const files = filesByNoteId.get(row.id) || [];
      const { embedding, ...rowWithoutEmbedding } = row;
      const record = { ...rowWithoutEmbedding, concepts, files };
      const text = `${row.title}\n\n${row.content}\n${concepts.join(' ')}\n${files.join(' ')}`;
      return { id: row.id, grain: 'note', record, text, embedding };
    });
  };

  const fetchTrajectories = (ids?: string[]): CandidateDoc[] => {
    const scopeFilter = buildScopeClause('t');
    const conditions: string[] = [scopeFilter.clause];
    const queryParams: unknown[] = [...scopeFilter.params];

    if (params.filters?.task_type) {
      conditions.push(`t.task_type = ?`);
      queryParams.push(params.filters.task_type.trim());
    }
    if (params.filters?.agent) {
      conditions.push(`t.agent = ?`);
      queryParams.push(params.filters.agent.trim());
    }
    if (params.filters?.success !== undefined) {
      conditions.push(`t.success = ?`);
      queryParams.push(params.filters.success ? 1 : 0);
    }
    if (params.filters?.note_ref) {
      conditions.push(`t.note_ref = ?`);
      queryParams.push(params.filters.note_ref.trim());
    }
    if (params.filters?.task_ref) {
      conditions.push(`t.task_ref = ?`);
      queryParams.push(params.filters.task_ref.trim());
    }
    if (ids) {
      if (ids.length === 0) return [];
      conditions.push(`t.id IN (${ids.map(() => '?').join(',')})`);
      queryParams.push(...ids);
    }

    const sql = ids
      ? `SELECT * FROM trajectories t WHERE ${conditions.join(' AND ')}`
      : `SELECT * FROM trajectories t WHERE ${conditions.join(' AND ')} ORDER BY t.created_at DESC LIMIT 500`;
    const rows = db.prepare(sql).all(...queryParams) as any[];

    return rows.map((row) => {
      const { embedding, ...rowWithoutEmbedding } = row;
      const text = `${row.description || ''}\n${row.result || ''}\n${row.task_type || ''}`;
      return { id: row.id, grain: 'trajectory', record: rowWithoutEmbedding, text, embedding };
    });
  };

  const fetchObservations = (ids?: string[]): CandidateDoc[] => {
    const scopeFilter = buildScopeClause('o');
    const conditions: string[] = [scopeFilter.clause];
    const queryParams: unknown[] = [...scopeFilter.params];

    if (params.filters?.kind) {
      conditions.push(`o.kind = ?`);
      queryParams.push(params.filters.kind.trim());
    }
    if (params.filters?.file_path) {
      conditions.push(`o.file_path = ?`);
      queryParams.push(params.filters.file_path.trim());
    }
    if (params.filters?.agent) {
      conditions.push(`o.agent = ?`);
      queryParams.push(params.filters.agent.trim());
    }
    if (params.filters?.success !== undefined) {
      conditions.push(`o.failed = ?`);
      queryParams.push(params.filters.success ? 0 : 1);
    }
    if (params.filters?.note_ref) {
      conditions.push(`o.note_ref = ?`);
      queryParams.push(params.filters.note_ref.trim());
    }
    if (params.filters?.task_ref) {
      conditions.push(`o.task_ref = ?`);
      queryParams.push(params.filters.task_ref.trim());
    }
    if (ids) {
      if (ids.length === 0) return [];
      conditions.push(`o.id IN (${ids.map(() => '?').join(',')})`);
      queryParams.push(...ids);
    }

    const sql = ids
      ? `SELECT * FROM observations o WHERE ${conditions.join(' AND ')}`
      : `SELECT * FROM observations o WHERE ${conditions.join(' AND ')} ORDER BY o.created_at DESC LIMIT 500`;
    const rows = db.prepare(sql).all(...queryParams) as any[];

    return rows.map((row) => {
      const text = `${row.tool_name || ''}\n${row.file_path || ''}\n${row.input || ''}\n${row.output || ''}`;
      const record = {
        ...row,
        input: truncateObsField(row.input),
        output: truncateObsField(row.output),
      };
      return { id: row.id, grain: 'observation', record, text, embedding: null };
    });
  };

  const fetchSummaries = (ids?: string[]): CandidateDoc[] => {
    const scopeFilter = buildScopeClause('s');
    const conditions: string[] = ['s.is_latest = 1', scopeFilter.clause];
    const queryParams: unknown[] = [...scopeFilter.params];

    if (params.filters?.kind) {
      conditions.push(`s.kind = ?`);
      queryParams.push(params.filters.kind.trim());
    }
    if (params.filters?.agent) {
      conditions.push(`(s.producer_model = ? OR s.producer_tier = ?)`);
      queryParams.push(params.filters.agent.trim(), params.filters.agent.trim());
    }
    if (params.filters?.success !== undefined) {
      conditions.push(`s.outcome = ?`);
      queryParams.push(params.filters.success ? 'success' : 'failure');
    }
    if (ids) {
      if (ids.length === 0) return [];
      conditions.push(`s.id IN (${ids.map(() => '?').join(',')})`);
      queryParams.push(...ids);
    }

    const sql = ids
      ? `SELECT * FROM summaries s WHERE ${conditions.join(' AND ')}`
      : `SELECT * FROM summaries s WHERE ${conditions.join(' AND ')} ORDER BY s.created_at DESC LIMIT 500`;
    const rows = db.prepare(sql).all(...queryParams) as any[];
    if (rows.length === 0) return [];

    const summaryIds = rows.map((r) => r.id);
    const placeholders = summaryIds.map(() => '?').join(',');

    const allClaims = db
      .prepare(`SELECT id, summary_id, text, ordinal FROM summary_claims WHERE summary_id IN (${placeholders}) ORDER BY ordinal ASC`)
      .all(...summaryIds) as Array<{ id: string; summary_id: string; text: string; ordinal: number }>;
    const claimsBySummaryId = new Map<string, Array<{ id: string; summary_id: string; text: string; ordinal: number }>>();
    for (const c of allClaims) {
      let list = claimsBySummaryId.get(c.summary_id);
      if (!list) {
        list = [];
        claimsBySummaryId.set(c.summary_id, list);
      }
      list.push(c);
    }

    const allSources = db
      .prepare(`SELECT summary_id, claim_id, record_id, grain FROM summary_sources WHERE summary_id IN (${placeholders})`)
      .all(...summaryIds) as Array<{ summary_id: string; claim_id: string; record_id: string; grain: string }>;
    const sourcesBySummaryId = new Map<string, Array<{ summary_id: string; claim_id: string; record_id: string; grain: string }>>();
    for (const s of allSources) {
      let list = sourcesBySummaryId.get(s.summary_id);
      if (!list) {
        list = [];
        sourcesBySummaryId.set(s.summary_id, list);
      }
      list.push(s);
    }

    return rows.map((row) => {
      const claims = claimsBySummaryId.get(row.id) || [];
      const sources = sourcesBySummaryId.get(row.id) || [];
      const { embedding, ...rowWithoutEmbedding } = row;
      const text = claims.map((c) => c.text).join('\n');
      return {
        id: row.id,
        grain: 'summary',
        record: rowWithoutEmbedding,
        text,
        embedding,
        claims,
        sources,
      };
    });
  };

  if (grains.includes('note')) candidates.push(...fetchNotes());
  if (grains.includes('trajectory')) candidates.push(...fetchTrajectories());
  if (grains.includes('observation')) candidates.push(...fetchObservations());
  if (grains.includes('summary')) candidates.push(...fetchSummaries());

  // 2. Dense retrieval (run Qdrant first so hits outside the newest 500 SQLite rows can be hydrated)
  const recipe = resolveEmbedderRecipe();
  const verification = verifyOrCreateStoreMeta();
  const isMismatch = !verification.match && recipe.embed_tier !== 'none';

  let mode: 'hybrid' | 'bm25' = 'hybrid';
  let degradedMessage: string | undefined;

  if (recipe.embed_tier === 'none') {
    mode = 'bm25';
  } else if (isMismatch) {
    mode = 'bm25';
    degradedMessage = verification.mismatchReason;
  }

  const denseScoresMap = new Map<string, number>();
  let queryVec: number[] = [];

  if (mode === 'hybrid') {
    try {
      queryVec = await embedQuery(q);
      if (queryVec && queryVec.length > 0) {
        const qdrant = getQdrantClient();
        if (qdrant) {
          const alias = verification.meta?.qdrant_alias || 'brain';
          try {
            const filter = buildQdrantFilter(params, grains, includeGlobal);
            const searchRes = await qdrant.search(alias, {
              vector: queryVec,
              limit: Math.max(limit * 2, 50),
              with_payload: true,
              ...(filter ? { filter } : {}),
            });

            const existingKeys = new Set(candidates.map((c) => docKey(c.grain, c.id)));
            const missingByGrain = new Map<string, string[]>();

            for (const pt of searchRes) {
              const ptId =
                typeof pt.payload?.record_id === 'string' ? pt.payload.record_id : String(pt.id);
              const ptGrain = typeof pt.payload?.grain === 'string' ? pt.payload.grain : undefined;
              if (ptGrain) {
                const key = docKey(ptGrain, ptId);
                denseScoresMap.set(key, pt.score);
                if (grains.includes(ptGrain as any) && !existingKeys.has(key)) {
                  let list = missingByGrain.get(ptGrain);
                  if (!list) {
                    list = [];
                    missingByGrain.set(ptGrain, list);
                  }
                  list.push(ptId);
                }
              } else {
                for (const g of grains) {
                  const key = docKey(g, ptId);
                  denseScoresMap.set(key, pt.score);
                  if (!existingKeys.has(key)) {
                    let list = missingByGrain.get(g);
                    if (!list) {
                      list = [];
                      missingByGrain.set(g, list);
                    }
                    list.push(ptId);
                  }
                }
              }
            }

            // Hydrate Qdrant hits that fell outside the newest 500 SQLite rows
            for (const [grain, ids] of missingByGrain.entries()) {
              let hydrated: CandidateDoc[] = [];
              if (grain === 'note') hydrated = fetchNotes(ids);
              else if (grain === 'trajectory') hydrated = fetchTrajectories(ids);
              else if (grain === 'observation') hydrated = fetchObservations(ids);
              else if (grain === 'summary') hydrated = fetchSummaries(ids);
              for (const doc of hydrated) {
                const key = docKey(doc.grain, doc.id);
                if (!existingKeys.has(key)) {
                  existingKeys.add(key);
                  candidates.push(doc);
                }
              }
            }
          } catch {
            // Fallback to SQLite embedding blobs
          }
        }
      }
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'dense query embedding failed, falling back to BM25');
      mode = 'bm25';
    }
  }

  if (candidates.length === 0) {
    return {
      results: [],
      mode,
      degraded: degradedMessage,
    };
  }

  // 3. BM25 scoring over candidates (keyed by grain:id)
  const queryTokens = tokenize(q);
  const docTokensMap = new Map<string, string[]>();
  const docLengths: number[] = [];

  for (const c of candidates) {
    const tokens = tokenize(c.text);
    docTokensMap.set(docKey(c.grain, c.id), tokens);
    docLengths.push(tokens.length);
  }

  const N = candidates.length;
  const avgdl = docLengths.reduce((a, b) => a + b, 0) / (N || 1);
  const k1 = 1.2;
  const b = 0.75;

  // Compute document frequency for each query token
  const idfMap = new Map<string, number>();
  for (const token of queryTokens) {
    let df = 0;
    for (const c of candidates) {
      const tokens = docTokensMap.get(docKey(c.grain, c.id))!;
      if (tokens.includes(token)) df++;
    }
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    idfMap.set(token, idf);
  }

  for (const c of candidates) {
    const tokens = docTokensMap.get(docKey(c.grain, c.id))!;
    const tfMap = new Map<string, number>();
    for (const t of tokens) {
      tfMap.set(t, (tfMap.get(t) || 0) + 1);
    }
    let score = 0;
    const len = tokens.length;
    for (const qToken of queryTokens) {
      const tf = tfMap.get(qToken) || 0;
      if (tf > 0) {
        const idf = idfMap.get(qToken) || 0;
        const termScore = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (len / (avgdl || 1)))));
        score += termScore;
      }
    }
    c.bm25Score = score;
  }

  // Dense scoring fallback from SQLite embedding blobs for candidates not scored by Qdrant
  if (mode === 'hybrid' && queryVec.length > 0) {
    for (const c of candidates) {
      const key = docKey(c.grain, c.id);
      if (!denseScoresMap.has(key) && c.embedding) {
        const vec = deserializeEmbedding(c.embedding);
        if (vec.length === queryVec.length) {
          const sim = cosineSimilarity(queryVec, vec);
          denseScoresMap.set(key, sim);
        }
      }
    }
  }

  // 4. Rank candidates and compute RRF
  // Rank BM25
  const bm25Sorted = candidates
    .filter((c) => (c.bm25Score ?? 0) > 0)
    .sort((a, b) => (b.bm25Score ?? 0) - (a.bm25Score ?? 0));
  const bm25RankMap = new Map<string, number>();
  bm25Sorted.forEach((c, idx) => {
    bm25RankMap.set(docKey(c.grain, c.id), idx + 1);
  });

  // Rank Dense
  const denseRankMap = new Map<string, number>();
  if (mode === 'hybrid') {
    const denseSorted = candidates
      .filter((c) => {
        const key = docKey(c.grain, c.id);
        return denseScoresMap.has(key) && (denseScoresMap.get(key) ?? 0) > 0;
      })
      .sort(
        (a, b) =>
          (denseScoresMap.get(docKey(b.grain, b.id)) ?? 0) -
          (denseScoresMap.get(docKey(a.grain, a.id)) ?? 0)
      );
    denseSorted.forEach((c, idx) => {
      denseRankMap.set(docKey(c.grain, c.id), idx + 1);
    });
  }

  const k_rrf = 60;
  for (const c of candidates) {
    const key = docKey(c.grain, c.id);
    if (mode === 'hybrid') {
      const rankDense = denseRankMap.get(key);
      const rankBm25 = bm25RankMap.get(key);
      let rrf = 0;
      if (rankDense !== undefined) {
        rrf += 1 / (k_rrf + rankDense);
      }
      if (rankBm25 !== undefined) {
        rrf += 1 / (k_rrf + rankBm25);
      }
      c.rrfScore = rrf;
    } else {
      // In BM25 mode, score is the BM25 score
      c.rrfScore = c.bm25Score ?? 0;
    }
  }

  // Filter candidates with non-zero score
  const matched = candidates.filter((c) => (c.rrfScore ?? 0) > 0);
  matched.sort((a, b) => (b.rrfScore ?? 0) - (a.rrfScore ?? 0));

  const sliced = matched.slice(0, limit);

  const results: SearchResultItem[] = sliced.map((c) => {
    const item: SearchResultItem = {
      id: c.id,
      grain: c.grain,
      score: c.rrfScore ?? 0,
      record: c.record,
    };
    if (c.grain === 'summary') {
      item.claims = c.claims;
      item.sources = c.sources;
    }
    return item;
  });

  return {
    results,
    mode,
    degraded: degradedMessage,
  };
}
