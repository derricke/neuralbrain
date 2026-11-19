import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { getDb, resetDb } from '../../lib/db';
import { openDatabase } from '../../lib/sqlite';
import { captureObservations } from '../../memory/observationStore';
import { logTrajectory, runCleanup } from '../../memory/trajectoryStore';
import { getFailurePatterns } from '../../memory/failurePatternStore';
import { sweepIdleSessions } from '../../memory/rollupSweeper';
import { createApp } from '../../app';
import { verifyOrCreateStoreMeta } from '../../learning/storeMeta';

// Several of these make a run of sequential inserts or HTTP calls; the 5s
// default has produced false failures in this suite before.
jest.setTimeout(30000);

const HOUR = 3600;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** An idle session: every observation older than the idle window. */
function seedIdleSession(
  sessionId: string,
  overrides?: {
    scope?: string;
    projectId?: string | null;
    failed?: boolean;
    ageSec?: number;
  }
) {
  const age = overrides?.ageSec ?? 2 * HOUR;
  const base = nowSec() - age;
  const scope = overrides?.scope ?? 'project';
  const projectId = overrides?.projectId ?? (scope === 'project' ? 'proj-sweep' : null);

  const items: Record<string, unknown>[] = [
    {
      scope,
      project_id: projectId,
      session_id: sessionId,
      agent: 'claude-code',
      kind: 'prompt',
      input: 'Refactor the retention path',
      duration_ms: 20,
      failed: 0,
      created_at: base,
    },
    {
      scope,
      project_id: projectId,
      session_id: sessionId,
      agent: 'claude-code',
      kind: 'tool_call',
      tool_name: 'WriteFile',
      file_path: 'src/retention.ts',
      input: 'code',
      output: 'written',
      duration_ms: 100,
      failed: 0,
      created_at: base + 10,
    },
    {
      scope,
      project_id: projectId,
      session_id: sessionId,
      agent: 'claude-code',
      kind: 'tool_call',
      tool_name: 'RunTests',
      input: 'npm test',
      output: overrides?.failed ? 'AssertionError: retention left rows behind' : 'passed',
      duration_ms: 380,
      failed: overrides?.failed ? 1 : 0,
      created_at: base + 20,
    },
  ];

  const result = captureObservations(items);
  expect(result.accepted).toBe(3);
  return result.ids;
}

