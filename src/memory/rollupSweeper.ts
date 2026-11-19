/**
 * The idle-session rollup sweeper.
 *
 * A trajectory is normally produced when a client finishes a task and posts
 * the observation ids it wants rolled up. A client that crashes, is killed, or
 * simply never reaches that call sends no such signal — and its observations
 * then sit in the store until the 90-day delete without ever becoming a
 * trajectory. They were captured and then wasted: never part of a failure
 * pattern, never part of a prior outcome, never injected at task start. The
 * write was accepted and then thrown away, which is the failure class this
 * project exists to remove.
 *
 * This is the safety net alongside that explicit path, not a replacement for
 * it. Three properties matter:
 *
 *  1. **Arithmetic only** (rule 1). Counts, sums, a first prompt and a mode.
 *     No model is called here, directly or indirectly.
 *  2. **It never invents an outcome.** A swept rollup's `success` is NULL —
 *     unknown — unless a source observation records a failure (0) or records
 *     completion (1). See `deriveSuccess` in trajectoryStore.
 *  3. **Idempotent.** The candidate query selects sessions with no trajectory,
 *     so a second run finds nothing to do.
 */
import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { resolveScope } from '../lib/scope';
import { transaction } from '../lib/sqlite';
import { logTrajectory } from './trajectoryStore';
import { endSession } from './sessionStore';

export const DEFAULT_IDLE_MINUTES = 30;

export interface SweepOptions {
  /** A session is idle when its newest observation is older than this. */
  idleMinutes?: number;
  /** Cap on sessions rolled up in one pass. */
  limit?: number;
  /** Test seam: treat this unix timestamp as "now". */
  now?: number;
}

export interface SweptSession {
  session_id: string;
  trajectory_id: string;
  observation_count: number;
  tool_calls: number;
  duration_ms: number;
  scope: string;
  project_id: string | null;
  success: 0 | 1 | null;
}

export interface SweepResult {
  idle_minutes: number;
  cutoff: number;
  candidates: number;
  swept: number;
  skipped: number;
  sessions: SweptSession[];
}

interface CandidateRow {
  session_id: string;
  last_seen: number;
  obs_count: number;
}

interface SourceRow {
  id: string;
  scope: string;
  project_id: string | null;
  agent: string | null;
  kind: string;
  tool_name: string | null;
  input: string | null;
  output: string | null;
  duration_ms: number;
  failed: number;
  created_at: number;
}

export function resolveIdleMinutes(override?: number): number {
  if (override !== undefined && Number.isFinite(override) && override >= 0) {
    return Math.floor(override);
  }
  const configured = parseInt(process.env.BRAIN_ROLLUP_IDLE_MINUTES || '', 10);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return DEFAULT_IDLE_MINUTES;
}

/** The most frequent value in `values`, counting null as its own value. */
function modeOf<T extends string | null>(values: T[]): T | undefined {
  const counts = new Map<string, { value: T; count: number }>();
  for (const value of values) {
    const key = value === null ? '\u0000null' : `v:${value}`;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { value, count: 1 });
  }
  let best: { value: T; count: number } | undefined;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return best?.value;
}

/**
 * Roll up every idle session that has no trajectory yet.
 *
 * Safe to call repeatedly and from an interval: the second pass sees the
 * trajectories the first one wrote and selects nothing.
 */
