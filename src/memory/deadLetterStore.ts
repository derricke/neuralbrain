import { randomUUID } from 'crypto';
import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { redactSecrets } from '../lib/redactSecrets';

export type DeadLetterSource = 'capture' | 'summarize' | 'consolidate';
export type DeadLetterReason =
  | 'schema_invalid'
  | 'unparseable'
  | 'empty_content'
  | 'truncated'
  | 'citation_unresolved'
  | 'not_verbatim';

export interface DeadLetterRecord {
  id: string;
  source: DeadLetterSource;
  reason: DeadLetterReason;
  producer: string | null;
  payload: string;
  created_at: number;
}

export function recordDeadLetter(params: {
  source: DeadLetterSource;
  reason: DeadLetterReason;
  producer?: string | null;
  payload: unknown;
}): string {
  const db = getDb();
  const id = `dl_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const rawPayloadStr =
    typeof params.payload === 'string'
      ? params.payload
      : (JSON.stringify(params.payload) ?? 'null');
  const payloadStr = redactSecrets(rawPayloadStr);

  try {
    db.prepare(`
      INSERT INTO dead_letters (id, source, reason, producer, payload, created_at)
      VALUES (?, ?, ?, ?, ?, unixepoch())
    `).run(id, params.source, params.reason, params.producer ?? null, payloadStr);

    logger.warn(
      {
        id,
        source: params.source,
        reason: params.reason,
        producer: params.producer,
      },
      'dead letter recorded'
    );

    return id;
  } catch (error) {
    logger.error(
      {
        id,
        error: error instanceof Error ? error.message : String(error),
      },
      'failed to record dead letter'
    );
    throw error;
  }
}

export function listDeadLetters(filters?: {
  source?: string;
  reason?: string;
  producer?: string;
  limit?: number;
  offset?: number;
}): DeadLetterRecord[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.source) {
    conditions.push('source = ?');
    params.push(filters.source);
  }
  if (filters?.reason) {
    conditions.push('reason = ?');
    params.push(filters.reason);
  }
  if (filters?.producer) {
    conditions.push('producer = ?');
    params.push(filters.producer);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;
  params.push(limit, offset);

  return db
    .prepare(
      `SELECT id, source, reason, producer, payload, created_at
       FROM dead_letters
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params) as DeadLetterRecord[];
}

export function getDeadLetterStats(): {
  total: number;
  byReason: Record<string, number>;
  byProducer: Record<string, number>;
  bySource: Record<string, number>;
} {
  const db = getDb();

  const totalRow = db.prepare('SELECT COUNT(*) as count FROM dead_letters').get() as { count: number };
  const total = totalRow?.count ?? 0;

  const reasonRows = db
    .prepare('SELECT reason, COUNT(*) as count FROM dead_letters GROUP BY reason')
    .all() as Array<{ reason: string; count: number }>;
  const byReason: Record<string, number> = {};
  for (const row of reasonRows) {
    byReason[row.reason] = row.count;
  }

  const producerRows = db
    .prepare('SELECT COALESCE(producer, "unknown") as producer, COUNT(*) as count FROM dead_letters GROUP BY producer')
    .all() as Array<{ producer: string; count: number }>;
  const byProducer: Record<string, number> = {};
  for (const row of producerRows) {
    byProducer[row.producer] = row.count;
  }

  const sourceRows = db
    .prepare('SELECT source, COUNT(*) as count FROM dead_letters GROUP BY source')
    .all() as Array<{ source: string; count: number }>;
  const bySource: Record<string, number> = {};
  for (const row of sourceRows) {
    bySource[row.source] = row.count;
  }

  return { total, byReason, byProducer, bySource };
}
