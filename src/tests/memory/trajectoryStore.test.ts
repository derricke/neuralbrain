import { logTrajectory, getTrajectory, getProjectTrajectories, getSwarmTrajectories, listTrajectories, runCleanup } from '../../memory/trajectoryStore';
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
      userId: 'user-1',
      agentId: 'agent-1',
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
    expect(record.user_id).toBe('user-1');
    expect(record.agent_id).toBe('agent-1');
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
    expect(record.agent_id).toBe('legacy-agent');
    expect(record.scope).toBe('project');

    const byProject = getProjectTrajectories(swarmId);
    expect(byProject).toHaveLength(1);

    const bySwarm = getSwarmTrajectories(swarmId);
    expect(bySwarm).toHaveLength(1);
  });

  it('supports hierarchical project scoping and userId filtering in listTrajectories', () => {
    logTrajectory({
      scope: 'project',
      projectId: 'acme',
      userId: 'alice',
      agentId: 'a1',
      description: 'Root task',
      success: true,
    });
    logTrajectory({
      scope: 'project',
      projectId: 'acme/cogs',
      userId: 'bob',
      agentId: 'a2',
      description: 'Subproject task',
      success: true,
    });
    logTrajectory({
      scope: 'project',
      projectId: 'acme/cogs/ledger',
      userId: 'alice',
      agentId: 'a3',
      description: 'Leaf task',
      success: true,
    });
    logTrajectory({
      scope: 'global',
      userId: 'alice',
      agentId: 'a4',
      description: 'Global task',
      success: true,
    });

    // Default includeAncestors=true, includeGlobal=false
    expect(
      (listTrajectories({ projectId: 'acme/cogs/ledger' }) as Array<{ project_id: string | null }>)
        .map((r) => r.project_id)
        .sort()
    ).toEqual(['acme', 'acme/cogs', 'acme/cogs/ledger']);

    // includeAncestors=false
    expect(
      (
        listTrajectories({
          projectId: 'acme/cogs/ledger',
          includeAncestors: false,
        }) as Array<{ project_id: string | null }>
      ).map((r) => r.project_id)
    ).toEqual(['acme/cogs/ledger']);

    // includeChildren=true
    expect(
      (
        listTrajectories({
          projectId: 'acme/cogs',
          includeAncestors: false,
          includeChildren: true,
        }) as Array<{ project_id: string | null }>
      )
        .map((r) => r.project_id)
        .sort()
    ).toEqual(['acme/cogs', 'acme/cogs/ledger']);

    // includeGlobal=true + userId filter (never filters on agent_id)
    const aliceRows = listTrajectories({
      projectId: 'acme/cogs/ledger',
      includeGlobal: true,
      userId: 'alice',
    }) as Array<{ user_id: string | null; agent_id: string | null }>;
    expect(aliceRows).toHaveLength(3);
    expect(aliceRows.every((r) => r.user_id === 'alice')).toBe(true);
    expect(new Set(aliceRows.map((r) => r.agent_id))).toEqual(new Set(['a1', 'a3', 'a4']));
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

  it('cleanup archives old trajectories and observations including user_id, agent_id, and null-scope without error', () => {
    const db = getDb();
    const oldTimestamp = Math.floor(Date.now() / 1000) - 35 * 86400; // 35 days ago

    const obsId = 'obs-old-1';
    db.prepare(`
      INSERT INTO observations (id, scope, project_id, user_id, agent_id, kind, input, created_at)
      VALUES (?, 'project', 'proj-archive', 'u-obs', 'a-obs', 'response', 'old resp', ?)
    `).run(obsId, oldTimestamp);

    // 1. Project-scoped old trajectory
    const idProject = randomUUID();
    db.prepare(`
      INSERT INTO trajectories (id, scope, project_id, user_id, agent_id, description, success, duration_ms, created_at)
      VALUES (?, 'project', 'proj-archive', 'u-traj', 'a-traj', 'Old project task', 1, 100, ?)
    `).run(idProject, oldTimestamp);

    // 2. Null-scope (unknown) old trajectory
    const idUnknown = randomUUID();
    db.prepare(`
      INSERT INTO trajectories (id, scope, project_id, description, success, duration_ms, created_at)
      VALUES (?, 'unknown', NULL, 'Old unknown task', 1, 100, ?)
    `).run(idUnknown, oldTimestamp);

    const result = runCleanup();
    expect(result.observationsArchived).toBe(1);
    expect(result.trajectoriesArchived).toBe(2);

    expect(getTrajectory(idProject)).toBeUndefined();
    expect(getTrajectory(idUnknown)).toBeUndefined();

    const arcObs = db
      .prepare('SELECT original_observation_id, user_id, agent_id, kind FROM observations_archive WHERE original_observation_id = ?')
      .get(obsId) as { original_observation_id: string; user_id: string | null; agent_id: string | null; kind: string } | undefined;
    expect(arcObs).toEqual({
      original_observation_id: obsId,
      user_id: 'u-obs',
      agent_id: 'a-obs',
      kind: 'response',
    });

    const arcProject = db
      .prepare('SELECT original_trajectory_id, scope, project_id, user_id, agent_id FROM trajectory_archive WHERE original_trajectory_id = ?')
      .get(idProject) as { original_trajectory_id: string; scope: string; project_id: string | null; user_id: string | null; agent_id: string | null } | undefined;
    expect(arcProject?.original_trajectory_id).toBe(idProject);
    expect(arcProject?.scope).toBe('project');
    expect(arcProject?.project_id).toBe('proj-archive');
    expect(arcProject?.user_id).toBe('u-traj');
    expect(arcProject?.agent_id).toBe('a-traj');

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
      INSERT INTO summary_sources (summary_id, claim_id, record_id, record_type)
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
    logTrajectory({
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

  it('omits embedding BLOBs from trajectory read returns and redacts secrets on logTrajectory', () => {
    const db = getDb();
    const secret = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';
    const id = logTrajectory({
      scope: 'project',
      projectId: 'proj-traj-sec',
      description: `Run with ${secret}`,
      result: 'Failed with Bearer abcdefghijklmnopqrstuvwxyz123456',
      success: false,
      embedding: [0.1, 0.2, 0.3, 0.4],
    });

    const fetched = getTrajectory(id) as Record<string, unknown>;
    expect(fetched).toBeDefined();
    expect('embedding' in fetched).toBe(false);
    expect(fetched.description).not.toContain(secret);
    expect(fetched.description).toContain('[REDACTED_API_KEY]');
    expect(fetched.result).toContain('Bearer [REDACTED_TOKEN]');

    const projList = getProjectTrajectories('proj-traj-sec') as Array<Record<string, unknown>>;
    expect(projList).toHaveLength(1);
    expect('embedding' in projList[0]).toBe(false);

    const listed = listTrajectories({ projectId: 'proj-traj-sec' }) as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect('embedding' in listed[0]).toBe(false);

    // Also verify recordDeadLetter redacts secrets in payload
    const { recordDeadLetter, listDeadLetters } = require('../../memory/deadLetterStore');
    recordDeadLetter({
      source: 'capture',
      reason: 'schema_invalid',
      payload: { apiKey: secret },
    });
    const dls = listDeadLetters({ source: 'capture' });
    expect(dls.some((d: any) => d.payload.includes('[REDACTED_API_KEY]') && !d.payload.includes(secret))).toBe(true);
    expect(db.prepare('SELECT embedding FROM trajectories WHERE id = ?').get(id)).toBeDefined();
  });

  it('runCleanup deletes archived observations, calls deleteQdrantPoints, and cleans embed_queue', () => {
    const db = getDb();
    const deleteSpy = jest.spyOn(embedWorker, 'deleteQdrantPoints').mockImplementation(async () => {});
    process.env.BRAIN_KEEP_SUMMARIZED_SOURCES = '1';
    process.env.BRAIN_TRAJECTORY_DELETE_DAYS = '60';

    const oldTs = Math.floor(Date.now() / 1000) - 95 * 86400;
    const obsId = 'obs-purge-qdrant';
    const trajId = 'traj-purge-queue';

    db.prepare(`
      INSERT INTO observations_archive (
        id, original_observation_id, scope, project_id, kind, created_at, archived_at
      ) VALUES (?, ?, 'project', 'p-clean', 'prompt', ?, ?)
    `).run(randomUUID(), obsId, oldTs, oldTs);

    db.prepare(`
      INSERT INTO trajectory_archive (
        id, original_trajectory_id, scope, project_id, description, success, created_at, archived_at
      ) VALUES (?, ?, 'project', 'p-clean', 'Old', 1, ?, ?)
    `).run(randomUUID(), trajId, oldTs, oldTs);

    db.prepare(`
      INSERT INTO embed_queue (record_id, record_type, status, target)
      VALUES (?, 'observation', 'pending', 'live'), (?, 'trajectory', 'pending', 'live')
    `).run(obsId, trajId);

    const res = runCleanup();
    expect(res.observationsDeleted).toBe(1);
    expect(res.trajectoriesDeleted).toBe(1);
    expect(deleteSpy).toHaveBeenCalledWith([obsId]);
    expect(deleteSpy).toHaveBeenCalledWith([trajId]);

    const remainingQueue = db
      .prepare('SELECT record_id FROM embed_queue WHERE record_id IN (?, ?)')
      .all(obsId, trajId);
    expect(remainingQueue).toHaveLength(0);
    deleteSpy.mockRestore();
  });
});
