import { randomUUID } from 'crypto';
import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { enqueueForEmbedding } from './embedQueueStore';
import { recordDeadLetter } from './deadLetterStore';
import { resolveScope } from '../lib/scope';
import { redactOptional } from '../lib/redactSecrets';
import { transaction } from '../lib/sqlite';

export type ObservationScope = 'project' | 'global' | 'unknown';
export type ObservationKind = 'tool_call' | 'prompt';

export interface ObservationRecord {
  id: string;
  scope: ObservationScope;
  project_id: string | null;
  note_ref: string | null;
  task_ref: string | null;
  session_id: string | null;
  agent: string | null;
  kind: ObservationKind;
  tool_name: string | null;
  file_path: string | null;
  input: string | null;
  output: string | null;
  duration_ms: number;
  failed: number;
  created_at: number;
  archived_at: number | null;
}

export interface CaptureResult {
  accepted: number;
  ids: string[];
  rejected: Array<{
    index: number;
    reason: string;
    error: string;
  }>;
}

interface ValidatedObservation {
  id: string;
  scope: ObservationScope;
  projectId: string | null;
  noteRef: string | null;
  taskRef: string | null;
  sessionId: string | null;
  agent: string | null;
  kind: ObservationKind;
  toolName: string | null;
  filePath: string | null;
  input: string | null;
  output: string | null;
  durationMs: number;
  failed: number;
  createdAt: number;
}

