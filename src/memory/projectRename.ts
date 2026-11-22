import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { getProjectAncestors, normalizeProjectId } from '../lib/scope';
import { getQdrantClient } from '../learning/embedWorker';
import { getStoreMeta } from '../learning/storeMeta';
import { transaction } from '../lib/sqlite';

export interface RenameProjectResult {
  from_project_id: string;
  to_project_id: string;
  updated_counts: Record<string, number>;
  total_updated: number;
  qdrant_updated: boolean;
  qdrant_error?: string;
}

const STANDARD_PROJECT_TABLES = [
  'notes',
  'trajectories',
  'trajectory_archive',
  'observations',
  'observations_archive',
  'sessions',
  'actions',
  'entities',
  'summaries',
  'consolidation_leases',
] as const;

/**
 * Atomically renames `project_id` across all SQLite tables (merging conflicting
 * failure_patterns counts) and updates matching Qdrant vector payloads if active.
 */
export async function renameProject(
  rawFromProjectId: string,
  rawToProjectId: string
): Promise<RenameProjectResult> {
  const fromNorm = normalizeProjectId(rawFromProjectId);
  if (!fromNorm.ok) {
    throw new Error(`Invalid from_project_id: ${fromNorm.error}`);
  }
  const toNorm = normalizeProjectId(rawToProjectId);
  if (!toNorm.ok) {
    throw new Error(`Invalid to_project_id: ${toNorm.error}`);
  }

  const fromId = fromNorm.projectId;
  const toId = toNorm.projectId;
  if (fromId === toId) {
    throw new Error('from_project_id and to_project_id must be different');
  }

  const db = getDb();
  const updatedCounts: Record<string, number> = {};

  const tx = transaction(db, () => {
    for (const table of STANDARD_PROJECT_TABLES) {
      const info = db
        .prepare(`UPDATE ${table} SET project_id = ? WHERE project_id = ?`)
        .run(toId, fromId);
      updatedCounts[table] = info.changes;
    }

    // failure_patterns has UNIQUE(project_id, task_type, error_text), so merge counts on conflict
    const fpRows = db
      .prepare(
        `SELECT id, scope, task_type, error_text, count, last_seen_at
         FROM failure_patterns
         WHERE project_id = ?`
      )
      .all(fromId) as Array<{
      id: string;
      scope: string;
      task_type: string;
      error_text: string;
      count: number;
      last_seen_at: number;
    }>;

    const findExistingFp = db.prepare(
      `SELECT id FROM failure_patterns
       WHERE project_id = ? AND task_type = ? AND error_text = ?`
    );
    const mergeExistingFp = db.prepare(
      `UPDATE failure_patterns
       SET count = count + ?, last_seen_at = MAX(last_seen_at, ?)
       WHERE id = ?`
    );
    const deleteFpById = db.prepare(`DELETE FROM failure_patterns WHERE id = ?`);
    const renameFpById = db.prepare(`UPDATE failure_patterns SET project_id = ? WHERE id = ?`);

    for (const row of fpRows) {
      const existing = findExistingFp.get(toId, row.task_type, row.error_text) as
        | { id: string }
        | undefined;
      if (existing) {
        mergeExistingFp.run(row.count, row.last_seen_at, existing.id);
        deleteFpById.run(row.id);
      } else {
        renameFpById.run(toId, row.id);
      }
    }

    updatedCounts.failure_patterns = fpRows.length;
  });

  tx();

  const totalUpdated = Object.values(updatedCounts).reduce((sum, n) => sum + n, 0);

  let qdrantUpdated = false;
  let qdrantError: string | undefined;

  const qdrant = getQdrantClient();
  if (qdrant) {
    const collection = getStoreMeta()?.qdrant_alias || 'brain';
    try {
      await qdrant.setPayload(collection, {
        payload: {
          project_id: toId,
          project_ancestors: getProjectAncestors(toId),
        },
        filter: {
          must: [{ key: 'project_id', match: { value: fromId } }],
        },
        wait: true,
      });
      qdrantUpdated = true;
    } catch (err: any) {
      qdrantError = err?.message || String(err);
      logger.warn(
        { collection, fromId, toId, error: qdrantError },
        'Qdrant setPayload failed during renameProject'
      );
    }
  }

  logger.info(
    { from_project_id: fromId, to_project_id: toId, total_updated: totalUpdated, qdrant_updated: qdrantUpdated },
    'project_id rename complete'
  );

  return {
    from_project_id: fromId,
    to_project_id: toId,
    updated_counts: updatedCounts,
    total_updated: totalUpdated,
    qdrant_updated: qdrantUpdated,
    ...(qdrantError ? { qdrant_error: qdrantError } : {}),
  };
}
