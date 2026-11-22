import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { Database, Statement, transaction } from '../lib/sqlite';

export type EmbedRecordType =
  | 'observation'
  | 'trajectory'
  | 'note'
  | 'summary'
  | 'entity'
  | 'action';
export type EmbedGrain = EmbedRecordType;
export type EmbedStatus = 'pending' | 'running' | 'done' | 'failed';
export const MAX_EMBED_ATTEMPTS = 3;

export interface EmbedQueueItem {
  record_id: string;
  record_type: EmbedRecordType;
  status: EmbedStatus;
  attempts: number;
  last_error: string | null;
  target: string;
  queued_at: number;
}

const insertStmtCache = new WeakMap<Database, Statement>();

function getEnqueueStatement(db: Database): Statement {
  let stmt = insertStmtCache.get(db);
  if (!stmt) {
    stmt = db.prepare(`
      INSERT INTO embed_queue (record_id, record_type, status, attempts, last_error, target, queued_at)
      VALUES (?, ?, 'pending', 0, NULL, ?, unixepoch())
      ON CONFLICT(record_id, record_type, target) DO UPDATE SET
        status = 'pending',
        attempts = 0,
        last_error = NULL,
        queued_at = unixepoch()
    `);
    insertStmtCache.set(db, stmt);
  }
  return stmt;
}

export function enqueueForEmbedding(
  recordId: string,
  recordType: EmbedRecordType,
  target = 'live'
): void {
  const db = getDb();
  try {
    getEnqueueStatement(db).run(recordId, recordType, target);
  } catch (error) {
    logger.error(
      { recordId, record_type: recordType, target, error: error instanceof Error ? error.message : String(error) },
      'failed to enqueue record for embedding'
    );
    throw error;
  }
}

export function batchEnqueueForEmbedding(
  ids: string[],
  recordType: EmbedRecordType,
  targetCollection = 'live'
): void {
  if (!ids || ids.length === 0) return;
  const db = getDb();
  const stmt = getEnqueueStatement(db);
  const tx = transaction(db, () => {
    for (const id of ids) {
      stmt.run(id, recordType, targetCollection);
    }
  });
  try {
    tx();
  } catch (error) {
    logger.error(
      {
        count: ids.length,
        record_type: recordType,
        target: targetCollection,
        error: error instanceof Error ? error.message : String(error),
      },
      'failed to batch enqueue records for embedding'
    );
    throw error;
  }
}

export function getPendingEmbedCount(target = 'live'): number {
  const db = getDb();
  const row = db
    .prepare('SELECT COUNT(*) as count FROM embed_queue WHERE target = ? AND status = ?')
    .get(target, 'pending') as { count: number } | undefined;
  return row?.count ?? 0;
}

export function claimEmbedQueue(target = 'live', limit = 32): EmbedQueueItem[] {
  const db = getDb();
  const tx = transaction(db, () => {
    const rows = db
      .prepare(`
        SELECT record_id, record_type, status, attempts, last_error, target, queued_at
        FROM embed_queue
        WHERE target = ? AND status = 'pending'
        ORDER BY queued_at ASC
        LIMIT ?
      `)
      .all(target, limit) as EmbedQueueItem[];

    if (rows.length === 0) {
      return [];
    }

    const updateStmt = db.prepare(`
      UPDATE embed_queue
      SET status = 'running', attempts = attempts + 1, queued_at = unixepoch()
      WHERE record_id = ? AND record_type = ? AND target = ?
    `);

    for (const row of rows) {
      updateStmt.run(row.record_id, row.record_type, row.target);
      row.status = 'running';
      row.attempts += 1;
    }

    return rows;
  });

  return tx();
}

export function markEmbedDone(recordId: string, recordType: EmbedRecordType, target = 'live'): void {
  const db = getDb();
  db.prepare(`
    UPDATE embed_queue
    SET status = 'done', last_error = NULL
    WHERE record_id = ? AND record_type = ? AND target = ?
  `).run(recordId, recordType, target);
}

/**
 * Remove every queue entry for a record, across all targets.
 *
 * Only for a record the service has deleted: leaving the entry behind means
 * the worker keeps claiming a row that no longer exists.
 */
export function dequeueRecord(recordId: string, recordType: EmbedRecordType): number {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM embed_queue WHERE record_id = ? AND record_type = ?')
    .run(recordId, recordType);
  return result.changes;
}

/**
 * Returns a claimed ('running') item to 'pending' without counting it as a
 * failure. Used when embedding cannot run at all (the embedder is not
 * installed or not configured): that is a dependency outage, not a bad record,
 * so the record waits for the embedder instead of being marked failed (rule 3).
 */
export function releaseEmbedClaim(recordId: string, recordType: EmbedRecordType, target = 'live', reason?: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE embed_queue
    SET status = 'pending', last_error = ?
    WHERE record_id = ? AND record_type = ? AND target = ? AND status = 'running'
  `).run(reason ?? null, recordId, recordType, target);
}

/**
 * Recovers items stuck in 'running' state (e.g., after a worker crash or lease timeout)
 * by resetting them back to 'pending' so they can be re-claimed.
 */
export function recoverStaleRunningEmbeds(target = 'live', staleAfterSec = 300): number {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(0, staleAfterSec);
  const result = db
    .prepare(`
      UPDATE embed_queue
      SET status = 'pending',
          last_error = COALESCE(last_error, 'recovered stale running item')
      WHERE target = ? AND status = 'running' AND queued_at <= ?
    `)
    .run(target, cutoff);
  return result.changes;
}

/**
 * Deletes all queue entries for a specific target (used to clean up failed reembed targets).
 */
export function clearEmbedQueueTarget(target: string): number {
  const db = getDb();
  const result = db.prepare('DELETE FROM embed_queue WHERE target = ?').run(target);
  return result.changes;
}

export function markEmbedFailed(
  recordId: string,
  recordType: EmbedRecordType,
  target = 'live',
  error?: string
): void {
  const db = getDb();
  db.prepare(`
    UPDATE embed_queue
    SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
        last_error = ?
    WHERE record_id = ? AND record_type = ? AND target = ?
  `).run(MAX_EMBED_ATTEMPTS, error ?? 'Unknown embedding error', recordId, recordType, target);
}
