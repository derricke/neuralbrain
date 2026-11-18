import { logTrajectory, getTrajectory, getProjectTrajectories, getSwarmTrajectories, runCleanup } from '../../memory/trajectoryStore';
import { captureObservations } from '../../memory/observationStore';
import { getFailurePatterns } from '../../memory/failurePatternStore';
import { getDb, resetDb } from '../../lib/db';
import * as embedWorker from '../../learning/embedWorker';
import { randomUUID } from 'crypto';

beforeEach(() => {
  resetDb();
  process.env.DATABASE_URL = ':memory:';
  process.env.BRAIN_TRAJECTORY_ARCHIVE_DAYS = '30';
  process.env.BRAIN_TRAJECTORY_DELETE_DAYS = '0';
  process.env.BRAIN_OBS_ARCHIVE_DAYS = '30';
  process.env.BRAIN_OBS_DELETE_DAYS = '90';
  process.env.BRAIN_KEEP_SUMMARIZED_SOURCES = '1';
  getDb();
});

afterAll(() => {
  resetDb();
});

describe('trajectoryStore', () => {
  it('logs and retrieves a trajectory with generalized schema', () => {
    const projectId = 'proj-123';
    const noteRef = 'note-abc';
    const taskType = 'migration';

    const id = logTrajectory({
      scope: 'project',
      projectId,
      noteRef,
      taskType,
      agent: 'agent-smith',
      description: 'Run database migration',
      result: 'Migration successful',
      success: true,
      retries: 0,
      durationMs: 500,
    });

    const record = getTrajectory(id) as Record<string, unknown>;
    expect(record).toBeDefined();
    expect(record.id).toBe(id);
    expect(record.scope).toBe('project');
    expect(record.project_id).toBe(projectId);
    expect(record.note_ref).toBe(noteRef);
    expect(record.task_type).toBe(taskType);
    expect(record.agent).toBe('agent-smith');
    expect(record.success).toBe(1);
    expect(record.duration_ms).toBe(500);
  });

  it('supports backward compatibility fields (swarmId, taskId, agentId)', () => {
    const swarmId = 'swarm-legacy';
    const taskId = 'task-legacy';

    const id = logTrajectory({
      swarmId,
      taskId,
      agentId: 'legacy-agent',
      description: 'Legacy task execution',
      result: 'OK',
      success: true,
      retries: 0,
      durationMs: 250,
    });

    const record = getTrajectory(id) as Record<string, unknown>;
    expect(record).toBeDefined();
    expect(record.project_id).toBe(swarmId);
    expect(record.task_ref).toBe(taskId);
    expect(record.agent).toBe('legacy-agent');
    expect(record.scope).toBe('project');

    const byProject = getProjectTrajectories(swarmId);
    expect(byProject).toHaveLength(1);

    const bySwarm = getSwarmTrajectories(swarmId);
    expect(bySwarm).toHaveLength(1);
  });

  it('enforces scope constraints on write', () => {
    // scope='project' without projectId must throw
    expect(() => {
      logTrajectory({
        scope: 'project',
        projectId: null,
        description: 'Invalid project scope',
      });
    }).toThrow();

    // scope='unknown' with projectId must clear projectId or throw
    const id = logTrajectory({
      scope: 'unknown',
      description: 'Unscoped task attempt',
    });
    const record = getTrajectory(id) as Record<string, unknown>;
    expect(record.scope).toBe('unknown');
    expect(record.project_id).toBeNull();
  });

  it('performs arithmetic rollup when observationIds are supplied', () => {
    const obsResult = captureObservations([
      {
        scope: 'project',
        project_id: 'proj-rollup',
        kind: 'prompt',
        input: 'Implement user auth module',
        output: null,
        duration_ms: 50,
        failed: 0,
      },
      {
        scope: 'project',
        project_id: 'proj-rollup',
        kind: 'tool_call',
        tool_name: 'WriteFile',
        file_path: 'src/auth.ts',
        input: 'code',
        output: 'written',
        duration_ms: 150,
        failed: 0,
      },
      {
        scope: 'project',
        project_id: 'proj-rollup',
        kind: 'tool_call',
        tool_name: 'RunTests',
        input: 'npm test',
        output: 'passed',
        duration_ms: 300,
        failed: 0,
      },
    ]);

    expect(obsResult.accepted).toBe(3);

    // Rollup without explicit description, durationMs, or success
    const id = logTrajectory({
      scope: 'project',
      projectId: 'proj-rollup',
      taskType: 'feature',
      observationIds: obsResult.ids,
    });

    const record = getTrajectory(id) as Record<string, unknown>;
    expect(record).toBeDefined();
    // description taken from first prompt
    expect(record.description).toBe('Implement user auth module');
    // duration summed: 50 + 150 + 300 = 500
    expect(record.duration_ms).toBe(500);
    // success derived as 1 because none failed
    expect(record.success).toBe(1);
  });

  it('derives success=0 and auto-upserts failure pattern on failed observation in rollup', () => {
    const projectId = 'proj-fail-test';
    const obsResult = captureObservations([
      {
        scope: 'project',
        project_id: projectId,
        kind: 'prompt',
        input: 'Fix database lock issue',
      },
      {
        scope: 'project',
        project_id: projectId,
        kind: 'tool_call',
        tool_name: 'ExecuteSQL',
        input: 'ALTER TABLE',
        output: 'SqliteError: database is locked',
        duration_ms: 100,
        failed: 1,
      },
    ]);

    const trajId = logTrajectory({
      scope: 'project',
      projectId,
      taskType: 'db_fix',
      observationIds: obsResult.ids,
    });

    const record = getTrajectory(trajId) as Record<string, unknown>;
    expect(record.success).toBe(0);

    const patterns = getFailurePatterns({ projectId, taskType: 'db_fix' });
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].error_text).toContain('database is locked');
    expect(patterns[0].count).toBe(1);

    // Second failure with same error increments count
    logTrajectory({
      scope: 'project',
      projectId,
      taskType: 'db_fix',
      description: 'Retry fix',
      result: 'SqliteError: database is locked',
      success: false,
    });

    const patternsAfter = getFailurePatterns({ projectId, taskType: 'db_fix' });
    expect(patternsAfter[0].count).toBe(2);
  });

  it('cleanup archives old trajectories including null-scope without error', () => {
    const db = getDb();
    const oldTimestamp = Math.floor(Date.now() / 1000) - 35 * 86400; // 35 days ago

    // 1. Project-scoped old trajectory
    const idProject = randomUUID();
    db.prepare(`
      INSERT INTO trajectories (id, scope, project_id, description, success, duration_ms, created_at)
      VALUES (?, 'project', 'proj-archive', 'Old project task', 1, 100, ?)
    `).run(idProject, oldTimestamp);

    // 2. Null-scope (unknown) old trajectory
    const idUnknown = randomUUID();
    db.prepare(`
      INSERT INTO trajectories (id, scope, project_id, description, success, duration_ms, created_at)
      VALUES (?, 'unknown', NULL, 'Old unknown task', 1, 100, ?)
    `).run(idUnknown, oldTimestamp);

    const result = runCleanup();
    expect(result.trajectoriesArchived).toBe(2);

    expect(getTrajectory(idProject)).toBeUndefined();
    expect(getTrajectory(idUnknown)).toBeUndefined();

    const arcProject = db
      .prepare('SELECT original_trajectory_id, scope, project_id FROM trajectory_archive WHERE original_trajectory_id = ?')
      .get(idProject) as { original_trajectory_id: string; scope: string; project_id: string | null } | undefined;
    expect(arcProject?.original_trajectory_id).toBe(idProject);
    expect(arcProject?.scope).toBe('project');
    expect(arcProject?.project_id).toBe('proj-archive');

    const arcUnknown = db
      .prepare('SELECT original_trajectory_id, scope, project_id FROM trajectory_archive WHERE original_trajectory_id = ?')
      .get(idUnknown) as { original_trajectory_id: string; scope: string; project_id: string | null } | undefined;
    expect(arcUnknown?.original_trajectory_id).toBe(idUnknown);
    expect(arcUnknown?.scope).toBe('unknown');
    expect(arcUnknown?.project_id).toBeNull();
  });

  it('cleanup preserves summarized observations when BRAIN_KEEP_SUMMARIZED_SOURCES=1', () => {
    const db = getDb();
    process.env.BRAIN_KEEP_SUMMARIZED_SOURCES = '1';

    const obsOldTimestamp = Math.floor(Date.now() / 1000) - 95 * 86400; // 95 days ago (older than delete cutoff 90d)
    const arcTimestamp = Math.floor(Date.now() / 1000) - 95 * 86400;

    // Create an observation that was already archived 95 days ago
    const obsId1 = 'obs_summarized_source';
    const obsId2 = 'obs_unsummarized';

    db.prepare(`
      INSERT INTO observations_archive (
        id, original_observation_id, scope, project_id, kind, created_at, archived_at
      ) VALUES (?, ?, 'project', 'p1', 'prompt', ?, ?)
    `).run(randomUUID(), obsId1, obsOldTimestamp, arcTimestamp);

    db.prepare(`
      INSERT INTO observations_archive (
        id, original_observation_id, scope, project_id, kind, created_at, archived_at
      ) VALUES (?, ?, 'project', 'p1', 'prompt', ?, ?)
    `).run(randomUUID(), obsId2, obsOldTimestamp, arcTimestamp);

    // Create a summary and link obsId1 in summary_sources
    const summaryId = 'sum-test-1';
    db.prepare(`
      INSERT INTO summaries (
        id, scope, project_id, kind, producer_tier, prompt_version, created_at
      ) VALUES (?, 'project', 'p1', 'session', 'agent', 'v1', ?)
    `).run(summaryId, obsOldTimestamp);

    db.prepare(`
      INSERT INTO summary_sources (summary_id, claim_id, record_id, grain)
      VALUES (?, NULL, ?, 'observation')
    `).run(summaryId, obsId1);

    const cleanupResult = runCleanup();
    // obsId2 should be deleted, obsId1 must be kept because it is in summary_sources!
    expect(cleanupResult.observationsDeleted).toBe(1);

    const kept = db
      .prepare('SELECT original_observation_id FROM observations_archive WHERE original_observation_id = ?')
      .get(obsId1);
    expect(kept).toBeDefined();

    const deleted = db
      .prepare('SELECT original_observation_id FROM observations_archive WHERE original_observation_id = ?')
      .get(obsId2);
    expect(deleted).toBeUndefined();
  });

  it('calls deleteQdrantPoints when superseded swept trajectory is replaced and when archived trajectories are purged (Q25)', () => {
    const db = getDb();
    const deleteSpy = jest.spyOn(embedWorker, 'deleteQdrantPoints').mockImplementation(async () => {});

    // 1. Superseded swept trajectory replacement
    const sessionId = 'session-q25';
    const sweptId = logTrajectory({
      scope: 'project',
      projectId: 'proj-q25',
      sessionId,
      description: 'Swept placeholder',
      rollupSource: 'swept',
    });

    // Now log a signalled trajectory for the same session
    const signalledId = logTrajectory({
      scope: 'project',
      projectId: 'proj-q25',
      sessionId,
      description: 'Signalled completion',
      rollupSource: 'signalled',
    });

    expect(deleteSpy).toHaveBeenCalledWith([sweptId]);

    // 2. Trajectory purging in runCleanup when BRAIN_TRAJECTORY_DELETE_DAYS > 0
    process.env.BRAIN_TRAJECTORY_DELETE_DAYS = '60';
    const oldTimestamp = Math.floor(Date.now() / 1000) - 70 * 86400;
    const trajToPurge = 'traj-to-purge-1';

    db.prepare(`
      INSERT INTO trajectory_archive (
        id, original_trajectory_id, scope, project_id, description, success, created_at, archived_at
      ) VALUES (?, ?, 'project', 'proj-q25', 'Old archived attempt', 1, ?, ?)
    `).run(randomUUID(), trajToPurge, oldTimestamp - 100, oldTimestamp);

    runCleanup();

    expect(deleteSpy).toHaveBeenCalledWith([trajToPurge]);
    deleteSpy.mockRestore();
  });
});
