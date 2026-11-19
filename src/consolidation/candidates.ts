import { randomUUID } from 'crypto';
import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import type { ObservationRecord } from '../memory/observationStore';
import { transaction } from '../lib/sqlite';

export interface ConsolidationCandidate {
  lease_id: string;
  kind: string;
  scope: string;
  project_id: string | null;
  session_id: string;
  observation_ids: string[];
  observations: ObservationRecord[];
  expires_at: number;
}

const MAX_OBSERVATIONS_PER_LEASE = 200;

export function getConsolidationCandidates(params?: {
  projectId?: string;
  limit?: number;
  leaseDurationSec?: number;
}): { candidates: ConsolidationCandidate[] } {
  const db = getDb();
  const limit = Math.max(params?.limit ?? 5, 1);
  const leaseDurationSec = Math.max(params?.leaseDurationSec ?? 300, 30);
  const now = Math.floor(Date.now() / 1000);

  return transaction(db, () => {
    // Find candidate sessions
    let query = `
      SELECT session_id, scope, project_id, COUNT(*) as obs_count, MIN(created_at) as first_seen
      FROM observations o
      WHERE session_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM consolidation_leases cl
          WHERE cl.session_id = o.session_id
            AND cl.completed_at IS NULL
            AND cl.expires_at > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM summary_sources ss
          JOIN summaries s ON ss.summary_id = s.id
          WHERE ss.record_id = o.id AND s.verified = 1
        )
    `;
    const queryParams: unknown[] = [now];

    if (params?.projectId) {
      query += ` AND project_id = ?`;
      queryParams.push(params.projectId.trim());
    }

    query += `
      GROUP BY session_id, scope, project_id
      ORDER BY first_seen ASC
      LIMIT ?
    `;
    queryParams.push(limit);

    const candidateSessions = db.prepare(query).all(...queryParams) as Array<{
      session_id: string;
      scope: string;
      project_id: string | null;
      obs_count: number;
    }>;

    const candidates: ConsolidationCandidate[] = [];

    for (const sess of candidateSessions) {
      const projectClause =
        sess.project_id === null ? 'o.project_id IS NULL' : 'o.project_id = ?';
      const obsParams: unknown[] = [sess.session_id, sess.scope];
      if (sess.project_id !== null) {
        obsParams.push(sess.project_id);
      }
      obsParams.push(MAX_OBSERVATIONS_PER_LEASE);

      const obsRows = db
        .prepare(`
          SELECT o.* FROM observations o
          WHERE o.session_id = ?
            AND o.scope = ?
            AND ${projectClause}
            AND NOT EXISTS (
              SELECT 1 FROM summary_sources ss
              JOIN summaries s ON ss.summary_id = s.id
              WHERE ss.record_id = o.id AND s.verified = 1
            )
          ORDER BY o.created_at ASC, o.id ASC
          LIMIT ?
        `)
        .all(...obsParams) as ObservationRecord[];

      if (obsRows.length === 0) continue;

      const leaseId = `l-${randomUUID()}`;
      const obsIds = obsRows.map((o) => o.id);
      const expiresAt = now + leaseDurationSec;

      try {
        db.prepare(`
          INSERT INTO consolidation_leases (
            lease_id, kind, scope, project_id, session_id, observation_ids, created_at, expires_at, completed_at
          ) VALUES (?, 'session', ?, ?, ?, ?, ?, ?, NULL)
        `).run(
          leaseId,
          sess.scope,
          sess.project_id,
          sess.session_id,
          JSON.stringify(obsIds),
          now,
          expiresAt
        );

        candidates.push({
          lease_id: leaseId,
          kind: 'session',
          scope: sess.scope,
          project_id: sess.project_id,
          session_id: sess.session_id,
          observation_ids: obsIds,
          observations: obsRows,
          expires_at: expiresAt,
        });
      } catch (err) {
        logger.error(
          { leaseId, sessionId: sess.session_id, error: err instanceof Error ? err.message : String(err) },
          'failed to create consolidation lease'
        );
      }
    }

    return { candidates };
  })();
}