describe('idle rollup sweeper', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetDb();
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'none';
    process.env.BRAIN_ROLLUP_IDLE_MINUTES = '30';
    process.env.BRAIN_TRAJECTORY_ARCHIVE_DAYS = '180';
    process.env.BRAIN_TRAJECTORY_DELETE_DAYS = '0';
    process.env.BRAIN_OBS_ARCHIVE_DAYS = '30';
    process.env.BRAIN_OBS_DELETE_DAYS = '90';
    getDb();
  });

  afterEach(() => {
    resetDb();
    process.env = { ...originalEnv };
  });

  it('rolls an abandoned session up with success NULL — never 1', () => {
    seedIdleSession('sess-abandoned');

    const result = sweepIdleSessions();
    expect(result.swept).toBe(1);
    expect(result.sessions[0].session_id).toBe('sess-abandoned');

    const traj = getDb()
      .prepare('SELECT * FROM trajectories WHERE session_id = ?')
      .get('sess-abandoned') as any;

    // The whole point: nothing recorded an outcome, so there is no outcome.
    expect(traj.success).toBeNull();
    expect(traj.success).not.toBe(1);
    expect(traj.success).not.toBe(0);
    expect(traj.rollup_source).toBe('swept');

    // Arithmetic rollup: summed durations, counted tool calls, first prompt.
    expect(traj.duration_ms).toBe(500);
    expect(traj.tool_calls).toBe(2);
    expect(traj.description).toBe('Refactor the retention path');
    expect(traj.scope).toBe('project');
    expect(traj.project_id).toBe('proj-sweep');
    expect(traj.agent).toBe('claude-code');

    // No outcome means no failure pattern.
    expect(getFailurePatterns({ projectId: 'proj-sweep' }).length).toBe(0);
  });

  it('records success 0 when a source observation actually failed', () => {
    seedIdleSession('sess-failed', { failed: true, projectId: 'proj-swept-fail' });

    const result = sweepIdleSessions();
    expect(result.swept).toBe(1);

    const traj = getDb()
      .prepare('SELECT * FROM trajectories WHERE session_id = ?')
      .get('sess-failed') as any;
    expect(traj.success).toBe(0);
    expect(traj.rollup_source).toBe('swept');

    // A swept failure is now injectable, which is the point of sweeping.
    const patterns = getFailurePatterns({ projectId: 'proj-swept-fail' });
    expect(patterns.length).toBe(1);
    expect(patterns[0].error_text).toContain('retention left rows behind');
  });

  it('leaves an active session alone', () => {
    // Newest observation is 1 minute old, well inside the 30-minute window.
    seedIdleSession('sess-active', { ageSec: 60 });

    const result = sweepIdleSessions();
    expect(result.candidates).toBe(0);
    expect(result.swept).toBe(0);

    const count = getDb()
      .prepare('SELECT COUNT(*) as c FROM trajectories')
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('is idempotent: a second sweep changes nothing', () => {
    seedIdleSession('sess-twice');

    const first = sweepIdleSessions();
    expect(first.swept).toBe(1);
    const firstId = first.sessions[0].trajectory_id;

    const second = sweepIdleSessions();
    expect(second.candidates).toBe(0);
    expect(second.swept).toBe(0);

    const rows = getDb()
      .prepare('SELECT id FROM trajectories WHERE session_id = ?')
      .all('sess-twice') as Array<{ id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(firstId);
  });

  it('does not sweep a session a client already rolled up explicitly', () => {
    const ids = seedIdleSession('sess-signalled');
    logTrajectory({
      scope: 'project',
      projectId: 'proj-sweep',
      taskType: 'refactor',
      observationIds: ids,
    });

    const result = sweepIdleSessions();
    expect(result.candidates).toBe(0);

    const rows = getDb()
      .prepare('SELECT rollup_source FROM trajectories WHERE session_id = ?')
      .all('sess-signalled') as Array<{ rollup_source: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].rollup_source).toBe('signalled');
  });

  it('a late explicit signal replaces the swept row for that session', () => {
    const ids = seedIdleSession('sess-late');
    const swept = sweepIdleSessions();
    const sweptId = swept.sessions[0].trajectory_id;

    const signalledId = logTrajectory({
      scope: 'project',
      projectId: 'proj-sweep',
      taskType: 'refactor',
      observationIds: ids,
    });

    const db = getDb();
    const rows = db
      .prepare('SELECT id, success, rollup_source FROM trajectories WHERE session_id = ?')
      .all('sess-late') as Array<{ id: string; success: number | null; rollup_source: string }>;

    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(signalledId);
    expect(rows[0].rollup_source).toBe('signalled');
    // The explicit signal carries an outcome the sweeper could not know.
    expect(rows[0].success).toBe(1);

    // The swept stand-in and its embed-queue entries are gone.
    expect(db.prepare('SELECT id FROM trajectories WHERE id = ?').get(sweptId)).toBeUndefined();
    const queued = db
      .prepare('SELECT COUNT(*) as c FROM embed_queue WHERE record_id = ?')
      .get(sweptId) as { c: number };
    expect(queued.c).toBe(0);
  });

  it('rolls up and archives a session with no scope, keeping success NULL', () => {
    seedIdleSession('sess-unknown-scope', { scope: 'unknown', projectId: null });

    const result = sweepIdleSessions();
    expect(result.swept).toBe(1);
    expect(result.sessions[0].scope).toBe('unknown');
    expect(result.sessions[0].project_id).toBeNull();

    const db = getDb();
    const traj = db
      .prepare('SELECT * FROM trajectories WHERE session_id = ?')
      .get('sess-unknown-scope') as any;
    expect(traj.scope).toBe('unknown');
    expect(traj.project_id).toBeNull();
    expect(traj.success).toBeNull();

    // Archive it: a nullable scope AND a nullable success must both survive,
    // or retention breaks for exactly the rows rule 4 tells us to allow.
    process.env.BRAIN_TRAJECTORY_ARCHIVE_DAYS = '0';
    const cleanup = runCleanup();
    expect(cleanup.trajectoriesArchived).toBeGreaterThanOrEqual(1);

    const archived = db
      .prepare('SELECT * FROM trajectory_archive WHERE original_trajectory_id = ?')
      .get(traj.id) as any;
    expect(archived).toBeDefined();
    expect(archived.success).toBeNull();
    expect(archived.rollup_source).toBe('swept');
    expect(archived.project_id).toBeNull();
    expect(archived.session_id).toBe('sess-unknown-scope');
    expect(archived.tool_calls).toBe(2);
  });

  it('carries the most common scope when source observations disagree, inventing none', () => {
    const base = nowSec() - 2 * HOUR;
    const mk = (scope: string, projectId: string | null, offset: number) => ({
      scope,
      project_id: projectId,
      session_id: 'sess-mixed',
      kind: 'tool_call',
      tool_name: 'Read',
      input: 'x',
      duration_ms: 1,
      failed: 0,
      created_at: base + offset,
    });

    const res = captureObservations([
      mk('project', 'proj-majority', 0),
      mk('project', 'proj-majority', 1),
      mk('unknown', null, 2),
    ]);
    expect(res.accepted).toBe(3);

    expect(sweepIdleSessions().swept).toBe(1);
    const traj = getDb()
      .prepare('SELECT scope, project_id FROM trajectories WHERE session_id = ?')
      .get('sess-mixed') as any;
    expect(traj.scope).toBe('project');
    expect(traj.project_id).toBe('proj-majority');
  });

  it('records an unknown outcome as NULL when a writer states no success', () => {
    // Behaviour change: this used to be coerced to 0, which asserted failure
    // for a record nobody reported an outcome for — and then injected it as a
    // failure pattern.
    const id = logTrajectory({
      scope: 'project',
      projectId: 'proj-no-outcome',
      taskType: 'build',
      description: 'A task attempt whose outcome nobody reported',
    });

    const traj = getDb().prepare('SELECT * FROM trajectories WHERE id = ?').get(id) as any;
    expect(traj.success).toBeNull();
    expect(traj.rollup_source).toBe('signalled');
    expect(getFailurePatterns({ projectId: 'proj-no-outcome' }).length).toBe(0);

    // An unknown outcome matches neither success filter, rather than being
    // silently counted as a failure.
    const failures = getDb()
      .prepare('SELECT COUNT(*) as c FROM trajectories WHERE success = 0')
      .get() as { c: number };
    expect(failures.c).toBe(0);
  });

  it('honours BRAIN_ROLLUP_IDLE_MINUTES and an explicit override', () => {
    seedIdleSession('sess-window', { ageSec: 20 * 60 });

    // 30-minute default: 20 minutes idle is still active.
    expect(sweepIdleSessions().swept).toBe(0);

    // Explicit override wins over the env default.
    expect(sweepIdleSessions({ idleMinutes: 10 }).swept).toBe(1);

    const traj = getDb()
      .prepare('SELECT rollup_source FROM trajectories WHERE session_id = ?')
      .get('sess-window') as any;
    expect(traj.rollup_source).toBe('swept');
  });

  it('ignores observations with no session id', () => {
    const base = nowSec() - 2 * HOUR;
    captureObservations([
      {
        scope: 'unknown',
        kind: 'tool_call',
        tool_name: 'Read',
        input: 'x',
        duration_ms: 5,
        created_at: base,
      },
    ]);

    const result = sweepIdleSessions();
    expect(result.candidates).toBe(0);
    expect(
      (getDb().prepare('SELECT COUNT(*) as c FROM trajectories').get() as { c: number }).c
    ).toBe(0);
  });

  it('closes idle active sessions as completed during sweep', () => {
    const db = getDb();
    const sessionId = 'sess-idle-active-1';
    const twoHoursAgo = nowSec() - 2 * HOUR;

    db.prepare(
      `INSERT INTO sessions (id, scope, project_id, agent_name, status) VALUES (?, 'project', 'proj-sweep', 'antigravity', 'active')`
    ).run(sessionId);

    captureObservations([
      {
        scope: 'project',
        project_id: 'proj-sweep',
        session_id: sessionId,
        kind: 'tool_call',
        tool_name: 'Read',
        input: 'old work',
        duration_ms: 10,
        failed: 0,
        created_at: twoHoursAgo,
      },
    ]);

    sweepIdleSessions({ idleMinutes: 30 });

    const sess = db.prepare('SELECT status, ended_at, summary FROM sessions WHERE id = ?').get(sessionId) as any;
    expect(sess.status).toBe('completed');
    expect(sess.ended_at).toBeTruthy();
    expect(sess.summary).toContain('1 observations');
  });
});