export function sweepIdleSessions(options?: SweepOptions): SweepResult {
  const db = getDb();
  const idleMinutes = resolveIdleMinutes(options?.idleMinutes);
  const now = options?.now ?? Math.floor(Date.now() / 1000);
  const cutoff = now - idleMinutes * 60;
  const limit = Math.max(1, Math.floor(options?.limit ?? 200));

  // Candidate sessions: idle, and not already rolled up. The NOT EXISTS is
  // what makes this re-runnable — it covers both the signalled rollups a
  // client posted and the swept ones an earlier pass wrote.
  // Inspects both observations and observations_archive so sessions unrolled
  // past 30 days can still be swept.
  const candidates = db
    .prepare(
      `
      WITH all_obs AS (
        SELECT session_id, created_at FROM observations WHERE session_id IS NOT NULL
        UNION ALL
        SELECT session_id, created_at FROM observations_archive WHERE session_id IS NOT NULL
      )
      SELECT o.session_id AS session_id,
             MAX(o.created_at) AS last_seen,
             COUNT(*) AS obs_count
      FROM all_obs o
      WHERE NOT EXISTS (
          SELECT 1 FROM trajectories t WHERE t.session_id = o.session_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM trajectory_archive ta WHERE ta.session_id = o.session_id
        )
      GROUP BY o.session_id
      HAVING MAX(o.created_at) <= ?
      ORDER BY last_seen ASC
      LIMIT ?
    `
    )
    .all(cutoff, limit) as CandidateRow[];

  const sessions: SweptSession[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    const rows = db
      .prepare(
        `
        SELECT id, scope, project_id, agent, kind, tool_name, input, output,
               duration_ms, failed, created_at
        FROM (
          SELECT id, scope, project_id, agent, kind, tool_name,
                 SUBSTR(input, 1, 1000) AS input,
                 CASE WHEN failed = 1 THEN SUBSTR(output, 1, 1000) ELSE NULL END AS output,
                 duration_ms, failed, created_at
          FROM observations
          WHERE session_id = ?
          UNION ALL
          SELECT original_observation_id AS id, scope, project_id, agent, kind, tool_name,
                 SUBSTR(input, 1, 1000) AS input,
                 CASE WHEN failed = 1 THEN SUBSTR(output, 1, 1000) ELSE NULL END AS output,
                 duration_ms, failed, created_at
          FROM observations_archive
          WHERE session_id = ?
        )
        ORDER BY created_at ASC, id ASC
      `
      )
      .all(candidate.session_id, candidate.session_id) as SourceRow[];

    if (rows.length === 0) {
      skipped++;
      continue;
    }

    // Scope and project_id are carried from the sources, never invented. When
    // the sources disagree the most common pair wins; the pair is kept
    // together because scope and project_id are only valid as a pair, and it
    // is validated through the shared helper rather than trusted.
    const scopeMode = modeOf(rows.map((r) => r.scope)) ?? 'unknown';
    const projectMode =
      modeOf(rows.filter((r) => r.scope === scopeMode).map((r) => r.project_id)) ?? null;

    const scoped = resolveScope(scopeMode, scopeMode === 'project' ? projectMode : null);
    if (!scoped.ok) {
      // Only reachable if a stored row's scope pair is already invalid. Say so
      // rather than guessing a scope for it.
      logger.error(
        { sessionId: candidate.session_id, scope: scopeMode, projectId: projectMode, error: scoped.error },
        'rollup sweep: refusing to roll up a session whose observations have an invalid scope'
      );
      skipped++;
      continue;
    }

    const durationMs = rows.reduce((sum, r) => sum + (r.duration_ms || 0), 0);
    const toolCalls = rows.filter((r) => r.kind === 'tool_call').length;

    let trajectoryId: string | null = null;
    try {
      trajectoryId = transaction(db, () => {
        const alreadyExists = db
          .prepare(
            `SELECT 1 FROM trajectories WHERE session_id = ?
             UNION ALL
             SELECT 1 FROM trajectory_archive WHERE session_id = ?
             LIMIT 1`
          )
          .get(candidate.session_id, candidate.session_id);
        if (alreadyExists) {
          return null;
        }
        return logTrajectory({
          scope: scoped.scope,
          projectId: scoped.projectId,
          sessionId: candidate.session_id,
          agent: modeOf(rows.map((r) => r.agent)) ?? null,
          // taskType is not derivable from observations, and guessing one would
          // pollute the failure-pattern grouping key.
          taskType: 'unknown',
          rollupSource: 'swept',
          observationIds: rows.map((r) => r.id),
          preFetchedObservations: rows,
          toolCalls,
          durationMs,
          // success is deliberately omitted: trajectoryStore derives it from the
          // cited rows under the 'swept' contract, which yields NULL (unknown)
          // unless a source row recorded a failure or a completion.
          // The attempt happened when its observations happened, not when the
          // sweeper noticed, so retention sees it in the right place in time.
          createdAt: rows[rows.length - 1].created_at,
        });
      })();
    } catch (err) {
      logger.error(
        {
          sessionId: candidate.session_id,
          error: err instanceof Error ? err.message : String(err),
        },
        'rollup sweep: failed to roll up session'
      );
      skipped++;
      continue;
    }

    if (!trajectoryId) {
      skipped++;
      continue;
    }

    const stored = db
      .prepare('SELECT success FROM trajectories WHERE id = ?')
      .get(trajectoryId) as { success: 0 | 1 | null } | undefined;

    sessions.push({
      session_id: candidate.session_id,
      trajectory_id: trajectoryId,
      observation_count: rows.length,
      tool_calls: toolCalls,
      duration_ms: durationMs,
      scope: scoped.scope,
      project_id: scoped.projectId,
      success: stored?.success ?? null,
    });
  }

  // Close any 'active' sessions whose latest activity is at or before cutoff
  const idleActiveSessions = db
    .prepare(
      `
      SELECT s.id
      FROM sessions s
      WHERE s.status = 'active'
        AND COALESCE(
          (
            SELECT MAX(created_at)
            FROM (
              SELECT created_at FROM observations WHERE session_id = s.id
              UNION ALL
              SELECT created_at FROM observations_archive WHERE session_id = s.id
            )
          ),
          CAST(strftime('%s', s.started_at) AS INTEGER)
        ) <= ?
      LIMIT ?
      `
    )
    .all(cutoff, limit) as Array<{ id: string }>;

  for (const row of idleActiveSessions) {
    try {
      endSession(row.id, { status: 'completed' });
    } catch (err) {
      logger.warn(
        {
          sessionId: row.id,
          error: err instanceof Error ? err.message : String(err),
        },
        'rollup sweep: failed to close idle active session'
      );
    }
  }

  const result: SweepResult = {
    idle_minutes: idleMinutes,
    cutoff,
    candidates: candidates.length,
    swept: sessions.length,
    skipped,
    sessions,
  };

  if (result.swept > 0 || result.skipped > 0) {
    logger.info(
      { idleMinutes, candidates: result.candidates, swept: result.swept, skipped: result.skipped },
      'rollup sweep complete'
    );
  } else {
    logger.debug({ idleMinutes }, 'rollup sweep found no idle sessions');
  }

  return result;
}
