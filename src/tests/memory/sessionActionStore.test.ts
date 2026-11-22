import request from 'supertest';
import { randomUUID } from 'crypto';
import { getDb, resetDb } from '../../lib/db';
import { createApp } from '../../app';
import { verifyOrCreateStoreMeta } from '../../learning/storeMeta';
import { setCustomEmbedder } from '../../learning/embedding';
import {
  startSession,
  endSession,
  getSession,
  listSessions,
  getSessionDetails,
  getLatestSessionSummary,
} from '../../memory/sessionStore';
import {
  createAction,
  getAction,
  listActions,
  getReadyActions,
  getDueActions,
  checkReminders,
  ackReminders,
  updateAction,
} from '../../memory/actionStore';
import { createNote, getNote, listNotes } from '../../memory/noteStore';
import { captureObservations } from '../../memory/observationStore';
import { upsertFailurePattern, getFailurePatterns } from '../../memory/failurePatternStore';

describe('Phase 1+2: Sessions, Next Actions, Provenance, and Lesson Notes', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'none';
    resetDb();
    getDb();
  });

  afterEach(() => {
    resetDb();
    setCustomEmbedder(null);
    process.env = { ...originalEnv };
  });

  describe('sessionStore', () => {
    it('starts a new session and reactivates an existing session id', () => {
      const created = startSession({
        id: 'sess-alpha',
        scope: 'project',
        project_id: 'neuralbrain',
        agent_name: 'claude-code',
        cwd: '/workspace/neuralbrain',
      });

      expect(created.id).toBe('sess-alpha');
      expect(created.scope).toBe('project');
      expect(created.project_id).toBe('neuralbrain');
      expect(created.agent_name).toBe('claude-code');
      expect(created.status).toBe('active');
      expect(created.ended_at).toBeNull();

      const ended = endSession('sess-alpha', {
        status: 'paused',
        summary: 'Paused for review',
      });
      expect(ended?.status).toBe('paused');
      expect(ended?.ended_at).not.toBeNull();

      const reactivated = startSession({
        id: 'sess-alpha',
        scope: 'project',
        project_id: 'neuralbrain',
        agent_name: 'antigravity',
      });
      expect(reactivated.status).toBe('active');
      expect(reactivated.ended_at).toBeNull();
      expect(reactivated.agent_name).toBe('antigravity');
    });

    it('ends a session with an explicit summary, files_touched, and handoff_summary_id', () => {
      startSession({
        id: 'sess-explicit',
        scope: 'project',
        project_id: 'proj-a',
      });

      const ended = endSession('sess-explicit', {
        status: 'completed',
        summary: 'Implemented session handoff endpoints',
        files_touched: ['src/app.ts', 'src/memory/sessionStore.ts'],
        handoff_summary_id: 'sum_123',
      });

      expect(ended).toBeDefined();
      expect(ended?.status).toBe('completed');
      expect(ended?.ended_at).not.toBeNull();
      expect(ended?.summary).toBe('Implemented session handoff endpoints');
      expect(JSON.parse(ended!.files_touched_json!)).toEqual([
        'src/app.ts',
        'src/memory/sessionStore.ts',
      ]);
      expect(ended?.handoff_summary_id).toBe('sum_123');
    });

    it('ends a session with an arithmetic rollup summary from observations when summary is omitted', () => {
      startSession({
        id: 'sess-rollup',
        scope: 'project',
        project_id: 'proj-rollup',
      });

      captureObservations([
        {
          scope: 'project',
          project_id: 'proj-rollup',
          session_id: 'sess-rollup',
          kind: 'tool_call',
          tool_name: 'read_file',
          file_path: 'src/app.ts',
          failed: 0,
        },
        {
          scope: 'project',
          project_id: 'proj-rollup',
          session_id: 'sess-rollup',
          kind: 'tool_call',
          tool_name: 'run_command',
          file_path: 'src/memory/sessionStore.ts',
          failed: 1,
        },
      ]);

      const ended = endSession('sess-rollup');
      expect(ended).toBeDefined();
      expect(ended?.summary).toBe(
        '2 observations (1 errors). Tools: read_file, run_command. Files: src/app.ts, src/memory/sessionStore.ts.'
      );

      // Session with zero observations
      startSession({
        id: 'sess-empty',
        scope: 'global',
      });
      const endedEmpty = endSession('sess-empty');
      expect(endedEmpty?.summary).toBe('0 observations recorded.');

      // Non-existent session returns undefined
      expect(endSession('sess-missing')).toBeUndefined();
    });

    it('reactivates a completed or abandoned session when a new observation arrives', () => {
      startSession({
        id: 'sess-reopen',
        scope: 'project',
        project_id: 'proj-reopen',
        agent_name: 'antigravity',
      });
      const ended = endSession('sess-reopen', { status: 'completed', summary: 'Idle close' });
      expect(ended?.status).toBe('completed');
      expect(ended?.ended_at).toBeTruthy();

      captureObservations([
        {
          scope: 'project',
          project_id: 'proj-reopen',
          session_id: 'sess-reopen',
          kind: 'tool_call',
          tool_name: 'read_file',
          input: 'Resumed next day',
        },
      ]);

      const reopened = getSession('sess-reopen');
      expect(reopened?.status).toBe('active');
      expect(reopened?.ended_at).toBeNull();
    });

    it('lists sessions with filters and returns full session details with provenance', () => {
      startSession({
        id: 'sess-1',
        scope: 'project',
        project_id: 'proj-1',
        agent_name: 'claude',
      });
      startSession({
        id: 'sess-2',
        scope: 'project',
        project_id: 'proj-2',
        agent_name: 'cursor',
      });
      endSession('sess-2', { status: 'completed', summary: 'Done' });

      expect(listSessions({ projectId: 'proj-1' }).map((s) => s.id)).toEqual(['sess-1']);
      expect(listSessions({ status: 'completed' }).map((s) => s.id)).toEqual(['sess-2']);
      expect(listSessions({ agentName: 'claude' }).map((s) => s.id)).toEqual(['sess-1']);

      captureObservations([
        {
          scope: 'project',
          project_id: 'proj-1',
          session_id: 'sess-1',
          kind: 'prompt',
          input: 'Fix auth bug',
        },
      ]);
      createNote({
        scope: 'project',
        projectId: 'proj-1',
        session_id: 'sess-1',
        type: 'lesson',
        title: 'Lesson from sess-1',
        content: 'Always check token expiry',
      });
      createAction({
        scope: 'project',
        project_id: 'proj-1',
        session_id: 'sess-1',
        title: 'Add regression test for auth',
      });

      const details = getSessionDetails('sess-1');
      expect(details).toBeDefined();
      expect(details?.session.id).toBe('sess-1');
      expect(details?.observations).toHaveLength(1);
      expect(details?.notes).toHaveLength(1);
      expect(details?.notes[0].type).toBe('lesson');
      expect(details?.actions).toHaveLength(1);
      expect(getSessionDetails('non-existent')).toBeUndefined();
      expect(getSession('sess-1')?.id).toBe('sess-1');
    });
  });

  describe('actionStore', () => {
    it('creates, lists, and orders ready actions across project and global scope by priority', () => {
      const aLow = createAction({
        scope: 'project',
        project_id: 'proj-act',
        title: 'Low priority task',
        priority: 'low',
        status: 'ready',
      });
      const aGlobalUrgent = createAction({
        scope: 'global',
        title: 'Global urgent task',
        priority: 'urgent',
        status: 'ready',
      });
      const aHighInProgress = createAction({
        scope: 'project',
        project_id: 'proj-act',
        title: 'High in-progress task',
        priority: 'high',
        status: 'in_progress',
      });
      const aBlocked = createAction({
        scope: 'project',
        project_id: 'proj-act',
        title: 'Blocked task',
        priority: 'urgent',
        status: 'blocked',
        blocked_reason: 'Waiting on API key',
      });
      const aOtherProj = createAction({
        scope: 'project',
        project_id: 'other-proj',
        title: 'Other project task',
        priority: 'urgent',
        status: 'ready',
      });
      const aDone = createAction({
        scope: 'project',
        project_id: 'proj-act',
        title: 'Already done',
        status: 'done',
      });

      expect(aDone.resolved_at).not.toBeNull();
      expect(aBlocked.blocked_reason).toBe('Waiting on API key');

      const ready = getReadyActions({ projectId: 'proj-act' });
      expect(ready.map((a) => a.id)).toEqual([
        aGlobalUrgent.id,
        aHighInProgress.id,
        aLow.id,
      ]);
      expect(ready.some((a) => a.id === aBlocked.id)).toBe(false);
      expect(ready.some((a) => a.id === aOtherProj.id)).toBe(false);
      expect(ready.some((a) => a.id === aDone.id)).toBe(false);

      const projectOnly = listActions({
        projectId: 'proj-act',
        includeGlobal: false,
      });
      expect(projectOnly.some((a) => a.id === aGlobalUrgent.id)).toBe(false);
    });

    it('updates actions and manages resolved_at on done/dismissed and reopen', () => {
      startSession({ id: 'sess-resolver', scope: 'project', project_id: 'proj-act' });
      const action = createAction({
        scope: 'project',
        project_id: 'proj-act',
        title: 'Implement health check',
        priority: 'normal',
      });

      expect(action.resolved_at).toBeNull();

      const doneAction = updateAction(action.id, {
        status: 'done',
        resolved_by_session_id: 'sess-resolver',
      });
      expect(doneAction?.status).toBe('done');
      expect(doneAction?.resolved_at).not.toBeNull();
      expect(doneAction?.resolved_by_session_id).toBe('sess-resolver');

      // Reopening clears resolved_at
      const reopened = updateAction(action.id, { status: 'ready' });
      expect(reopened?.status).toBe('ready');
      expect(reopened?.resolved_at).toBeNull();

      // Dismissing sets resolved_at
      const dismissed = updateAction(action.id, { status: 'dismissed' });
      expect(dismissed?.status).toBe('dismissed');
      expect(dismissed?.resolved_at).not.toBeNull();

      expect(getAction(action.id)?.status).toBe('dismissed');
      expect(updateAction('missing-id', { status: 'done' })).toBeUndefined();
    });
  });

  describe('lesson NoteType and session_id provenance', () => {
    it('creates a lesson note with session_id and retrieves it', () => {
      startSession({ id: 'sess-lesson', scope: 'project', project_id: 'proj-lesson' });

      const note = createNote({
        scope: 'project',
        projectId: 'proj-lesson',
        session_id: 'sess-lesson',
        type: 'lesson',
        title: 'Never mock SQLite in integration tests',
        content: 'Use :memory: SQLite so constraints and triggers are exercised.',
        concepts: ['sqlite', 'testing'],
        files: ['src/lib/db.ts'],
      });

      expect(note.type).toBe('lesson');
      expect(note.session_id).toBe('sess-lesson');
      expect(getNote(note.id)?.type).toBe('lesson');
      expect(
        listNotes({ projectId: 'proj-lesson', type: ['lesson'] }).map((n) => n.id)
      ).toEqual([note.id]);
    });

    it('persists session_id in upsertFailurePattern for project and global scopes', () => {
      startSession({ id: 'sess-fp-1', scope: 'project', project_id: 'proj-fp' });
      startSession({ id: 'sess-fp-2', scope: 'global' });

      upsertFailurePattern({
        scope: 'project',
        projectId: 'proj-fp',
        session_id: 'sess-fp-1',
        taskType: 'test',
        errorText: 'ECONNREFUSED 127.0.0.1:6333',
      });

      upsertFailurePattern({
        scope: 'global',
        session_id: 'sess-fp-2',
        taskType: 'build',
        errorText: 'TS2345 Argument of type string',
      });

      const patterns = getFailurePatterns({
        projectId: 'proj-fp',
        includeGlobal: true,
      });

      const projPattern = patterns.find((p) => p.project_id === 'proj-fp');
      const globalPattern = patterns.find((p) => p.scope === 'global');

      expect(projPattern?.session_id).toBe('sess-fp-1');
      expect(globalPattern?.session_id).toBe('sess-fp-2');
    });
  });

  describe('HTTP routes via supertest', () => {
    const testApiKey = 'test_phase12_api_key';
    let app: any;

    beforeEach(() => {
      process.env.BRAIN_REQUIRE_API_KEY = '1';
      const db = getDb();
      db.prepare(
        `
        INSERT INTO api_keys (id, name, key, created_at)
        VALUES (?, 'test-key', ?, datetime('now'))
        `
      ).run(randomUUID(), testApiKey);
      verifyOrCreateStoreMeta();
      app = createApp();
    });

    it('handles session, action, and upgraded /inject HTTP endpoints', async () => {
      const auth = { Authorization: `Bearer ${testApiKey}` };

      // 1. POST /sessions/start
      const startRes = await request(app)
        .post('/sessions/start')
        .set(auth)
        .send({
          id: 'http-sess-1',
          scope: 'project',
          project_id: 'http-proj',
          agent_name: 'qa-agent',
          cwd: '/tmp/http-proj',
        });
      expect(startRes.status).toBe(201);
      expect(startRes.body.session.id).toBe('http-sess-1');
      expect(startRes.body.session.status).toBe('active');

      // 2. POST /actions
      const createActRes = await request(app)
        .post('/actions')
        .set(auth)
        .send({
          scope: 'project',
          project_id: 'http-proj',
          session_id: 'http-sess-1',
          title: 'Verify /inject payload',
          description: 'Ensure ready_actions and lessons are returned',
          priority: 'high',
        });
      expect(createActRes.status).toBe(201);
      const actionId = createActRes.body.action.id;
      expect(createActRes.body.action.status).toBe('ready');

      // Create a second action and mark it done via PATCH /actions/:id
      const createAct2Res = await request(app)
        .post('/actions')
        .set(auth)
        .send({
          scope: 'project',
          project_id: 'http-proj',
          session_id: 'http-sess-1',
          title: 'Completed setup step',
          priority: 'normal',
        });
      expect(createAct2Res.status).toBe(201);
      const action2Id = createAct2Res.body.action.id;

      const patchActRes = await request(app)
        .patch(`/actions/${action2Id}`)
        .set(auth)
        .send({
          status: 'done',
          resolved_by_session_id: 'http-sess-1',
        });
      expect(patchActRes.status).toBe(200);
      expect(patchActRes.body.action.status).toBe('done');
      expect(patchActRes.body.action.resolved_at).not.toBeNull();

      // 3. GET /actions
      const listActRes = await request(app)
        .get('/actions?project_id=http-proj&status=ready')
        .set(auth);
      expect(listActRes.status).toBe(200);
      expect(listActRes.body.actions.map((a: any) => a.id)).toEqual([actionId]);

      // 4. Create a lesson note and an architecture note linked to the session
      const noteRes = await request(app)
        .post('/notes')
        .set(auth)
        .send({
          scope: 'project',
          project_id: 'http-proj',
          session_id: 'http-sess-1',
          type: 'lesson',
          title: 'Use supertest against createApp()',
          content: 'Always verify HTTP status codes and JSON shape.',
        });
      expect(noteRes.status).toBe(201);

      const archNoteRes = await request(app)
        .post('/notes')
        .set(auth)
        .send({
          scope: 'project',
          project_id: 'http-proj',
          session_id: 'http-sess-1',
          type: 'architecture',
          title: 'Single writer SQLite',
          content: 'Only the brain service opens brain.db for writing.',
        });
      expect(archNoteRes.status).toBe(201);

      // 5. POST /sessions/:id/end
      const endRes = await request(app)
        .post('/sessions/http-sess-1/end')
        .set(auth)
        .send({
          status: 'completed',
          summary: 'Finished QA setup for http-proj',
          files_touched: ['src/app.ts'],
        });
      expect(endRes.status).toBe(200);
      expect(endRes.body.session.status).toBe('completed');
      expect(endRes.body.session.summary).toBe('Finished QA setup for http-proj');

      // 6. GET /sessions and GET /sessions/:id
      const listSessRes = await request(app)
        .get('/sessions?project_id=http-proj&status=completed')
        .set(auth);
      expect(listSessRes.status).toBe(200);
      expect(listSessRes.body.sessions).toHaveLength(1);

      const detailsRes = await request(app)
        .get('/sessions/http-sess-1')
        .set(auth);
      expect(detailsRes.status).toBe(200);
      expect(detailsRes.body.session.id).toBe('http-sess-1');
      expect(detailsRes.body.notes).toHaveLength(2);
      expect(detailsRes.body.actions).toHaveLength(2);

      // 7. GET /inject returns upgraded fields with partitioned lessons vs notes
      const injectRes = await request(app)
        .get('/inject?project_id=http-proj&limit=5')
        .set(auth);
      expect(injectRes.status).toBe(200);
      expect(Array.isArray(injectRes.body.ready_actions)).toBe(true);
      expect(injectRes.body.ready_actions.map((a: any) => a.id)).toEqual([actionId]);
      expect(injectRes.body.latest_session_summary).toBeDefined();
      expect(injectRes.body.latest_session_summary.summary).toBe(
        'Finished QA setup for http-proj'
      );
      expect(Array.isArray(injectRes.body.lessons)).toBe(true);
      expect(injectRes.body.lessons.some((n: any) => n.type === 'lesson')).toBe(true);
      expect(injectRes.body.lessons.some((n: any) => n.type === 'architecture')).toBe(false);
      expect(Array.isArray(injectRes.body.notes)).toBe(true);
      expect(injectRes.body.notes.some((n: any) => n.type === 'architecture')).toBe(true);
      expect(injectRes.body.notes.some((n: any) => n.type === 'lesson')).toBe(false);
    });
  });

  describe('scope upgrade/mismatch, secret redaction, and bounded session details', () => {
    it('upgrades unknown session scope on reactivation and rejects mismatched non-unknown scope', () => {
      const unknownSess = startSession({
        id: 'sess-upgrade',
        scope: 'unknown',
      });
      expect(unknownSess.scope).toBe('unknown');

      const upgraded = startSession({
        id: 'sess-upgrade',
        scope: 'project',
        project_id: 'proj-upgraded',
      });
      expect(upgraded.scope).toBe('project');
      expect(upgraded.project_id).toBe('proj-upgraded');

      expect(() =>
        startSession({
          id: 'sess-upgrade',
          scope: 'project',
          project_id: 'proj-other',
        })
      ).toThrow(/conflicts|already exists/i);

      expect(() =>
        startSession({
          id: 'sess-upgrade',
          scope: 'global',
        })
      ).toThrow(/conflicts|already exists/i);
    });

    it('redacts secrets in endSession summary and actionStore createAction/updateAction', () => {
      const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456';
      startSession({ id: 'sess-redact', scope: 'global' });
      const ended = endSession('sess-redact', {
        summary: `Completed with key ${secret}`,
      });
      expect(ended?.summary).not.toContain(secret);
      expect(ended?.summary).toContain('[REDACTED_API_KEY]');

      const act = createAction({
        scope: 'global',
        title: `Rotate ${secret}`,
        description: 'Use ghp_abcdefghijklmnopqrstuvwxyz123456',
        blocked_reason: 'Waiting on Bearer abcdefghijklmnopqrstuvwxyz123456',
      });
      expect(act.title).toContain('[REDACTED_API_KEY]');
      expect(act.description).toContain('[REDACTED_TOKEN]');
      expect(act.blocked_reason).toContain('Bearer [REDACTED_TOKEN]');

      const updated = updateAction(act.id, {
        title: `Updated ${secret}`,
        description: `Desc ${secret}`,
        blocked_reason: `Blocked ${secret}`,
      });
      expect(updated?.title).not.toContain(secret);
      expect(updated?.description).not.toContain(secret);
      expect(updated?.blocked_reason).not.toContain(secret);
    });

    it('bounds getSessionDetails, omits note embeddings, and truncates oversized obs previews', () => {
      const db = getDb();
      startSession({ id: 'sess-bound', scope: 'project', project_id: 'proj-bound' });

      const bigText = 'x'.repeat(2500);
      captureObservations([
        {
          scope: 'project',
          project_id: 'proj-bound',
          session_id: 'sess-bound',
          kind: 'tool_call',
          tool_name: 'read_file',
          input: bigText,
          output: bigText,
        },
        {
          scope: 'project',
          project_id: 'proj-bound',
          session_id: 'sess-bound',
          kind: 'tool_call',
          tool_name: 'run_command',
          input: 'small',
          output: 'small',
        },
      ]);

      const note = createNote({
        scope: 'project',
        projectId: 'proj-bound',
        sessionId: 'sess-bound',
        type: 'fact',
        title: 'Session note',
        content: 'Body',
      });
      db.prepare('UPDATE notes SET embedding = ? WHERE id = ?').run(
        Buffer.from(new Float32Array([1, 2, 3, 4]).buffer),
        note.id
      );

      const limited = getSessionDetails('sess-bound', { limit: 1, offset: 0 });
      expect(limited?.observations).toHaveLength(1);
      expect(limited?.observations[0].input).toHaveLength(2000 + '... [truncated]'.length);
      expect(limited?.observations[0].input?.endsWith('... [truncated]')).toBe(true);
      expect(limited?.observations[0].output?.endsWith('... [truncated]')).toBe(true);
      expect(limited?.notes).toHaveLength(1);
      expect('embedding' in limited!.notes[0]).toBe(false);
    });
  });

  describe('Hierarchical scoping, reminders, recurrence, and user_id/agent_id', () => {
    it('supports user_id/agent_id, hierarchical listSessions, and ancestor fallback in getLatestSessionSummary', () => {
      startSession({
        id: 'sess-root',
        scope: 'project',
        project_id: 'acme',
        user_id: 'alice',
        agent_id: 'claude',
      });
      endSession('sess-root', { status: 'completed', summary: 'Root summary' });

      startSession({
        id: 'sess-mid',
        scope: 'project',
        project_id: 'acme/socials',
        user_id: 'bob',
        agent_id: 'cursor',
      });
      endSession('sess-mid', { status: 'completed', summary: 'Mid summary' });

      startSession({
        id: 'sess-global',
        scope: 'global',
        user_id: 'alice',
        agent_id: 'claude',
      });

      // Default listSessions({ projectId }) includes ancestors and excludes global
      const forLeaf = listSessions({ projectId: 'acme/socials/calendar' });
      expect(forLeaf.map((s) => s.id).sort()).toEqual(['sess-mid', 'sess-root']);
      expect(forLeaf.every((s) => s.match_tier === 'ancestor')).toBe(true);

      // includeGlobal=true includes global sessions
      const withGlobal = listSessions({ projectId: 'acme/socials/calendar', includeGlobal: true });
      expect(withGlobal.find((s) => s.id === 'sess-global')?.match_tier).toBe('global');

      // userId filter without projectId returns user's sessions across projects and global
      const aliceSessions = listSessions({ userId: 'alice' });
      expect(aliceSessions.map((s) => s.id).sort()).toEqual(['sess-global', 'sess-root']);

      // getLatestSessionSummary falls back through closest ancestor unless includeAncestors=false
      expect(getLatestSessionSummary('acme/socials/calendar')?.id).toBe('sess-mid');
      expect(
        getLatestSessionSummary('acme/socials/calendar', { includeAncestors: false })
      ).toBeNull();

      // Exact project wins over ancestor
      startSession({
        id: 'sess-leaf',
        scope: 'project',
        project_id: 'acme/socials/calendar',
        user_id: 'alice',
      });
      endSession('sess-leaf', { status: 'completed', summary: 'Leaf summary' });
      expect(getLatestSessionSummary('acme/socials/calendar')?.id).toBe('sess-leaf');
    });

    it('creates actions with reminder fields, omits embedding BLOB, and enqueues for embedding on create and text/status updates', () => {
      const db = getDb();
      const act = createAction({
        scope: 'project',
        project_id: 'acme/cogs',
        user_id: 'alice',
        agent_id: 'claude',
        title: 'Rotate staging key',
        due_at: '2026-11-23T10:00:00-02:00',
        remind_at: '2026-11-23T09:30:00-02:00',
        recurrence: '@daily',
      });

      expect(act.user_id).toBe('alice');
      expect(act.agent_id).toBe('claude');
      expect(act.due_at).toBe('2026-11-23T12:00:00.000Z');
      expect(act.remind_at).toBe('2026-11-23T11:30:00.000Z');
      expect(act.recurrence).toBe('0 0 * * *');
      expect('embedding' in act).toBe(false);

      const queueRow = db
        .prepare("SELECT status FROM embed_queue WHERE record_id = ? AND record_type = 'action'")
        .get(act.id) as { status: string } | undefined;
      expect(queueRow?.status).toBe('pending');

      // Mark queue done, verify snooze_until update does NOT re-enqueue while title update DOES
      db.prepare("UPDATE embed_queue SET status = 'done' WHERE record_id = ?").run(act.id);
      updateAction(act.id, { snooze_until: '2026-11-23T11:45:00Z' });
      const afterSnooze = db
        .prepare("SELECT status FROM embed_queue WHERE record_id = ? AND record_type = 'action'")
        .get(act.id) as { status: string };
      expect(afterSnooze.status).toBe('done');

      updateAction(act.id, { title: 'Rotate staging key immediately' });
      const afterTitle = db
        .prepare("SELECT status FROM embed_queue WHERE record_id = ? AND record_type = 'action'")
        .get(act.id) as { status: string };
      expect(afterTitle.status).toBe('pending');

      // Verify embedding BLOB is never returned even when populated in SQLite
      db.prepare('UPDATE actions SET embedding = ? WHERE id = ?').run(
        Buffer.from(new Float32Array([1, 2, 3, 4]).buffer),
        act.id
      );
      expect('embedding' in getAction(act.id)!).toBe(false);
      expect('embedding' in listActions({ projectId: 'acme/cogs' })[0]).toBe(false);

      expect(() =>
        createAction({
          scope: 'global',
          title: 'Invalid recurrence',
          recurrence: 'every other blue moon',
        })
      ).toThrow(/Cron expression|Invalid/);
    });

    it('supports getDueActions, checkReminders (dryRun + cooldown), ackReminders, and snooze_until', () => {
      const past2h = new Date(Date.now() - 2 * 3_600_000).toISOString();
      const past1h = new Date(Date.now() - 3_600_000).toISOString();
      const future2h = new Date(Date.now() + 2 * 3_600_000).toISOString();

      const overdueAct = createAction({
        scope: 'project',
        project_id: 'acme',
        user_id: 'alice',
        title: 'Overdue ancestor action',
        priority: 'normal',
        due_at: past1h,
        remind_at: past2h,
      });

      const remindedOnlyAct = createAction({
        scope: 'project',
        project_id: 'acme/socials',
        user_id: 'alice',
        title: 'Upcoming due with past remind_at',
        priority: 'urgent',
        due_at: future2h,
        remind_at: past1h,
      });

      const snoozedAct = createAction({
        scope: 'project',
        project_id: 'acme/socials',
        title: 'Snoozed action',
        due_at: past2h,
        snooze_until: future2h,
      });

      const due = getDueActions({ projectId: 'acme/socials/calendar', userId: 'alice' });
      expect(due.map((a) => a.id)).toEqual([overdueAct.id, remindedOnlyAct.id]);
      expect(due[0].overdue).toBe(true);
      expect(due[0].match_tier).toBe('ancestor');
      expect(due[1].overdue).toBe(false);
      expect(due.some((a) => a.id === snoozedAct.id)).toBe(false);

      // listActions dueOnly and before
      const listedDue = listActions({ projectId: 'acme/socials/calendar', dueOnly: true });
      expect(listedDue.map((a) => a.id)).toEqual([remindedOnlyAct.id, overdueAct.id]);

      // dryRun check does not stamp last_reminded_at
      const dryRes = checkReminders({ projectId: 'acme/socials/calendar', dryRun: true });
      expect(dryRes.marked_count).toBe(0);
      expect(dryRes.reminders).toHaveLength(2);
      expect(getAction(overdueAct.id)?.last_reminded_at).toBeNull();

      // real check stamps last_reminded_at
      const checkRes = checkReminders({ projectId: 'acme/socials/calendar' });
      expect(checkRes.marked_count).toBe(2);
      expect(getAction(overdueAct.id)?.last_reminded_at).not.toBeNull();

      // subsequent check without cooldown returns empty
      expect(checkReminders({ projectId: 'acme/socials/calendar' }).reminders).toHaveLength(0);

      // with large cooldown still skipped; after backdating last_reminded_at, cooldown allows re-remind
      expect(
        checkReminders({ projectId: 'acme/socials/calendar', cooldownMs: 60_000 }).reminders
      ).toHaveLength(0);

      const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
      const acked = ackReminders([overdueAct.id], twoHoursAgo);
      expect(acked.updated).toBe(1);
      expect(acked.reminded_at).toBe(twoHoursAgo);

      const reReminded = checkReminders({
        projectId: 'acme/socials/calendar',
        cooldownMs: 3_600_000,
      });
      expect(reReminded.reminders.map((r) => r.id)).toEqual([overdueAct.id]);
    });

    it('spawns next_occurrence with preserved lead offset when completing a recurring action', () => {
      const db = getDb();
      const recurring = createAction({
        scope: 'project',
        project_id: 'acme/cogs',
        user_id: 'alice',
        agent_id: 'claude',
        title: 'Weekly digest',
        description: 'Send team digest',
        priority: 'high',
        due_at: '2026-11-22T10:00:00.000Z',
        remind_at: '2026-11-22T09:30:00.000Z',
        recurrence: 'P1W',
      });

      const updated = updateAction(recurring.id, { status: 'done' });
      expect(updated?.status).toBe('done');
      expect(updated?.next_occurrence).toBeDefined();
      const next = updated!.next_occurrence!;
      expect(next.parent_action_id).toBe(recurring.id);
      expect(next.status).toBe('ready');
      expect(next.user_id).toBe('alice');
      expect(next.agent_id).toBe('claude');
      expect(next.recurrence).toBe('P1W');
      expect(next.due_at).toBe('2026-11-29T10:00:00.000Z');
      expect(next.remind_at).toBe('2026-11-29T09:30:00.000Z');
      expect(next.last_reminded_at).toBeNull();
      expect(next.snooze_until).toBeNull();

      const qRow = db
        .prepare("SELECT status FROM embed_queue WHERE record_id = ? AND record_type = 'action'")
        .get(next.id) as { status: string } | undefined;
      expect(qRow?.status).toBe('pending');
    });
  });
});
