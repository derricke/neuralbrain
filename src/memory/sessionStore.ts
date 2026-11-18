import { randomUUID } from 'crypto';
import { getDb } from '../lib/db';
import { resolveScope, ScopeValue } from '../lib/scope';
import type { ObservationRecord } from './observationStore';
import type { NoteRecord } from './noteStore';
import type { ActionRecord } from './actionStore';

export type SessionStatus = 'active' | 'paused' | 'completed' | 'abandoned';

const VALID_SESSION_STATUSES = new Set<SessionStatus>([
  'active',
  'paused',
  'completed',
  'abandoned',
]);

export interface SessionRecord {
  id: string;
  scope: ScopeValue;
  project_id: string | null;
  agent_name: string | null;
  cwd: string | null;
  status: SessionStatus;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  files_touched_json: string | null;
  handoff_summary_id: string | null;
}

export interface StartSessionInput {
  id?: string;
  scope?: ScopeValue;
  project_id?: string | null;
  projectId?: string | null;
  agent_name?: string | null;
  agentName?: string | null;
  cwd?: string | null;
}

export interface EndSessionInput {
  status?: SessionStatus;
  summary?: string | null;
  files_touched?: string[];
  filesTouched?: string[];
  handoff_summary_id?: string | null;
  handoffSummaryId?: string | null;
}

export interface SessionDetails {
  session: SessionRecord;
  observations: ObservationRecord[];
  notes: NoteRecord[];
  actions: ActionRecord[];
}

export interface SessionReplayItem {
  kind: 'observation' | 'note' | 'action';
  timestamp: string;
  id: string;
  title: string;
  detail: string | null;
  meta?: Record<string, unknown>;
}

export interface SessionReplay {
  session: SessionRecord;
  timeline: SessionReplayItem[];
}

function makeSchemaError(message: string): Error {
  const err = new Error(message);
  (err as any).code = 'SCHEMA_INVALID';
  return err;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw makeSchemaError(`${field} must be a string`);
  }
  return value.trim() || null;
}

/**
 * Start a new session or reactivate an existing session with the given id.
 */
