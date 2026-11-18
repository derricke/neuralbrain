import { getDb } from '../lib/db';

export type GraphNodeType =
  | 'note'
  | 'lesson'
  | 'concept'
  | 'file'
  | 'session'
  | 'action'
  | 'summary';

export type GraphEdgeType =
  | 'has_concept'
  | 'touches_file'
  | 'supersedes'
  | 'from_session'
  | 'cites_source';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  scope?: string | null;
  project_id?: string | null;
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: GraphEdgeType;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
  };
}

export interface KnowledgeGraphOptions {
  projectId?: string;
  scope?: string;
  limit?: number;
}

function clampLimit(raw?: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return 80;
  }
  return Math.min(Math.floor(raw), 200);
}

/**
 * Parse and bound HTTP query parameters for knowledge graph endpoints.
 */
export function parseGraphQuery(query: Record<string, unknown>): KnowledgeGraphOptions {
  const projectId =
    typeof query.project_id === 'string'
      ? query.project_id
      : typeof query.projectId === 'string'
        ? query.projectId
        : undefined;
  const scope = typeof query.scope === 'string' ? query.scope : undefined;
  const rawLimit = query.limit;
  const parsedLimit =
    rawLimit !== undefined && rawLimit !== null && rawLimit !== ''
      ? parseInt(String(rawLimit), 10)
      : undefined;

  return {
    projectId,
    scope,
    limit: clampLimit(parsedLimit),
  };
}