function validateObservationItem(item: unknown, index: number): { valid: true; item: ValidatedObservation } | { valid: false; error: string } {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { valid: false, error: 'Observation item must be a non-null object' };
  }

  const raw = item as Record<string, unknown>;

  // Scope defaults to 'unknown' (NEVER 'global'); project_id is normalised so
  // that two spellings of one name converge. See src/lib/scope.ts.
  const scoped = resolveScope(raw.scope, raw.project_id ?? raw.projectId);
  if (!scoped.ok) {
    return { valid: false, error: scoped.error };
  }
  const scope: ObservationScope = scoped.scope;
  const projectId: string | null = scoped.projectId;

  // kind must be 'tool_call' or 'prompt'
  if (raw.kind !== 'tool_call' && raw.kind !== 'prompt') {
    return { valid: false, error: `Invalid kind '${String(raw.kind)}'. Must be 'tool_call' or 'prompt'` };
  }
  const kind = raw.kind as ObservationKind;

  // failed: comes from client (0 or 1, or boolean converted to 0 or 1), never inferred
  let failed = 0;
  if (typeof raw.failed === 'boolean') {
    failed = raw.failed ? 1 : 0;
  } else if (raw.failed === 1 || raw.failed === '1') {
    failed = 1;
  } else if (raw.failed === 0 || raw.failed === '0' || raw.failed === undefined || raw.failed === null) {
    failed = 0;
  } else {
    return { valid: false, error: `Invalid failed value '${String(raw.failed)}'. Must be 0, 1, or boolean` };
  }

  // duration_ms: non-negative integer
  let durationMs = 0;
  const rawDuration = raw.duration_ms ?? raw.durationMs;
  if (rawDuration !== undefined && rawDuration !== null) {
    const num = Number(rawDuration);
    if (!Number.isFinite(num) || num < 0) {
      return { valid: false, error: `duration_ms must be a non-negative number` };
    }
    durationMs = Math.round(num);
  }

  // id: client-provided or generate
  const id = typeof raw.id === 'string' && raw.id.trim() !== ''
    ? raw.id.trim()
    : `obs_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  const toCleanString = (val: unknown): string | null =>
    typeof val === 'string' && val.trim() !== '' ? val.trim() : null;

  // Optional string fields
  const noteRef = toCleanString(raw.note_ref ?? raw.noteRef);
  const taskRef = toCleanString(raw.task_ref ?? raw.taskRef);
  const sessionId = toCleanString(raw.session_id ?? raw.sessionId);
  const agent = toCleanString(raw.agent);
  const toolName = toCleanString(raw.tool_name ?? raw.toolName);
  const filePath = toCleanString(raw.file_path ?? raw.filePath);

  // input / output stored whole (no truncation!), with known secret patterns redacted
  const input = raw.input !== undefined && raw.input !== null ? redactOptional(String(raw.input)) : null;
  const output = raw.output !== undefined && raw.output !== null ? redactOptional(String(raw.output)) : null;

  const rawCreatedAt = raw.created_at ?? raw.createdAt;
  const createdAt = typeof rawCreatedAt === 'number' && Number.isFinite(rawCreatedAt)
    ? Math.floor(rawCreatedAt)
    : Math.floor(Date.now() / 1000);

  return {
    valid: true,
    item: {
      id,
      scope,
      projectId,
      noteRef,
      taskRef,
      sessionId,
      agent,
      kind,
      toolName,
      filePath,
      input,
      output,
      durationMs,
      failed,
      createdAt,
    },
  };
}

export function captureObservations(rawItems: unknown[]): CaptureResult {
  if (!Array.isArray(rawItems)) {
    throw new Error('captureObservations expects an array of observation items');
  }

  const validItems: Array<{ item: ValidatedObservation; index: number; raw: unknown }> = [];
  const rejected: Array<{ index: number; reason: string; error: string }> = [];

  rawItems.forEach((rawItem, index) => {
    const res = validateObservationItem(rawItem, index);
    if (res.valid) {
      validItems.push({ item: res.item, index, raw: rawItem });
    } else {
      recordDeadLetter({
        source: 'capture',
        reason: 'schema_invalid',
        producer: (rawItem as any)?.agent ?? null,
        payload: rawItem,
      });
      rejected.push({
        index,
        reason: 'schema_invalid',
        error: res.error,
      });
    }
  });

  const ids: string[] = [];
  if (validItems.length > 0) {
    const db = getDb();
    const insertStmt = db.prepare(`
      INSERT INTO observations (
        id, scope, project_id, note_ref, task_ref, session_id, agent,
        kind, tool_name, file_path, input, output, duration_ms, failed,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const reactivateSessionStmt = db.prepare(`
      UPDATE sessions
      SET status = 'active',
          ended_at = NULL
      WHERE id = ? AND status != 'active'
    `);

    // Nested transaction() calls run as SAVEPOINTs (src/lib/sqlite.ts).
    // If insertSingle throws, its savepoint is rolled back without aborting the outer transaction.
    const insertSingle = transaction(db, (entry: { item: ValidatedObservation; index: number; raw: unknown }) => {
      const item = entry.item;
      insertStmt.run(
        item.id,
        item.scope,
        item.projectId,
        item.noteRef,
        item.taskRef,
        item.sessionId,
        item.agent,
        item.kind,
        item.toolName,
        item.filePath,
        item.input,
        item.output,
        item.durationMs,
        item.failed,
        item.createdAt
      );
      if (item.sessionId) {
        reactivateSessionStmt.run(item.sessionId);
      }
      enqueueForEmbedding(item.id, 'observation');
    });

    const batchTx = transaction(db, () => {
      for (const entry of validItems) {
        try {
          insertSingle(entry);
          ids.push(entry.item.id);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          recordDeadLetter({
            source: 'capture',
            reason: 'schema_invalid',
            producer: entry.item.agent ?? null,
            payload: entry.raw,
          });
          rejected.push({
            index: entry.index,
            reason: 'schema_invalid',
            error: errMsg,
          });
        }
      }
    });

    batchTx();
  }

  return {
    accepted: ids.length,
    ids,
    rejected,
  };
}

export function getObservation(id: string): ObservationRecord | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM observations WHERE id = ?').get(id) as ObservationRecord | undefined;
}

export function listObservations(filters?: {
  projectId?: string;
  scope?: string;
  sessionId?: string;
  failed?: number;
  limit?: number;
  offset?: number;
}): ObservationRecord[] {
  const db = getDb();
  const conditions: string[] = [];
  const queryParams: unknown[] = [];

  if (filters?.projectId) {
    conditions.push('project_id = ?');
    queryParams.push(filters.projectId);
  }
  if (filters?.scope) {
    conditions.push('scope = ?');
    queryParams.push(filters.scope);
  }
  if (filters?.sessionId) {
    conditions.push('session_id = ?');
    queryParams.push(filters.sessionId);
  }
  if (filters?.failed !== undefined) {
    conditions.push('failed = ?');
    queryParams.push(filters.failed ? 1 : 0);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;
  queryParams.push(limit, offset);

  return db
    .prepare(`
      SELECT * FROM observations
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(...queryParams) as ObservationRecord[];
}