export function startSession(input: StartSessionInput = {}): SessionRecord {
  const rawProject = input.projectId !== undefined ? input.projectId : input.project_id;
  const scoped = resolveScope(input.scope, rawProject);
  if (!scoped.ok) {
    throw makeSchemaError(scoped.error);
  }

  const db = getDb();
  const customId = optionalString(input.id, 'id');
  const id = customId || `sess_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const rawAgent = input.agentName !== undefined ? input.agentName : input.agent_name;
  const agentName = optionalString(rawAgent, 'agent_name');
  const cwd = optionalString(input.cwd, 'cwd');

  const existing = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
    | SessionRecord
    | undefined;

  if (existing) {
    db.prepare(
      `
      UPDATE sessions
      SET status = 'active',
          ended_at = NULL,
          agent_name = COALESCE(?, agent_name),
          cwd = COALESCE(?, cwd)
      WHERE id = ?
      `
    ).run(agentName, cwd, id);

    return getSession(id)!;
  }

  db.prepare(
    `
    INSERT INTO sessions (id, scope, project_id, agent_name, cwd, status)
    VALUES (?, ?, ?, ?, ?, 'active')
    `
  ).run(id, scoped.scope, scoped.projectId, agentName, cwd);

  return getSession(id)!;
}

/**
 * Build a deterministic arithmetic summary from observations for a session.
 * Never uses an LLM (Rule 1).
 */
function buildArithmeticSessionSummary(
  db: ReturnType<typeof getDb>,
  sessionId: string
): string {
  const stats = db
    .prepare(
      `
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN failed = 1 THEN 1 ELSE 0 END), 0) AS errors
      FROM observations
      WHERE session_id = ?
      `
    )
    .get(sessionId) as { total: number; errors: number };

  if (stats.total === 0) {
    return '0 observations recorded.';
  }

  const toolRows = db
    .prepare(
      `
      SELECT DISTINCT tool_name
      FROM observations
      WHERE session_id = ? AND tool_name IS NOT NULL AND tool_name != ''
      ORDER BY tool_name ASC
      `
    )
    .all(sessionId) as Array<{ tool_name: string }>;

  const fileRows = db
    .prepare(
      `
      SELECT DISTINCT file_path
      FROM observations
      WHERE session_id = ? AND file_path IS NOT NULL AND file_path != ''
      ORDER BY file_path ASC
      `
    )
    .all(sessionId) as Array<{ file_path: string }>;

  const parts = [`${stats.total} observations (${stats.errors} errors)`];
  if (toolRows.length > 0) {
    parts.push(`Tools: ${toolRows.map((r) => r.tool_name).join(', ')}`);
  }
  if (fileRows.length > 0) {
    parts.push(`Files: ${fileRows.map((r) => r.file_path).join(', ')}`);
  }

  return `${parts.join('. ')}.`;
}

/**
 * End a session, setting ended_at, status, files_touched_json, and an
 * arithmetic summary if none was provided.
 */
export function endSession(
  id: string,
  input: EndSessionInput = {}
): SessionRecord | undefined {
  const db = getDb();
  const existing = getSession(id);
  if (!existing) return undefined;

  const status: SessionStatus = input.status ?? 'completed';
  if (!VALID_SESSION_STATUSES.has(status)) {
    throw makeSchemaError(
      `Invalid session status '${String(status)}'. Must be 'active', 'paused', 'completed', or 'abandoned'`
    );
  }

  const filesTouched = input.filesTouched ?? input.files_touched;
  const filesTouchedJson = Array.isArray(filesTouched)
    ? JSON.stringify(filesTouched)
    : existing.files_touched_json;

  const providedSummary = optionalString(input.summary, 'summary');
  const summary = providedSummary ?? buildArithmeticSessionSummary(db, id);

  const rawHandoff =
    input.handoffSummaryId !== undefined
      ? input.handoffSummaryId
      : input.handoff_summary_id;
  const handoffSummaryId =
    optionalString(rawHandoff, 'handoff_summary_id') ?? existing.handoff_summary_id;

  db.prepare(
    `
    UPDATE sessions
    SET status = ?,
        ended_at = datetime('now'),
        summary = ?,
        files_touched_json = ?,
        handoff_summary_id = ?
    WHERE id = ?
    `
  ).run(status, summary, filesTouchedJson, handoffSummaryId, id);

  return getSession(id)!;
}

export function getSession(id: string): SessionRecord | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
    | SessionRecord
    | undefined;
}

export function listSessions(filters?: {
  projectId?: string;
  status?: string;
  agentName?: string;
  limit?: number;
}): SessionRecord[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (typeof filters?.projectId === 'string' && filters.projectId.trim()) {
    conditions.push('project_id = ?');
    params.push(filters.projectId.trim());
  }

  if (typeof filters?.status === 'string' && filters.status.trim()) {
    conditions.push('status = ?');
    params.push(filters.status.trim());
  }

  if (typeof filters?.agentName === 'string' && filters.agentName.trim()) {
    conditions.push('agent_name = ?');
    params.push(filters.agentName.trim());
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters?.limit ?? 50;
  params.push(limit);

  return db
    .prepare(
      `
      SELECT * FROM sessions
      ${whereClause}
      ORDER BY started_at DESC, rowid DESC
      LIMIT ?
      `
    )
    .all(...params) as SessionRecord[];
}

export function getSessionDetails(id: string): SessionDetails | undefined {
  const session = getSession(id);
  if (!session) return undefined;

  const db = getDb();
  const observations = db
    .prepare('SELECT * FROM observations WHERE session_id = ? ORDER BY created_at ASC')
    .all(id) as ObservationRecord[];

  const notes = db
    .prepare('SELECT * FROM notes WHERE session_id = ? ORDER BY created_at ASC')
    .all(id) as NoteRecord[];

  const actions = db
    .prepare('SELECT * FROM actions WHERE session_id = ? ORDER BY created_at ASC')
    .all(id) as ActionRecord[];

  return { session, observations, notes, actions };
}

function toIsoTimestamp(ts: number | string): string {
  if (typeof ts === 'number') {
    return new Date(ts * 1000).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)) {
    return new Date(`${ts.replace(' ', 'T')}Z`).toISOString();
  }
  const parsed = new Date(ts);
  return Number.isNaN(parsed.getTime()) ? ts : parsed.toISOString();
}

/**
 * Build a chronological replay timeline of observations, notes, and actions
 * associated with a session.
 */
export function getSessionReplay(id: string): SessionReplay | undefined {
  const details = getSessionDetails(id);
  if (!details) return undefined;

  const timeline: SessionReplayItem[] = [
    ...details.observations.map((obs): SessionReplayItem => ({
      kind: 'observation',
      timestamp: toIsoTimestamp(obs.created_at),
      id: obs.id,
      title: obs.tool_name ? `${obs.kind}: ${obs.tool_name}` : obs.kind,
      detail: obs.output ?? obs.input ?? null,
      meta: {
        obs_kind: obs.kind,
        tool_name: obs.tool_name,
        file_path: obs.file_path,
        duration_ms: obs.duration_ms,
        failed: obs.failed === 1,
      },
    })),
    ...details.notes.map((note): SessionReplayItem => ({
      kind: 'note',
      timestamp: toIsoTimestamp(note.created_at),
      id: note.id,
      title: note.title,
      detail: note.content,
      meta: {
        type: note.type,
        scope: note.scope,
        version: note.version,
      },
    })),
    ...details.actions.map((action): SessionReplayItem => ({
      kind: 'action',
      timestamp: toIsoTimestamp(action.created_at),
      id: action.id,
      title: action.title,
      detail: action.description,
      meta: {
        status: action.status,
        priority: action.priority,
        blocked_reason: action.blocked_reason,
      },
    })),
  ];

  timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    session: details.session,
    timeline,
  };
}

/**
 * Return the most recent ended session with a non-empty summary for a project
 * (or global if no projectId is given), or null if none exists.
 */
export function getLatestSessionSummary(projectId?: string): SessionRecord | null {
  const db = getDb();
  const cleanProject = typeof projectId === 'string' ? projectId.trim() || null : null;

  if (cleanProject) {
    const row = db
      .prepare(
        `
        SELECT * FROM sessions
        WHERE project_id = ? AND scope = 'project'
          AND ended_at IS NOT NULL
          AND summary IS NOT NULL AND summary != ''
        ORDER BY ended_at DESC, rowid DESC
        LIMIT 1
        `
      )
      .get(cleanProject) as SessionRecord | undefined;
    return row ?? null;
  }

  const row = db
    .prepare(
      `
      SELECT * FROM sessions
      WHERE scope = 'global'
        AND ended_at IS NOT NULL
        AND summary IS NOT NULL AND summary != ''
      ORDER BY ended_at DESC, rowid DESC
      LIMIT 1
      `
    )
    .get() as SessionRecord | undefined;
  return row ?? null;
}
