import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { Database, Statement, transaction } from '../lib/sqlite';

export type EmbedGrain = 'observation' | 'trajectory' | 'note' | 'summary';
export type EmbedStatus = 'pending' | 'running' | 'done' | 'failed';

export interface EmbedQueueItem {
  record_id: string;
  grain: EmbedGrain;
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
      INSERT INTO embed_queue (record_id, grain, status, attempts, last_error, target, queued_at)
      VALUES (?, ?, 'pending', 0, NULL, ?, unixepoch())
      ON CONFLICT(record_id, grain, target) DO UPDATE SET
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
  grain: EmbedGrain,
  target = 'live'
): void {
  const db = getDb();
  try {
    getEnqueueStatement(db).run(recordId, grain, target);
  } catch (error) {
    logger.error(
      { recordId, grain, target, error: error instanceof Error ? error.message : String(error) },
      'failed to enqueue record for embedding'
    );
    throw error;
  }
}

export function batchEnqueueForEmbedding(
  ids: string[],
  grain: EmbedGrain,
  targetCollection = 'live'
): void {
  if (!ids || ids.length === 0) return;
  const db = getDb();
  const stmt = getEnqueueStatement(db);
  const tx = transaction(db, () => {
    for (const id of ids) {
      stmt.run(id, grain, targetCollection);
    }
  });
  try {
    tx();
  } catch (error) {
    logger.error(
      {
        count: ids.length,
        grain,
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
        SELECT record_id, grain, status, attempts, last_error, target, queued_at
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
      SET status = 'running', attempts = attempts + 1
      WHERE record_id = ? AND grain = ? AND target = ?
    `);

    for (const row of rows) {
      updateStmt.run(row.record_id, row.grain, row.target);
      row.status = 'running';
      row.attempts += 1;
    }

    return rows;
  });

  return tx();
}

export function markEmbedDone(recordId: string, grain: EmbedGrain, target = 'live'): void {
  const db = getDb();
  db.prepare(`
    UPDATE embed_queue
    SET status = 'done', last_error = NULL
    WHERE record_id = ? AND grain = ? AND target = ?
  `).run(recordId, grain, target);
}

/**
 * Remove every queue entry for a record, across all targets.
 *
 * Only for a record the service has deleted: leaving the entry behind means
 * the worker keeps claiming a row that no longer exists.
 */
export function dequeueRecord(recordId: string, grain: EmbedGrain): number {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM embed_queue WHERE record_id = ? AND grain = ?')
    .run(recordId, grain);
  return result.changes;
}

/**
 * Returns a claimed ('running') item to 'pending' without counting it as a
 * failure. Used when embedding cannot run at all (the embedder is not
 * installed or not configured): that is a dependency outage, not a bad record,
 * so the record waits for the embedder instead of being marked failed (rule 3).
 */
export function releaseEmbedClaim(recordId: string, grain: EmbedGrain, target = 'live', reason?: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE embed_queue
    SET status = 'pending', last_error = ?
    WHERE record_id = ? AND grain = ? AND target = ? AND status = 'running'
  `).run(reason ?? null, recordId, grain, target);
}

export function markEmbedFailed(
  recordId: string,
  grain: EmbedGrain,
  target = 'live',
  error?: string
): void {
  const db = getDb();
  db.prepare(`
    UPDATE embed_queue
    SET status = 'failed', last_error = ?
    WHERE record_id = ? AND grain = ? AND target = ?
  `).run(error ?? 'Unknown embedding error', recordId, grain, target);
}