function buildScopeFilter(
  projectId?: string,
  scope?: string
): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (projectId !== undefined) {
    conditions.push('project_id = ?');
    params.push(projectId);
  }
  if (scope !== undefined) {
    conditions.push('scope = ?');
    params.push(scope);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/**
 * Build a scoped knowledge graph from notes, concepts, files, sessions,
 * actions, summaries, and summary citations stored in SQLite.
 */
export function getKnowledgeGraph(options: KnowledgeGraphOptions = {}): KnowledgeGraph {
  const db = getDb();
  const limit = clampLimit(options.limit);
  const projectId =
    typeof options.projectId === 'string' && options.projectId.trim()
      ? options.projectId.trim()
      : undefined;
  const scope =
    typeof options.scope === 'string' && options.scope.trim()
      ? options.scope.trim()
      : undefined;

  const { where, params } = buildScopeFilter(projectId, scope);

  const nodeMap = new Map<string, GraphNode>();
  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];

  const addNode = (node: GraphNode) => {
    if (!nodeMap.has(node.id)) {
      nodeMap.set(node.id, node);
    }
  };

  const addEdge = (source: string, target: string, type: GraphEdgeType) => {
    if (!nodeMap.has(source) || !nodeMap.has(target)) return;
    const key = `${source}\0${type}\0${target}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push({ source, target, type });
    }
  };

  const noteRows = db
    .prepare(
      `
      SELECT id, scope, project_id, session_id, type, title, version, supersedes, is_latest, created_at
      FROM notes
      ${where}
      ORDER BY updated_at DESC
      LIMIT ?
      `
    )
    .all(...params, limit) as Array<{
    id: string;
    scope: string;
    project_id: string | null;
    session_id: string | null;
    type: string;
    title: string;
    version: number;
    supersedes: string | null;
    is_latest: number;
    created_at: number;
  }>;

  for (const note of noteRows) {
    const nodeType: GraphNodeType = note.type === 'lesson' ? 'lesson' : 'note';
    addNode({
      id: note.id,
      type: nodeType,
      label: note.title,
      scope: note.scope,
      project_id: note.project_id,
      meta: {
        noteType: note.type,
        version: note.version,
        is_latest: note.is_latest,
        created_at: note.created_at,
      },
    });
  }

  const sessionRows = db
    .prepare(
      `
      SELECT id, scope, project_id, agent_name, status, started_at, ended_at
      FROM sessions
      ${where}
      ORDER BY started_at DESC
      LIMIT ?
      `
    )
    .all(...params, limit) as Array<{
    id: string;
    scope: string;
    project_id: string | null;
    agent_name: string | null;
    status: string;
    started_at: string;
    ended_at: string | null;
  }>;

  for (const s of sessionRows) {
    addNode({
      id: s.id,
      type: 'session',
      label: s.agent_name ? `${s.agent_name} (${s.status})` : s.id,
      scope: s.scope,
      project_id: s.project_id,
      meta: {
        status: s.status,
        agent_name: s.agent_name,
        started_at: s.started_at,
        ended_at: s.ended_at,
      },
    });
  }

  const actionRows = db
    .prepare(
      `
      SELECT id, session_id, scope, project_id, title, status, priority, created_at
      FROM actions
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
      `
    )
    .all(...params, limit) as Array<{
    id: string;
    session_id: string | null;
    scope: string;
    project_id: string | null;
    title: string;
    status: string;
    priority: string;
    created_at: string;
  }>;

  for (const a of actionRows) {
    addNode({
      id: a.id,
      type: 'action',
      label: a.title,
      scope: a.scope,
      project_id: a.project_id,
      meta: {
        status: a.status,
        priority: a.priority,
        created_at: a.created_at,
      },
    });
  }

  const summaryRows = db
    .prepare(
      `
      SELECT id, scope, project_id, kind, outcome, producer_tier, verified, created_at
      FROM summaries
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
      `
    )
    .all(...params, limit) as Array<{
    id: string;
    scope: string;
    project_id: string | null;
    kind: string;
    outcome: string | null;
    producer_tier: string;
    verified: number;
    created_at: number;
  }>;

  for (const sum of summaryRows) {
    addNode({
      id: sum.id,
      type: 'summary',
      label: `${sum.kind} (${sum.outcome ?? 'unknown'})`,
      scope: sum.scope,
      project_id: sum.project_id,
      meta: {
        kind: sum.kind,
        outcome: sum.outcome,
        producer_tier: sum.producer_tier,
        verified: sum.verified,
        created_at: sum.created_at,
      },
    });
  }

  if (noteRows.length > 0) {
    const noteIds = noteRows.map((n) => n.id);
    const placeholders = noteIds.map(() => '?').join(',');

    const conceptRows = db
      .prepare(`SELECT note_id, concept FROM note_concepts WHERE note_id IN (${placeholders})`)
      .all(...noteIds) as Array<{ note_id: string; concept: string }>;

    for (const row of conceptRows) {
      const conceptId = `concept:${row.concept}`;
      addNode({ id: conceptId, type: 'concept', label: row.concept });
      addEdge(row.note_id, conceptId, 'has_concept');
    }

    const fileRows = db
      .prepare(`SELECT note_id, file_path FROM note_files WHERE note_id IN (${placeholders})`)
      .all(...noteIds) as Array<{ note_id: string; file_path: string }>;

    for (const row of fileRows) {
      const fileId = `file:${row.file_path}`;
      addNode({ id: fileId, type: 'file', label: row.file_path });
      addEdge(row.note_id, fileId, 'touches_file');
    }

    for (const note of noteRows) {
      if (note.supersedes) {
        addEdge(note.id, note.supersedes, 'supersedes');
      }
      if (note.session_id) {
        addEdge(note.id, note.session_id, 'from_session');
      }
    }
  }

  for (const action of actionRows) {
    if (action.session_id) {
      addEdge(action.id, action.session_id, 'from_session');
    }
  }

  if (summaryRows.length > 0) {
    const summaryIds = summaryRows.map((s) => s.id);
    const placeholders = summaryIds.map(() => '?').join(',');
    const sourceRows = db
      .prepare(
        `SELECT DISTINCT summary_id, record_id FROM summary_sources WHERE summary_id IN (${placeholders})`
      )
      .all(...summaryIds) as Array<{ summary_id: string; record_id: string }>;

    for (const row of sourceRows) {
      addEdge(row.summary_id, row.record_id, 'cites_source');
    }
  }

  const nodes = Array.from(nodeMap.values());
  return {
    nodes,
    edges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
    },
  };
}