describe('POST /maintenance/rollup-sweep', () => {
  const originalEnv = { ...process.env };
  let app: any;
  const testApiKey = 'test_api_key_sweep';

  beforeEach(() => {
    resetDb();
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_REQUIRE_API_KEY = '1';
    process.env.BRAIN_EMBED = 'none';
    process.env.BRAIN_ROLLUP_IDLE_MINUTES = '30';

    const db = getDb();
    db.prepare(
      `INSERT INTO api_keys (id, name, key, created_at) VALUES (?, 'sweep-key', ?, datetime('now'))`
    ).run(randomUUID(), testApiKey);
    verifyOrCreateStoreMeta();
    app = createApp();
  });

  afterEach(() => {
    resetDb();
    process.env = { ...originalEnv };
  });

  it('sweeps idle sessions and returns counts', async () => {
    seedIdleSession('sess-http');

    const res = await request(app)
      .post('/maintenance/rollup-sweep')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.idle_minutes).toBe(30);
    expect(res.body.candidates).toBe(1);
    expect(res.body.swept).toBe(1);
    expect(res.body.sessions[0].session_id).toBe('sess-http');
    expect(res.body.sessions[0].success).toBeNull();

    // Idempotent over HTTP too.
    const again = await request(app)
      .post('/maintenance/rollup-sweep')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({});
    expect(again.status).toBe(200);
    expect(again.body.swept).toBe(0);
  });

  it('exposes swept rollups through GET /trajectories filters', async () => {
    seedIdleSession('sess-filter');
    await request(app)
      .post('/maintenance/rollup-sweep')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({});

    const swept = await request(app)
      .get('/trajectories?rollup_source=swept')
      .set('Authorization', `Bearer ${testApiKey}`);
    expect(swept.status).toBe(200);
    expect(swept.body.length).toBe(1);
    expect(swept.body[0].session_id).toBe('sess-filter');

    // An unknown outcome is addressable, and is not returned as a failure.
    const unknown = await request(app)
      .get('/trajectories?success=unknown')
      .set('Authorization', `Bearer ${testApiKey}`);
    expect(unknown.body.length).toBe(1);

    const failed = await request(app)
      .get('/trajectories?success=false')
      .set('Authorization', `Bearer ${testApiKey}`);
    expect(failed.body.length).toBe(0);
  });

  it('rejects a negative idle_minutes', async () => {
    const res = await request(app)
      .post('/maintenance/rollup-sweep')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({ idle_minutes: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SCHEMA_INVALID');
  });
});

describe('trajectory schema alignment on an existing store', () => {
  const originalEnv = { ...process.env };
  let dir: string;

  beforeEach(() => {
    resetDb();
    process.env = { ...originalEnv };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-rollup-migration-'));
  });

  afterEach(() => {
    resetDb();
    process.env = { ...originalEnv };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('relaxes success to nullable and backfills rollup_source on a pre-existing table', () => {
    const dbPath = path.join(dir, 'legacy.db');

    // The pre-change shape, written by a raw connection as a fixture only.
    // CREATE TABLE IF NOT EXISTS would never touch this table, which is why
    // the alignment step exists at all.
    const fixture = openDatabase(dbPath);
    fixture.exec(`
      CREATE TABLE trajectories (
        id           TEXT PRIMARY KEY,
        scope        TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
        project_id   TEXT,
        note_ref     TEXT,
        task_ref     TEXT,
        task_type    TEXT,
        agent        TEXT,
        description  TEXT NOT NULL,
        result       TEXT,
        success      INTEGER NOT NULL DEFAULT 0,
        retries      INTEGER NOT NULL DEFAULT 0,
        duration_ms  INTEGER NOT NULL DEFAULT 0,
        embedding    BLOB,
        created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
        archived_at  INTEGER,
        CHECK ((scope = 'project') = (project_id IS NOT NULL))
      );
      CREATE INDEX idx_traj_project ON trajectories(project_id);
    `);
    fixture
      .prepare(
        'INSERT INTO trajectories (id, scope, description, success, duration_ms) VALUES (?, ?, ?, ?, ?)'
      )
      .run('legacy-1', 'unknown', 'an older explicit rollup', 1, 42);
    fixture.close();

    process.env.DATABASE_URL = dbPath;
    const db = getDb();

    const columns = db.prepare('PRAGMA table_info(trajectories)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get('success')!.notnull).toBe(0);
    expect(byName.has('rollup_source')).toBe(true);
    expect(byName.has('session_id')).toBe(true);
    expect(byName.has('tool_calls')).toBe(true);

    // The row survives, and pre-existing rows are explicit rollups.
    const legacy = db.prepare('SELECT * FROM trajectories WHERE id = ?').get('legacy-1') as any;
    expect(legacy.description).toBe('an older explicit rollup');
    expect(legacy.success).toBe(1);
    expect(legacy.duration_ms).toBe(42);
    expect(legacy.rollup_source).toBe('signalled');

    // And a NULL outcome is now storable.
    const sweptId = logTrajectory({
      scope: 'unknown',
      description: 'swept rollup on a migrated store',
      rollupSource: 'swept',
      sessionId: 'sess-migrated',
    });
    const swept = db.prepare('SELECT * FROM trajectories WHERE id = ?').get(sweptId) as any;
    expect(swept.success).toBeNull();
    expect(swept.rollup_source).toBe('swept');

    // Indexes were recreated by the rebuild.
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'trajectories'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain('idx_traj_session');
    expect(indexes).toContain('idx_traj_project');
  });

  it('discovers and sweeps idle sessions whose observations are in observations_archive (Q24)', () => {
    process.env.DATABASE_URL = ':memory:';
    const db = getDb();

    const sessionId = 'sess-archived-idle';
    const fortyDaysAgo = nowSec() - 40 * 86400;
    const tenDaysAgo = nowSec() - 10 * 86400;

    db.prepare(`
      INSERT INTO observations_archive (
        id, original_observation_id, scope, project_id, session_id, agent, kind, tool_name,
        input, output, duration_ms, failed, created_at, archived_at
      ) VALUES (?, ?, 'project', 'proj-sweep', ?, 'claude-code', 'prompt', NULL, 'Archived prompt task', NULL, 100, 0, ?, ?)
    `).run(randomUUID(), 'obs-arc-1', sessionId, fortyDaysAgo, tenDaysAgo);

    db.prepare(`
      INSERT INTO observations_archive (
        id, original_observation_id, scope, project_id, session_id, agent, kind, tool_name,
        input, output, duration_ms, failed, created_at, archived_at
      ) VALUES (?, ?, 'project', 'proj-sweep', ?, 'claude-code', 'tool_call', 'WriteFile', 'some code', 'ok', 250, 0, ?, ?)
    `).run(randomUUID(), 'obs-arc-2', sessionId, fortyDaysAgo + 1, tenDaysAgo);

    const result = sweepIdleSessions({ idleMinutes: 30 });
    expect(result.candidates).toBe(1);
    expect(result.swept).toBe(1);
    expect(result.sessions[0].session_id).toBe(sessionId);
    expect(result.sessions[0].observation_count).toBe(2);
    expect(result.sessions[0].tool_calls).toBe(1);
    expect(result.sessions[0].duration_ms).toBe(350);

    const stored = db.prepare('SELECT * FROM trajectories WHERE session_id = ?').get(sessionId) as any;
    expect(stored).toBeDefined();
    expect(stored.rollup_source).toBe('swept');
    expect(stored.success).toBeNull();
    expect(stored.tool_calls).toBe(1);
    expect(stored.duration_ms).toBe(350);
  });

  it('bounds projected observation blobs and skips if trajectory was concurrently inserted', () => {
    process.env.DATABASE_URL = ':memory:';
    const db = getDb();
    const sessionId = 'sess-bounded-sweep';
    const twoHoursAgo = nowSec() - 7200;

    db.prepare(`
      INSERT INTO observations (
        id, scope, project_id, session_id, agent, kind, tool_name,
        input, output, duration_ms, failed, created_at
      ) VALUES (?, 'project', 'proj-sweep', ?, 'claude-code', 'prompt', NULL, ?, ?, 50, 0, ?)
    `).run('obs_huge_1', sessionId, 'P'.repeat(5000), 'O'.repeat(5000), twoHoursAgo);

    const res = sweepIdleSessions({ idleMinutes: 30 });
    expect(res.swept).toBe(1);

    const stored = db.prepare('SELECT description FROM trajectories WHERE session_id = ?').get(sessionId) as {
      description: string;
    };
    expect(stored.description.length).toBeLessThanOrEqual(1000);
  });
});
