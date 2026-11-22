import { getDb, resetDb } from '../../lib/db';
import {
  MAX_LOCAL_EMBED_CHARS,
  boundLocalEmbedText,
  deserializeEmbedding,
  setCustomEmbedder,
  serializeEmbedding,
} from '../../learning/embedding';
import { verifyOrCreateStoreMeta } from '../../learning/storeMeta';
import { hybridSearch } from '../../learning/search';
import * as embedWorker from '../../learning/embedWorker';
import { createNote, getNotesByFile } from '../../memory/noteStore';
import { captureObservations } from '../../memory/observationStore';
import { logTrajectory } from '../../memory/trajectoryStore';

describe('hybridSearch', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'local';
    process.env.BRAIN_EMBED_MODEL = 'nomic';
    process.env.BRAIN_EMBED_DIM = '4';
    resetDb();
  });

  afterEach(() => {
    resetDb();
    setCustomEmbedder(null);
    process.env = { ...originalEnv };
  });

  it('performs hybrid search with RRF fusion', async () => {
    verifyOrCreateStoreMeta();

    // Custom query embedder returns [1, 0, 0, 0]
    setCustomEmbedder(async () => [1, 0, 0, 0]);

    // Note 1: strong dense match ([1, 0, 0, 0]), but low BM25 text match
    const note1 = createNote({
      scope: 'project',
      projectId: 'p1',
      type: 'fact',
      title: 'Database connection configuration',
      content: 'App uses PostgreSQL connection pool.',
    });
    getDb()
      .prepare('UPDATE notes SET embedding = ? WHERE id = ?')
      .run(serializeEmbedding([1, 0, 0, 0]), note1.id);

    // Note 2: strong BM25 keyword match for "foreign key constraint failed", but orthogonal vector ([0, 1, 0, 0])
    const note2 = createNote({
      scope: 'project',
      projectId: 'p1',
      type: 'bug',
      title: 'Foreign key constraint failed on migration',
      content: 'SQLite error foreign key constraint failed when running schema upgrade.',
    });
    getDb()
      .prepare('UPDATE notes SET embedding = ? WHERE id = ?')
      .run(serializeEmbedding([0, 1, 0, 0]), note2.id);

    // Note 3: has both dense match and keyword match
    const note3 = createNote({
      scope: 'project',
      projectId: 'p1',
      type: 'pattern',
      title: 'Fix for foreign key constraint',
      content: 'Foreign key constraint issue was solved by disabling PRAGMA foreign_keys.',
    });
    getDb()
      .prepare('UPDATE notes SET embedding = ? WHERE id = ?')
      .run(serializeEmbedding([0.8, 0.6, 0, 0]), note3.id);

    const searchRes = await hybridSearch({
      q: 'foreign key constraint failed',
      project_id: 'p1',
      record_types: ['note'],
    });

    expect(searchRes.mode).toBe('hybrid');
    expect(searchRes.results.length).toBeGreaterThan(0);

    // note3 matches both legs, so its RRF score should be highest or among the top
    const topResult = searchRes.results[0];
    expect(topResult).toBeDefined();

    // Verify BM25-only match outside dense top-k still surfaces via RRF
    const foundNote2 = searchRes.results.find((r) => r.id === note2.id);
    expect(foundNote2).toBeDefined();
    expect(foundNote2?.score).toBeGreaterThan(0);
  });

  it('strictly adheres to scope filtering rules and NEVER returns unknown unless requested', async () => {
    verifyOrCreateStoreMeta();
    setCustomEmbedder(async () => [1, 0, 0, 0]);

    // Note in project 'alpha'
    const noteProj = createNote({
      scope: 'project',
      projectId: 'alpha',
      type: 'fact',
      title: 'Alpha architecture document',
      content: 'Alpha architecture details',
    });

    // Note in 'global' scope
    const noteGlobal = createNote({
      scope: 'global',
      type: 'pattern',
      title: 'Global architecture guidelines',
      content: 'Global architecture rules for all teams',
    });

    // Note in 'unknown' scope (e.g. unlabelled)
    const noteUnknown = createNote({
      scope: 'unknown',
      type: 'fact',
      title: 'Unlabelled architecture mystery note',
      content: 'Architecture note with unknown scope',
    });

    // Case 1: Search scoped to project 'alpha' with include_global: true (default)
    const resProject = await hybridSearch({
      q: 'architecture',
      project_id: 'alpha',
      include_global: true,
      record_types: ['note'],
    });

    const projectResultIds = resProject.results.map((r) => r.id);
    expect(projectResultIds).toContain(noteProj.id);
    expect(projectResultIds).toContain(noteGlobal.id);
    // MUST NOT contain unknown!
    expect(projectResultIds).not.toContain(noteUnknown.id);

    // Case 2: Search with include_global: false
    const resNoGlobal = await hybridSearch({
      q: 'architecture',
      project_id: 'alpha',
      include_global: false,
      record_types: ['note'],
    });
    const noGlobalIds = resNoGlobal.results.map((r) => r.id);
    expect(noGlobalIds).toContain(noteProj.id);
    expect(noGlobalIds).not.toContain(noteGlobal.id);
    expect(noGlobalIds).not.toContain(noteUnknown.id);

    // Case 3: Search explicitly for scope: 'unknown' (the repair list)
    const resUnknown = await hybridSearch({
      q: 'architecture',
      scope: 'unknown',
      record_types: ['note'],
    });
    const unknownIds = resUnknown.results.map((r) => r.id);
    expect(unknownIds).toContain(noteUnknown.id);
    expect(unknownIds).not.toContain(noteProj.id);
    expect(unknownIds).not.toContain(noteGlobal.id);
  });

  it('filters by grains correctly', async () => {
    verifyOrCreateStoreMeta();
    setCustomEmbedder(async () => [1, 0, 0, 0]);

    createNote({
      scope: 'global',
      type: 'fact',
      title: 'Refactor memory subsystem',
      content: 'Notes on refactoring memory',
    });

    logTrajectory({
      scope: 'global',
      description: 'Refactor memory subsystem',
      success: true,
    });

    const noteOnlyRes = await hybridSearch({
      q: 'refactor memory',
      record_types: ['note'],
    });
    expect(noteOnlyRes.results.every((r) => r.record_type === 'note')).toBe(true);

    const trajOnlyRes = await hybridSearch({
      q: 'refactor memory',
      record_types: ['trajectory'],
    });
    expect(trajOnlyRes.results.every((r) => r.record_type === 'trajectory')).toBe(true);
  });

  it('returns degraded mode with BM25 when store_meta mismatches', async () => {
    // Pin as nomic 512
    process.env.BRAIN_EMBED = 'local';
    process.env.BRAIN_EMBED_MODEL = 'nomic';
    process.env.BRAIN_EMBED_DIM = '512';
    verifyOrCreateStoreMeta();

    // Now change config to minilm 384 without reembedding
    process.env.BRAIN_EMBED = 'local';
    process.env.BRAIN_EMBED_MODEL = 'minilm';
    delete process.env.BRAIN_EMBED_DIM;

    createNote({
      scope: 'global',
      type: 'fact',
      title: 'Migration checklist',
      content: 'Steps to migrate SQLite schema',
    });

    const res = await hybridSearch({
      q: 'migration checklist',
      record_types: ['note'],
    });

    expect(res.mode).toBe('bm25');
    expect(res.degraded).toBeDefined();
    expect(res.degraded).toContain('vector search unavailable');
    expect(res.results.length).toBeGreaterThan(0);
  });

  it('looks up notes by file association with getNotesByFile', () => {
    const note = createNote({
      scope: 'project',
      projectId: 'neuralswarm',
      type: 'bug',
      title: 'Concurrency bug in db.ts',
      content: 'Avoid nested transactions in db.ts',
      files: ['src/lib/db.ts'],
    });

    const notesForFile = getNotesByFile('src/lib/db.ts', 'neuralswarm');
    expect(notesForFile.length).toBe(1);
    expect(notesForFile[0].id).toBe(note.id);
    expect(notesForFile[0].files).toContain('src/lib/db.ts');

    // Looking up different file returns empty
    const other = getNotesByFile('src/other.ts', 'neuralswarm');
    expect(other.length).toBe(0);
  });

  it('omits embedding blobs from search records and avoids duplicating summary claims/sources', async () => {
    verifyOrCreateStoreMeta();
    setCustomEmbedder(async () => [1, 0, 0, 0]);
    const db = getDb();
    const vec = serializeEmbedding([1, 0, 0, 0]);

    const note = createNote({
      scope: 'project',
      projectId: 'p-compact',
      type: 'fact',
      title: 'Acme Alpha note',
      content: 'Compact search result test for acme alpha',
    });
    db.prepare('UPDATE notes SET embedding = ? WHERE id = ?').run(vec, note.id);

    const trajId = logTrajectory({
      scope: 'project',
      projectId: 'p-compact',
      taskType: 'feature',
      description: 'Acme Alpha trajectory',
      result: 'Completed acme alpha task',
      success: true,
    });
    db.prepare('UPDATE trajectories SET embedding = ? WHERE id = ?').run(vec, trajId);

    db.prepare(`
      INSERT INTO summaries (
        id, scope, project_id, kind, outcome, producer_tier, prompt_version, verified, is_latest, embedding
      ) VALUES (?, 'project', 'p-compact', 'session', 'success', 'agent', 'extract-v1', 1, 1, ?)
    `).run('sum_compact_1', vec);
    db.prepare(`
      INSERT INTO summary_claims (id, summary_id, text, ordinal)
      VALUES ('clm_compact_1', 'sum_compact_1', 'Acme Alpha summary claim', 0)
    `).run();
    db.prepare(`
      INSERT INTO summary_sources (summary_id, claim_id, record_id, record_type)
      VALUES ('sum_compact_1', 'clm_compact_1', 'obs_compact_1', 'observation')
    `).run();

    const res = await hybridSearch({
      q: 'acme alpha',
      project_id: 'p-compact',
      record_types: ['note', 'trajectory', 'summary'],
      limit: 10,
    });

    expect(res.results.length).toBe(3);
    for (const item of res.results) {
      expect(item.record).not.toHaveProperty('embedding');
    }

    const summaryItem = res.results.find((r) => r.record_type === 'summary');
    expect(summaryItem).toBeDefined();
    expect(summaryItem!.claims).toHaveLength(1);
    expect(summaryItem!.sources).toBeUndefined();
    expect(summaryItem!.sources_total).toBeUndefined();
    expect(summaryItem!.record).not.toHaveProperty('claims');
    expect(summaryItem!.record).not.toHaveProperty('sources');

    // Opt-in include_sources returns enriched observation titles and pagination metadata
    db.prepare(`
      INSERT INTO observations (id, scope, project_id, kind, tool_name, file_path, input, failed)
      VALUES ('obs_compact_1', 'project', 'p-compact', 'tool_call', 'read_file', 'src/a.ts', 'read src/a.ts', 0)
    `).run();
    db.prepare(`
      INSERT INTO observations (id, scope, project_id, kind, tool_name, file_path, input, failed)
      VALUES ('obs_compact_2', 'project', 'p-compact', 'tool_call', 'run_command', NULL, 'npm test', 1)
    `).run();
    db.prepare(`
      INSERT INTO summary_sources (summary_id, claim_id, record_id, record_type)
      VALUES ('sum_compact_1', 'clm_compact_1', 'obs_compact_2', 'observation')
    `).run();

    const page1 = await hybridSearch({
      q: 'acme alpha',
      project_id: 'p-compact',
      record_types: ['summary'],
      include_sources: true,
      sources_limit: 1,
      sources_offset: 0,
    });
    const p1Summary = page1.results.find((r) => r.record_type === 'summary')!;
    expect(p1Summary.sources).toHaveLength(1);
    expect(p1Summary.sources_total).toBe(2);
    expect(p1Summary.sources_has_more).toBe(true);
    expect(p1Summary.sources![0].title).toBe('read_file: src/a.ts');
    expect(p1Summary.sources![0].failed).toBe(false);

    const page2 = await hybridSearch({
      q: 'acme alpha',
      project_id: 'p-compact',
      record_types: ['summary'],
      include_sources: true,
      sources_limit: 1,
      sources_offset: 1,
    });
    const p2Summary = page2.results.find((r) => r.record_type === 'summary')!;
    expect(p2Summary.sources).toHaveLength(1);
    expect(p2Summary.sources_total).toBe(2);
    expect(p2Summary.sources_has_more).toBe(false);
    expect(p2Summary.sources![0].title).toBe('run_command');
    expect(p2Summary.sources![0].failed).toBe(true);
    expect(p2Summary.sources![0].preview).toBe('npm test');
  });

  it('handles unaligned Buffer.byteOffset in deserializeEmbedding and bounds embed text', () => {
    const raw = serializeEmbedding([0.25, 0.5, 0.75, 1.0]);
    const padded = Buffer.concat([Buffer.from([0xaa]), raw]);
    const unaligned = padded.subarray(1);
    expect(unaligned.byteOffset % 4).not.toBe(0);

    const decoded = deserializeEmbedding(unaligned);
    expect(decoded).toHaveLength(4);
    expect(decoded[0]).toBeCloseTo(0.25);
    expect(decoded[3]).toBeCloseTo(1.0);

    const huge = 'x'.repeat(MAX_LOCAL_EMBED_CHARS + 500);
    expect(boundLocalEmbedText(huge).length).toBe(MAX_LOCAL_EMBED_CHARS);
  });

  it('truncates observation input/output to 2000 chars and hydrates Qdrant hits outside newest 500', async () => {
    verifyOrCreateStoreMeta();
    setCustomEmbedder(async () => [1, 0, 0, 0]);
    const db = getDb();

    // 1. Observation truncation
    captureObservations([
      {
        scope: 'project',
        project_id: 'p-obs-trunc',
        kind: 'tool_call',
        tool_name: 'Bash',
        input: `cmd ${'a'.repeat(3000)}`,
        output: `out ${'b'.repeat(3000)}`,
      },
    ]);

    const obsRes = await hybridSearch({
      q: 'cmd',
      project_id: 'p-obs-trunc',
      record_types: ['observation'],
    });
    expect(obsRes.results).toHaveLength(1);
    expect(obsRes.results[0].record.input.length).toBeLessThanOrEqual(2003);
    expect(obsRes.results[0].record.output.length).toBeLessThanOrEqual(2003);

    // 2. Hydrate Qdrant hit outside newest 500 SQLite rows
    const oldNote = createNote({
      scope: 'project',
      projectId: 'p-hydrate',
      type: 'fact',
      title: 'Ancient Qdrant Hit',
      content: 'Semantic match beyond newest 500',
    });
    db.prepare('UPDATE notes SET created_at = 100 WHERE id = ?').run(oldNote.id);

    // Insert 501 newer notes so oldNote is outside LIMIT 500
    const insertNote = db.prepare(`
      INSERT INTO notes (id, scope, project_id, type, title, content, is_latest, created_at)
      VALUES (?, 'project', 'p-hydrate', 'fact', 'Filler', 'Filler content', 1, ?)
    `);
    for (let i = 0; i < 501; i++) {
      insertNote.run(`note_fill_${i}`, 1000 + i);
    }

    const qdrantSpy = jest.spyOn(embedWorker, 'getQdrantClient').mockReturnValue({
      search: jest.fn().mockResolvedValue([
        { id: oldNote.id, score: 0.99, payload: { record_type: 'note' } },
      ]),
    } as any);

    try {
      const hydratedRes = await hybridSearch({
        q: 'unrelated query',
        project_id: 'p-hydrate',
        record_types: ['note'],
      });
      expect(hydratedRes.results.some((r) => r.id === oldNote.id)).toBe(true);
    } finally {
      qdrantSpy.mockRestore();
    }
  });
});