export interface ConsolidationStatus {
  unconsolidated_sessions: number;
  unconsolidated_observations: number;
  oldest_unconsolidated_at: number | null;
  last_consolidated_at: number | null;
}

const CONSOLIDATION_SESSION_THRESHOLD = 3;
const CONSOLIDATION_OBS_THRESHOLD = 50;
const CONSOLIDATION_STALE_SECONDS = 3 * 86400;

/**
 * Computes un-consolidated observation/session counts and last verified summary timestamp.
 */
export function getConsolidationStatus(projectId?: string): ConsolidationStatus {
  const db = getDb();
  const trimmedProject = projectId?.trim() || undefined;

  let obsSql = `
    SELECT COUNT(DISTINCT o.session_id) AS session_count,
           COUNT(*) AS obs_count,
           MIN(o.created_at) AS oldest_at
    FROM observations o
    WHERE o.session_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM summary_sources ss
        JOIN summaries s ON ss.summary_id = s.id
        WHERE ss.record_id = o.id AND s.verified = 1
      )
  `;
  const obsParams: unknown[] = [];
  if (trimmedProject) {
    obsSql += ` AND o.project_id = ?`;
    obsParams.push(trimmedProject);
  }

  const obsRow = db.prepare(obsSql).get(...obsParams) as {
    session_count: number;
    obs_count: number;
    oldest_at: number | null;
  };

  let sumSql = `SELECT MAX(created_at) AS last_at FROM summaries WHERE verified = 1`;
  const sumParams: unknown[] = [];
  if (trimmedProject) {
    sumSql += ` AND project_id = ?`;
    sumParams.push(trimmedProject);
  }

  const sumRow = db.prepare(sumSql).get(...sumParams) as { last_at: number | null };

  return {
    unconsolidated_sessions: obsRow?.session_count ?? 0,
    unconsolidated_observations: obsRow?.obs_count ?? 0,
    oldest_unconsolidated_at: obsRow?.oldest_at ?? null,
    last_consolidated_at: sumRow?.last_at ?? null,
  };
}

/**
 * Returns a SessionStart /inject reminder when un-consolidated observations have
 * accumulated or gone stale, or null if consolidation is up to date.
 */
export function formatConsolidationWarning(
  status: ConsolidationStatus,
  projectId?: string,
  nowSec?: number
): string | null {
  const { unconsolidated_sessions, unconsolidated_observations, oldest_unconsolidated_at, last_consolidated_at } =
    status;
  if (unconsolidated_sessions <= 0 || unconsolidated_observations <= 0) {
    return null;
  }

  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const isStale =
    oldest_unconsolidated_at !== null && now - oldest_unconsolidated_at >= CONSOLIDATION_STALE_SECONDS;

  if (
    unconsolidated_sessions < CONSOLIDATION_SESSION_THRESHOLD &&
    unconsolidated_observations < CONSOLIDATION_OBS_THRESHOLD &&
    !isStale
  ) {
    return null;
  }

  const target = projectId?.trim() ? `project '${projectId.trim()}'` : 'this workspace';
  let lastDesc = 'never';
  if (last_consolidated_at !== null) {
    const daysAgo = Math.max(0, Math.floor((now - last_consolidated_at) / 86400));
    lastDesc = daysAgo === 0 ? 'earlier today' : `${daysAgo}d ago`;
  }

  return (
    `CONSOLIDATION REMINDER: ${unconsolidated_sessions} un-consolidated session(s) ` +
    `(${unconsolidated_observations} observations) for ${target} (last consolidated: ${lastDesc}). ` +
    `Let the user know and suggest they start a new session with an example prompt such as: "Consolidate the brain observations for this project."`
  );
}
