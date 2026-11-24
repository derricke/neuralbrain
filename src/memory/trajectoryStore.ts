import { randomUUID } from 'crypto';
import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { redactOptional, redactSecrets } from '../lib/redactSecrets';
import { buildHierarchicalScopeSql, resolveScope } from '../lib/scope';
import { dequeueRecord, enqueueForEmbedding } from './embedQueueStore';
import { recordDeadLetter } from './deadLetterStore';
import { upsertFailurePattern } from './failurePatternStore';
import { deleteQdrantPoints } from '../learning/embedWorker';
import { transaction } from '../lib/sqlite';

export type TrajectoryScope = 'project' | 'global' | 'unknown';

/**
 * How the row came to exist.
 *
 *  - `signalled` — a client closed the task explicitly. The absence of a
 *    failure is then meaningful: something was there to report one.
 *  - `swept` — the idle sweeper found a session nobody ever closed. Nothing
 *    reported an outcome, so there is no outcome to record.
 *
 * They are not interchangeable when injecting prior outcomes, which is why
 * this is a column and not a log line.
 */
export type RollupSource = 'signalled' | 'swept';

export interface TrajectoryRecord {
  id?: string;
  scope?: TrajectoryScope;
  projectId?: string | null;
  userId?: string | null;
  user_id?: string | null;
  noteRef?: string | null;
  taskRef?: string | null;
  sessionId?: string | null;
  taskType?: string | null;
  agent?: string | null;
  agent_id?: string | null;
  description?: string;
  result?: string | null;
  /** NULL/undefined after rollup means *unknown*, never "failed". */
  success?: boolean | number | null;
  rollupSource?: RollupSource;
  toolCalls?: number;
  retries?: number;
  durationMs?: number;
  embedding?: number[];
  observationIds?: string[];
  preFetchedObservations?: Array<{
    id: string;
    kind: string;
    tool_name: string | null;
    input: string | null;
    output: string | null;
    duration_ms: number;
    failed: number;
    session_id?: string | null;
    created_at: number;
  }>;
  createdAt?: number;

  // Legacy/backward compatibility fields:
  taskId?: string;
  swarmId?: string;
  agentId?: string | null;
  jobId?: string | null;
  provider?: string;
  model?: string;
}

export interface CaptureTrajectoriesResult {
  accepted: number;
  ids: string[];
  rejected: Array<{
    index: number;
    reason: string;
    error: string;
  }>;
}

/** The most frequent non-null value, or null. Ties break on first appearance. */
function mostCommon<T extends string>(values: Array<T | null | undefined>): T | null {
  const counts = new Map<T, number>();
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: T | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** Tool names a client uses to record that a task actually finished. */
const COMPLETION_MARKERS = new Set(['task_complete', 'session_end', 'task_end']);

/**
 * Derive an outcome arithmetically from the source observations.
 *
 * `failed = 1` on any source is recorded evidence of failure, so 0.
 *
 * Success is the asymmetric half. For a `signalled` rollup the client said the
 * task closed, and a failure hook was in place to say otherwise, so "no
 * failure" is evidence of success. For a `swept` rollup nobody said anything —
 * the process may simply have been killed — so the answer is NULL unless a
 * source observation *records* completion. Absence of a failure is not
 * evidence of success; answering 1 there would be inventing an outcome, which
 * is precisely what an arithmetic rollup must never do.
 */
function deriveSuccess(
  rows: Array<{ kind: string; tool_name: string | null; failed: number }>,
  rollupSource: RollupSource
): 0 | 1 | null {
  if (rows.some((r) => r.failed === 1)) return 0;
  if (rollupSource === 'signalled') return 1;

  const completed = rows.some(
    (r) =>
      r.kind === 'tool_call' &&
      r.tool_name !== null &&
      COMPLETION_MARKERS.has(r.tool_name.trim().toLowerCase()) &&
      r.failed === 0
  );
  return completed ? 1 : null;
}

/** 0, 1 or null — and `undefined` means unknown too, never 0. */
function normalizeSuccess(value: boolean | number | null | undefined): 0 | 1 | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num ? 1 : 0;
}

function toCleanString(val: unknown): string | null {
  return typeof val === 'string' && val.trim() !== '' ? val.trim() : null;
}

