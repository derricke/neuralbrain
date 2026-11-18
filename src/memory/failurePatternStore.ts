import { randomUUID } from 'crypto';
import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { resolveScope } from '../lib/scope';
import { transaction } from '../lib/sqlite';

export type FailureScope = 'project' | 'global' | 'unknown';

/**
 * Sanitize error text to neutralize prompt injection, strip control characters,
 * normalize line breaks, and truncate to 500 characters.
 */
export function sanitizeErrorText(raw: unknown): string {
  if (raw === null || raw === undefined) return 'Unknown error';
  let text = String(raw);

  // 1. Normalize line breaks and tabs to single spaces
  text = text.replace(/[\r\n\t]+/g, ' ');

  // 2. Strip any remaining ASCII control characters (0x00-0x1F, 0x7F)
  text = text.replace(/[\x00-\x1F\x7F]/g, '');

  // 3. Neutralize prompt delimiter markers (e.g. [SYSTEM], <|...|>, <<SYS>>)
  text = text
    .replace(/<\|/g, '< |')
    .replace(/\|>/g, '| >')
    .replace(/\[\s*(system|assistant|user|inst|\/system|\/assistant|\/user|\/inst)\s*\]/gi, (match) => `(${match.slice(1, -1)})`)
    .replace(/<<\s*(sys|\/sys)\s*>>/gi, (match) => `(${match.slice(2, -2)})`);

  // 4. Collapse consecutive spaces and trim
  text = text.replace(/\s+/g, ' ').trim();

  // 5. Truncate to at most 500 characters
  if (text.length > 500) {
    text = text.slice(0, 500).trimEnd();
  }

  return text || 'Unknown error';
}

export interface FailurePattern {
  id: string;
  scope: FailureScope;
  project_id: string | null;
  session_id: string | null;
  task_type: string;
  error_text: string;
  count: number;
  first_seen_at: number;
  last_seen_at: number;
}

export function upsertFailurePattern(params: {
  scope: FailureScope;
  projectId?: string | null;
  sessionId?: string | null;
  session_id?: string | null;
  taskType?: string | null;
  errorText: string;
}): string {
  const { scope } = params;
  const taskType = params.taskType?.trim() || 'unknown';
  const cleanErrorText = sanitizeErrorText(params.errorText);
  const sessionId = (params.sessionId ?? params.session_id)?.trim() || null;

  // Normalised here too, or the UNIQUE(project_id, task_type, error_text) key
  // would split one project's failure counts across spellings of its name —
  // and the count is the whole value of this table.
  const scoped = resolveScope(scope, params.projectId ?? null);
  if (!scoped.ok) {
    const err = new Error(scoped.error);
    (err as any).code = 'SCHEMA_INVALID';
    logger.error({ scope, projectId: params.projectId }, err.message);
    throw err;
  }
  const projectId = scoped.projectId;

  const db = getDb();

  try {
    if (projectId !== null) {
      // For project-scoped rows, project_id is NOT NULL, so standard UNIQUE(project_id, task_type, error_text) applies
      const newId = randomUUID();
      const stmt = db.prepare(`
        INSERT INTO failure_patterns (id, scope, project_id, session_id, task_type, error_text, count, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, unixepoch(), unixepoch())
        ON CONFLICT(project_id, task_type, error_text) DO UPDATE SET
          count = failure_patterns.count + 1,
          session_id = COALESCE(excluded.session_id, failure_patterns.session_id),
          last_seen_at = unixepoch()
        RETURNING id
      `);

      const result = stmt.get(newId, scoped.scope, projectId, sessionId, taskType, cleanErrorText) as { id: string } | undefined;
      return result?.id ?? newId;
    } else {
      // For global or unknown scope, project_id IS NULL.
      // SQLite UNIQUE constraints treat NULL as distinct, so we use a transaction with check-and-update.
      const tx = transaction(db, () => {
        const existing = db
          .prepare(`
            SELECT id, count FROM failure_patterns
            WHERE scope = ? AND project_id IS NULL AND task_type = ? AND error_text = ?
            LIMIT 1
          `)
          .get(scoped.scope, taskType, cleanErrorText) as { id: string; count: number } | undefined;

        if (existing) {
          db.prepare(`
            UPDATE failure_patterns
            SET count = count + 1,
                session_id = COALESCE(?, session_id),
                last_seen_at = unixepoch()
            WHERE id = ?
          `).run(sessionId, existing.id);
          return existing.id;
        } else {
          const newId = randomUUID();
          db.prepare(`
            INSERT INTO failure_patterns (id, scope, project_id, session_id, task_type, error_text, count, first_seen_at, last_seen_at)
            VALUES (?, ?, NULL, ?, ?, ?, 1, unixepoch(), unixepoch())
          `).run(newId, scoped.scope, sessionId, taskType, cleanErrorText);
          return newId;
        }
      });

      return tx();
    }
  } catch (error) {
    logger.error(
      {
        scope,
        projectId,
        taskType,
        errorText: cleanErrorText,
        error: error instanceof Error ? error.message : String(error),
      },
      'failed to upsert failure pattern'
    );
    throw error;
  }
}

export function getFailurePatterns(params: {
  projectId?: string | null;
  taskType?: string | null;
  includeGlobal?: boolean;
  limit?: number;
}): FailurePattern[] {
  const db = getDb();
  const conditions: string[] = [];
  const queryParams: unknown[] = [];

  const projectId = params.projectId?.trim() || null;
  const includeGlobal = params.includeGlobal !== false;

  if (projectId) {
    if (includeGlobal) {
      conditions.push("((project_id = ? AND scope = 'project') OR scope = 'global')");
      queryParams.push(projectId);
    } else {
      conditions.push("(project_id = ? AND scope = 'project')");
      queryParams.push(projectId);
    }
  } else if (!projectId) {
    if (includeGlobal) {
      conditions.push("(scope = 'global')");
    } else {
      conditions.push("1 = 0");
    }
  }

  if (params.taskType) {
    conditions.push('task_type = ?');
    queryParams.push(params.taskType.trim());
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = params.limit ?? 50;
  queryParams.push(limit);

  try {
    return db
      .prepare(`
        SELECT id, scope, project_id, session_id, task_type, error_text, count, first_seen_at, last_seen_at
        FROM failure_patterns
        ${whereClause}
        ORDER BY count DESC, last_seen_at DESC
        LIMIT ?
      `)
      .all(...queryParams) as FailurePattern[];
  } catch (error) {
    logger.error(
      {
        params,
        error: error instanceof Error ? error.message : String(error),
      },
      'failed to query failure patterns'
    );
    throw error;
  }
}

export function formatCriticalWarnings(
  patterns: Array<{ task_type: string; error_text: string; count: number }>
): string {
  if (!patterns || patterns.length === 0) {
    return '';
  }

  const patternsText = patterns
    .map((p) => {
      const taskType = sanitizeErrorText(p.task_type || 'unknown');
      const errorText = sanitizeErrorText(p.error_text || 'Unknown error');
      const count = Number(p.count) || 1;
      return `- Previous failure when attempting task type '${taskType}': ${errorText} (occurred ${count} times)`;
    })
    .join('\n');

  return `CRITICAL WARNINGS (Learn from past failures in this project):\n${patternsText}`;
}