export function logTrajectory(record: TrajectoryRecord): string {
  const db = getDb();
  const id = record.id && record.id.trim() !== '' ? record.id.trim() : randomUUID();

  // Backward-compatibility field mappings
  const rawProjectId = record.projectId ?? record.swarmId;
  let projectId = toCleanString(rawProjectId);
  const userId = toCleanString(record.userId ?? record.user_id);
  const agentId = toCleanString(record.agentId ?? record.agent_id);
  const taskRef = record.taskRef ?? record.taskId ?? null;
  const agent = toCleanString(record.agent) ?? agentId ?? null;
  const noteRef = record.noteRef ?? null;
  const taskType = record.taskType ?? 'unknown';
  const rollupSource: RollupSource = record.rollupSource ?? 'signalled';
  let sessionId = toCleanString(record.sessionId);

  // Scope: explicit, or 'project' when an id was supplied. Supplying an id
  // states project scope unambiguously, so this is not a rule-4 guess — the
  // forbidden direction (no id, therefore pick a project) never happens.
  const scope: TrajectoryScope = record.scope ?? (projectId ? 'project' : 'unknown');
  const scoped = resolveScope(scope, scope === 'project' ? projectId : null);
  if (!scoped.ok) {
    const err = new Error(scoped.error);
    (err as any).code = 'SCHEMA_INVALID';
    throw err;
  }
  projectId = scoped.projectId;

  // Arithmetic rollup from observationIds or preFetchedObservations if provided
  const observationIds = record.observationIds ?? (record as any).observation_ids;
  let description = record.description;
  let durationMs = record.durationMs ?? 0;
  let successValue = record.success;
  let toolCalls = record.toolCalls;
  let failureErrorText: string | null = null;

  type CitedRow = {
    id: string;
    kind: string;
    tool_name: string | null;
    input: string | null;
    output: string | null;
    duration_ms: number;
    failed: number;
    session_id: string | null;
    created_at: number;
  };

  let citedRows: CitedRow[] = [];
  if (record.preFetchedObservations && record.preFetchedObservations.length > 0) {
    citedRows = record.preFetchedObservations.map((r) => ({
      id: r.id,
      kind: r.kind,
      tool_name: r.tool_name,
      input: r.input,
      output: r.output,
      duration_ms: r.duration_ms,
      failed: r.failed,
      session_id: r.session_id ?? sessionId,
      created_at: r.created_at,
    }));
  } else if (Array.isArray(observationIds) && observationIds.length > 0) {
    const CHUNK_SIZE = 500;
    for (let i = 0; i < observationIds.length; i += CHUNK_SIZE) {
      const chunk = observationIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const batchRows = db
        .prepare(`
          SELECT id, kind, tool_name, input, output, duration_ms, failed, session_id, created_at
          FROM (
            SELECT id, kind, tool_name, input, output, duration_ms, failed, session_id, created_at
            FROM observations
            WHERE id IN (${placeholders})
            UNION ALL
            SELECT original_observation_id AS id, kind, tool_name, input, output, duration_ms, failed, session_id, created_at
            FROM observations_archive
            WHERE original_observation_id IN (${placeholders})
          )
        `)
        .all(...chunk, ...chunk) as CitedRow[];

      citedRows.push(...batchRows);
    }
    citedRows.sort((a, b) => a.created_at - b.created_at);
  }

  if (citedRows.length > 0) {
    if (record.durationMs === undefined) {
      durationMs = citedRows.reduce((sum, r) => sum + (r.duration_ms || 0), 0);
    }

    if (toolCalls === undefined) {
      toolCalls = citedRows.filter((r) => r.kind === 'tool_call').length;
    }

    if (!description || description.trim() === '') {
      const firstPrompt = citedRows.find((r) => r.kind === 'prompt');
      if (firstPrompt?.input) {
        description = firstPrompt.input;
      } else {
        const firstTool = citedRows[0];
        description = firstTool.tool_name ? `${firstTool.tool_name}: ${firstTool.input || ''}` : (firstTool.input || 'Task execution');
      }
    }

    // Carry the session from the sources when the caller did not name one,
    // so that a signalled rollup is visible to the sweeper's "a trajectory
    // already exists for this session" test. Most common wins; never invented.
    if (sessionId === null) {
      sessionId = mostCommon(citedRows.map((r) => r.session_id));
    }

    if (successValue === undefined) {
      successValue = deriveSuccess(citedRows, rollupSource);
    }

    const firstFailed = citedRows.find((r) => r.failed === 1);
    if (firstFailed) {
      failureErrorText = firstFailed.output || firstFailed.input || 'Observation failed';
    }
  }

  if (!description || description.trim() === '') {
    description = 'Task attempt';
  }

  // NULL is a real value here: unknown. `success || 0` would have turned every
  // unknown outcome into an assertion of failure.
  const successInt = normalizeSuccess(successValue);
  const retries = Number(record.retries || 0);
  const sanitizedDescription = redactSecrets(description);
  const sanitizedResult = redactOptional(record.result ?? null);
  const createdAt = record.createdAt ? Math.floor(record.createdAt) : Math.floor(Date.now() / 1000);

  const embeddingBuffer = record.embedding
    ? Buffer.from(Float32Array.from(record.embedding).buffer)
    : null;

  const insert = db.prepare(`
    INSERT INTO trajectories (
      id, scope, project_id, user_id, agent_id, note_ref, task_ref, session_id, task_type, agent,
      description, result, success, rollup_source, tool_calls, retries,
      duration_ms, embedding, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // A late explicit signal REPLACES the sweeper's safety-net row for the same
  // session. The swept row is a stand-in written because nobody closed the
  // task; once somebody does, it is strictly worse information about the same
  // attempt, and keeping both would double-count the session in prior
  // outcomes and break the sweeper's "one trajectory per session" predicate.
  // Nothing is lost: the observations it rolled up are immutable and still
  // there, which is what makes replacing it safe (rule 6, rule 2).
  const supersededSweptIds: string[] = [];
  const writeRow = transaction(db, () => {
    if (rollupSource === 'signalled' && sessionId !== null) {
      const swept = db
        .prepare("SELECT id FROM trajectories WHERE session_id = ? AND rollup_source = 'swept'")
        .all(sessionId) as Array<{ id: string }>;
      for (const row of swept) {
        db.prepare('DELETE FROM trajectories WHERE id = ?').run(row.id);
        supersededSweptIds.push(row.id);
      }
    }

    insert.run(
      id,
      scope,
      projectId,
      userId,
      agentId,
      noteRef,
      taskRef,
      sessionId,
      taskType,
      agent,
      sanitizedDescription,
      sanitizedResult,
      successInt,
      rollupSource,
      Number(toolCalls ?? 0),
      retries,
      durationMs,
      embeddingBuffer,
      createdAt
    );

    // Enqueue for embedding atomically inside the write transaction
    enqueueForEmbedding(id, 'trajectory');
  });
  writeRow();

  for (const sweptId of supersededSweptIds) {
    // Drop its embed-queue entries too, so the worker does not keep retrying a
    // row that no longer exists.
    try {
      dequeueRecord(sweptId, 'trajectory');
    } catch (err) {
      logger.error(
        { id: sweptId, error: err instanceof Error ? err.message : String(err) },
        'failed to dequeue superseded swept trajectory'
      );
    }
    logger.info(
      { sessionId, sweptId, replacedBy: id },
      'explicit rollup superseded a swept trajectory'
    );
  }

  if (supersededSweptIds.length > 0) {
    void deleteQdrantPoints(supersededSweptIds);
  }

  // If failed, auto-upsert failure pattern. An unknown outcome (NULL) is not a
  // failure and must not be injected as one.
  if (successInt === 0) {
    const errorText = sanitizedResult?.trim() || failureErrorText?.trim() || 'Task failed';
    try {
      upsertFailurePattern({
        scope,
        projectId,
        taskType,
        errorText,
      });
    } catch (err) {
      logger.error(
        { id, error: err instanceof Error ? err.message : String(err) },
        'failed to upsert failure pattern for failed trajectory'
      );
    }
  }

  logger.debug({ id, projectId, success: successInt }, 'trajectory logged');
  return id;
}

/**
 * Maps the wire format's snake_case fields (what docs/API.md documents and the
 * plugin's Stop hook sends) onto TrajectoryRecord's camelCase ones. Without
 * this, a `{scope: 'project', project_id: ...}` item passed the checks above
 * and then failed inside logTrajectory, which only read `projectId`, so every
 * hook-signalled session outcome was dead-lettered. camelCase wins when both
 * are present.
 */
function normalizeTrajectoryItem(item: Record<string, unknown>): TrajectoryRecord {
  const pick = (camel: string, snake: string): unknown => item[camel] ?? item[snake];
  return {
    ...(item as TrajectoryRecord),
    projectId: (pick('projectId', 'project_id') ?? item.swarm_id ?? item.swarmId) as string | null | undefined,
    sessionId: pick('sessionId', 'session_id') as string | null | undefined,
    taskType: pick('taskType', 'task_type') as string | null | undefined,
    taskRef: pick('taskRef', 'task_ref') as string | null | undefined,
    noteRef: pick('noteRef', 'note_ref') as string | null | undefined,
    rollupSource: pick('rollupSource', 'rollup_source') as RollupSource | undefined,
    toolCalls: pick('toolCalls', 'tool_calls') as number | undefined,
    durationMs: pick('durationMs', 'duration_ms') as number | undefined,
  };
}

export function captureTrajectories(rawItems: unknown[]): CaptureTrajectoriesResult {
  if (!Array.isArray(rawItems)) {
    throw new Error('captureTrajectories expects an array of trajectory items');
  }

  const ids: string[] = [];
  const rejected: Array<{ index: number; reason: string; error: string }> = [];

  rawItems.forEach((rawItem, index) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      recordDeadLetter({
        source: 'capture',
        reason: 'schema_invalid',
        payload: rawItem,
      });
      rejected.push({
        index,
        reason: 'schema_invalid',
        error: 'Trajectory item must be a non-null object',
      });
      return;
    }

    const item = rawItem as Record<string, unknown>;
    const rawScope = item.scope;
    const rawProjectId = item.project_id ?? item.projectId ?? item.swarm_id ?? item.swarmId;

    if (rawScope !== undefined && rawScope !== null && rawScope !== 'project' && rawScope !== 'global' && rawScope !== 'unknown') {
      recordDeadLetter({
        source: 'capture',
        reason: 'schema_invalid',
        payload: rawItem,
      });
      rejected.push({
        index,
        reason: 'schema_invalid',
        error: `Invalid scope '${String(rawScope)}'`,
      });
      return;
    }

    if (rawScope === 'project' && (!rawProjectId || typeof rawProjectId !== 'string' || rawProjectId.trim() === '')) {
      recordDeadLetter({
        source: 'capture',
        reason: 'schema_invalid',
        payload: rawItem,
      });
      rejected.push({
        index,
        reason: 'schema_invalid',
        error: "project_id is required when scope is 'project'",
      });
      return;
    }

    if ((rawScope === 'global' || rawScope === 'unknown') && rawProjectId !== undefined && rawProjectId !== null && rawProjectId !== '') {
      recordDeadLetter({
        source: 'capture',
        reason: 'schema_invalid',
        payload: rawItem,
      });
      rejected.push({
        index,
        reason: 'schema_invalid',
        error: `project_id must be null when scope is '${rawScope}'`,
      });
      return;
    }

    try {
      const id = logTrajectory(normalizeTrajectoryItem(item));
      ids.push(id);
    } catch (err) {
      recordDeadLetter({
        source: 'capture',
        reason: 'schema_invalid',
        payload: rawItem,
      });
      rejected.push({
        index,
        reason: 'schema_invalid',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return {
    accepted: ids.length,
    ids,
    rejected,
  };
}

const TRAJECTORY_COLUMNS =
  'id, scope, project_id, user_id, agent_id, note_ref, task_ref, session_id, task_type, agent, description, result, success, rollup_source, tool_calls, retries, duration_ms, created_at, archived_at';

export function getTrajectory(id: string) {
  return getDb().prepare(`SELECT ${TRAJECTORY_COLUMNS} FROM trajectories WHERE id = ?`).get(id);
}

export function getProjectTrajectories(projectId: string, limit = 50) {
  return getDb()
    .prepare(`SELECT ${TRAJECTORY_COLUMNS} FROM trajectories WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(projectId, limit);
}

export function listTrajectories(filters?: {
  projectId?: string;
  scope?: string;
  taskType?: string;
  success?: boolean;
  /** 'unknown' selects rows whose outcome is NULL. */
  successUnknown?: boolean;
  rollupSource?: RollupSource;
  includeAncestors?: boolean;
  includeChildren?: boolean;
  includeGlobal?: boolean;
  userId?: string;
  limit?: number;
  offset?: number;
}) {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  const hasProjectId = typeof filters?.projectId === 'string' && filters.projectId.trim() !== '';
  const hasScope = typeof filters?.scope === 'string' && filters.scope.trim() !== '';

  if (hasProjectId || hasScope) {
    const scopeSql = buildHierarchicalScopeSql({
      scope: hasScope ? filters!.scope : undefined,
      projectId: hasProjectId ? filters!.projectId : undefined,
      includeAncestors: filters?.includeAncestors ?? true,
      includeChildren: filters?.includeChildren ?? false,
      includeGlobal: filters?.includeGlobal ?? false,
      userId: filters?.userId,
    });
    conditions.push(scopeSql.clause);
    params.push(...scopeSql.params);
  } else if (typeof filters?.userId === 'string' && filters.userId.trim() !== '') {
    conditions.push('user_id = ?');
    params.push(filters.userId.trim());
  }

  if (filters?.taskType) {
    conditions.push('task_type = ?');
    params.push(filters.taskType);
  }
  if (filters?.success !== undefined) {
    // NULL matches neither branch: an unknown outcome is not a failure.
    conditions.push('success = ?');
    params.push(filters.success ? 1 : 0);
  }
  if (filters?.successUnknown) {
    conditions.push('success IS NULL');
  }
  if (filters?.rollupSource) {
    conditions.push('rollup_source = ?');
    params.push(filters.rollupSource);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;
  params.push(limit, offset);

  return db
    .prepare(`
      SELECT ${TRAJECTORY_COLUMNS} FROM trajectories
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params);
}

// Backward compatibility alias for NeuralSwarm
export const getSwarmTrajectories = getProjectTrajectories;

export interface CleanupResult {
  archived: number;
  deleted: number;
  observationsArchived: number;
  observationsDeleted: number;
  trajectoriesArchived: number;
  trajectoriesDeleted: number;
}

export function runCleanup(): CleanupResult {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const BATCH_SIZE = 500;

  const obsArchiveDays = parseInt(process.env.BRAIN_OBS_ARCHIVE_DAYS || '30', 10);
  const obsDeleteDays = parseInt(process.env.BRAIN_OBS_DELETE_DAYS || '90', 10);
  const trajArchiveDays = parseInt(process.env.BRAIN_TRAJECTORY_ARCHIVE_DAYS || '180', 10);
  const trajDeleteDays = parseInt(process.env.BRAIN_TRAJECTORY_DELETE_DAYS || '0', 10);
  const keepSummarized = process.env.BRAIN_KEEP_SUMMARIZED_SOURCES !== '0';

  const obsArchiveCutoff = now - obsArchiveDays * 86400;
  const obsDeleteCutoff = now - obsDeleteDays * 86400;
  const trajArchiveCutoff = now - trajArchiveDays * 86400;
  const trajDeleteCutoff = now - trajDeleteDays * 86400;

  // 1. Archive observations in bounded batches (each batch in its own transaction)
  const selectObsBatch = db.prepare(`
    SELECT id, scope, project_id, user_id, agent_id, note_ref, task_ref, session_id, agent,
           kind, tool_name, file_path, input, output, condensed_text, duration_ms, failed,
           event_at, created_at, archived_at
    FROM observations
    WHERE (created_at < ? AND archived_at IS NULL) OR archived_at IS NOT NULL
    LIMIT ?
  `);

  const insertObsArchive = db.prepare(`
    INSERT OR IGNORE INTO observations_archive (
      id, original_observation_id, scope, project_id, user_id, agent_id, note_ref, task_ref, session_id, agent,
      kind, tool_name, file_path, input, output, condensed_text, duration_ms, failed, event_at, created_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteObsActive = db.prepare('DELETE FROM observations WHERE id = ?');

  let observationsArchived = 0;
  while (true) {
    const batchCount = transaction(db, () => {
      const obsBatch = selectObsBatch.all(obsArchiveCutoff, BATCH_SIZE) as Array<{
        id: string;
        scope: string;
        project_id: string | null;
        user_id: string | null;
        agent_id: string | null;
        note_ref: string | null;
        task_ref: string | null;
        session_id: string | null;
        agent: string | null;
        kind: string;
        tool_name: string | null;
        file_path: string | null;
        input: string | null;
        output: string | null;
        condensed_text: string | null;
        duration_ms: number;
        failed: number;
        event_at: string | null;
        created_at: number;
        archived_at: number | null;
      }>;

      if (obsBatch.length === 0) return 0;

      for (const obs of obsBatch) {
        insertObsArchive.run(
          randomUUID(),
          obs.id,
          obs.scope,
          obs.project_id,
          obs.user_id,
          obs.agent_id,
          obs.note_ref,
          obs.task_ref,
          obs.session_id,
          obs.agent,
          obs.kind,
          obs.tool_name,
          obs.file_path,
          obs.input,
          obs.output,
          obs.condensed_text,
          obs.duration_ms,
          obs.failed,
          obs.event_at,
          obs.created_at,
          obs.archived_at ?? now
        );
        deleteObsActive.run(obs.id);
      }
      return obsBatch.length;
    })();

    if (batchCount === 0) break;
    observationsArchived += batchCount;
  }

  // 2. Delete old archived observations in bounded batches
  let observationsDeleted = 0;
  const selectObsDeleteBatch = keepSummarized
    ? db.prepare(`
        SELECT id, original_observation_id
        FROM observations_archive
        WHERE archived_at < ?
          AND original_observation_id NOT IN (
            SELECT record_id FROM summary_sources WHERE record_type = 'observation'
          )
        LIMIT ?
      `)
    : db.prepare(`
        SELECT id, original_observation_id
        FROM observations_archive
        WHERE archived_at < ?
        LIMIT ?
      `);

  while (true) {
    const batchObsIds = transaction(db, () => {
      const rows = selectObsDeleteBatch.all(obsDeleteCutoff, BATCH_SIZE) as Array<{
        id: string;
        original_observation_id: string;
      }>;
      if (rows.length === 0) return [] as string[];

      const archiveRowIds = rows.map((r) => r.id);
      const origObsIds = rows.map((r) => r.original_observation_id);
      const idPlaceholders = archiveRowIds.map(() => '?').join(',');
      const origPlaceholders = origObsIds.map(() => '?').join(',');

      if (!keepSummarized) {
        const summarizedToExpire = db
          .prepare(
            `SELECT DISTINCT summary_id FROM summary_sources WHERE record_type = 'observation' AND record_id IN (${origPlaceholders})`
          )
          .all(...origObsIds) as Array<{ summary_id: string }>;

        if (summarizedToExpire.length > 0) {
          const updateSummary = db.prepare('UPDATE summaries SET sources_expired = 1 WHERE id = ?');
          for (const item of summarizedToExpire) {
            updateSummary.run(item.summary_id);
          }
        }
      }

      db.prepare(`DELETE FROM observations_archive WHERE id IN (${idPlaceholders})`).run(
        ...archiveRowIds
      );
      db.prepare(
        `DELETE FROM embed_queue WHERE record_type = 'observation' AND record_id IN (${origPlaceholders})`
      ).run(...origObsIds);

      return origObsIds;
    })();

    if (batchObsIds.length === 0) break;
    observationsDeleted += batchObsIds.length;
    void deleteQdrantPoints(batchObsIds);
  }

  // 3. Archive trajectories in bounded batches (each batch in its own transaction)
  const selectTrajBatch = db.prepare(`
    SELECT id, scope, project_id, user_id, agent_id, note_ref, task_ref, session_id, task_type, agent,
           description, result, success, rollup_source, tool_calls, retries,
           duration_ms, embedding, created_at, archived_at
    FROM trajectories
    WHERE (created_at < ? AND archived_at IS NULL) OR archived_at IS NOT NULL
    LIMIT ?
  `);

  const insertTrajArchive = db.prepare(`
    INSERT OR IGNORE INTO trajectory_archive (
      id, original_trajectory_id, scope, project_id, user_id, agent_id, note_ref, task_ref, session_id,
      task_type, agent, description, result, success, rollup_source, tool_calls,
      retries, duration_ms, embedding, created_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteTrajActive = db.prepare('DELETE FROM trajectories WHERE id = ?');

  let trajectoriesArchived = 0;
  while (true) {
    const batchCount = transaction(db, () => {
      const trajBatch = selectTrajBatch.all(trajArchiveCutoff, BATCH_SIZE) as Array<{
        id: string;
        scope: string;
        project_id: string | null;
        user_id: string | null;
        agent_id: string | null;
        note_ref: string | null;
        task_ref: string | null;
        session_id: string | null;
        task_type: string | null;
        agent: string | null;
        description: string;
        result: string | null;
        success: number | null;
        rollup_source: string | null;
        tool_calls: number;
        retries: number;
        duration_ms: number;
        embedding: Buffer | null;
        created_at: number;
        archived_at: number | null;
      }>;

      if (trajBatch.length === 0) return 0;

      for (const traj of trajBatch) {
        insertTrajArchive.run(
          randomUUID(),
          traj.id,
          traj.scope,
          traj.project_id,
          traj.user_id,
          traj.agent_id,
          traj.note_ref,
          traj.task_ref,
          traj.session_id,
          traj.task_type,
          traj.agent,
          traj.description,
          traj.result,
          traj.success,
          traj.rollup_source,
          traj.tool_calls,
          traj.retries,
          traj.duration_ms,
          traj.embedding,
          traj.created_at,
          traj.archived_at ?? now
        );
        deleteTrajActive.run(traj.id);
      }
      return trajBatch.length;
    })();

    if (batchCount === 0) break;
    trajectoriesArchived += batchCount;
  }

  // 4. Delete archived trajectories in bounded batches (only if trajDeleteDays > 0)
  let trajectoriesDeleted = 0;
  const deletedTrajIds: string[] = [];
  if (trajDeleteDays > 0) {
    const selectTrajDeleteBatch = db.prepare(
      'SELECT id, original_trajectory_id FROM trajectory_archive WHERE archived_at < ? LIMIT ?'
    );

    while (true) {
      const batchTrajIds = transaction(db, () => {
        const rows = selectTrajDeleteBatch.all(trajDeleteCutoff, BATCH_SIZE) as Array<{
          id: string;
          original_trajectory_id: string;
        }>;
        if (rows.length === 0) return [] as string[];

        const archiveRowIds = rows.map((r) => r.id);
        const origTrajIds = rows.map((r) => r.original_trajectory_id);
        const idPlaceholders = archiveRowIds.map(() => '?').join(',');
        const origPlaceholders = origTrajIds.map(() => '?').join(',');

        db.prepare(`DELETE FROM trajectory_archive WHERE id IN (${idPlaceholders})`).run(
          ...archiveRowIds
        );
        db.prepare(
          `DELETE FROM embed_queue WHERE record_type = 'trajectory' AND record_id IN (${origPlaceholders})`
        ).run(...origTrajIds);

        return origTrajIds;
      })();

      if (batchTrajIds.length === 0) break;
      trajectoriesDeleted += batchTrajIds.length;
      deletedTrajIds.push(...batchTrajIds);
      void deleteQdrantPoints(batchTrajIds);
    }
  }

  const result = {
    archived: trajectoriesArchived,
    deleted: trajectoriesDeleted,
    observationsArchived,
    observationsDeleted,
    trajectoriesArchived,
    trajectoriesDeleted,
    deletedTrajIds,
  };

  logger.info(result, 'retention cleanup complete');
  return {
    archived: result.archived,
    deleted: result.deleted,
    observationsArchived: result.observationsArchived,
    observationsDeleted: result.observationsDeleted,
    trajectoriesArchived: result.trajectoriesArchived,
    trajectoriesDeleted: result.trajectoriesDeleted,
  };
}

export const runRetentionCleanup = runCleanup;
