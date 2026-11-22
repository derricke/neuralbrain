import request from 'supertest';
import { randomUUID } from 'crypto';
import { getDb, resetDb } from '../../lib/db';
import { transaction } from '../../lib/sqlite';
import { createApp } from '../../app';
import { verifyOrCreateStoreMeta } from '../../learning/storeMeta';
import { setCustomEmbedder } from '../../learning/embedding';
import { getKnowledgeGraph } from '../../memory/graphStore';
import { startSession, endSession, getSessionReplay } from '../../memory/sessionStore';
import { createAction } from '../../memory/actionStore';
import { createNote } from '../../memory/noteStore';
import { captureObservations } from '../../memory/observationStore';

describe('Phase 3+4: Knowledge Graph, Session Replay, and Dashboard Alignment', () => {
  const originalEnv = { ...process.env };
  const testApiKey = 'test_phase34_api_key';
  const auth = { Authorization: `Bearer ${testApiKey}` };

  function setupAuthedApp() {
    process.env.BRAIN_REQUIRE_API_KEY = '1';
    const db = getDb();
    db.prepare(
      `
      INSERT INTO api_keys (id, name, key, created_at)
      VALUES (?, 'test-phase34-key', ?, datetime('now'))
      `
    ).run(randomUUID(), testApiKey);
    verifyOrCreateStoreMeta();
    return createApp();
  }

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

  describe('graphStore.getKnowledgeGraph', () => {
    it('builds all expected node types and edge types', () => {
      const db = getDb();

      startSession({
        id: 'sess-graph-1',
        scope: 'project',
        project_id: 'proj-graph',
        agent_name: 'claude-code',
      });

      const baseNote = createNote({
        id: 'note-base-1',
        scope: 'project',
        projectId: 'proj-graph',
        sessionId: 'sess-graph-1',
        type: 'fact',
        title: 'WAL mode invariant',
        content: 'SQLite runs in WAL mode with foreign_keys = ON.',
        concepts: ['sqlite', 'wal'],
        files: ['src/lib/db.ts'],
      });

      const lessonNote = createNote({
        id: 'note-lesson-1',
        scope: 'project',
        projectId: 'proj-graph',
        sessionId: 'sess-graph-1',
        type: 'lesson',
        title: 'Never bypass embed_queue',
        content: 'Direct SQLite writes skip vector indexing.',
        supersedes: baseNote.id,
      });

      const action = createAction({
        id: 'act-graph-1',
        scope: 'project',
        project_id: 'proj-graph',
        session_id: 'sess-graph-1',
        title: 'Verify graph endpoint',
        priority: 'high',
      });

      db.prepare(
        `
        INSERT INTO summaries (id, scope, project_id, kind, outcome, producer_tier, prompt_version, verified)
        VALUES ('sum-graph-1', 'project', 'proj-graph', 'session', 'success', 'agent', 'v1', 1)
        `
      ).run();

      db.prepare(
        `
        INSERT INTO summary_claims (id, summary_id, text, ordinal)
        VALUES ('claim-graph-1', 'sum-graph-1', 'WAL mode is enabled.', 0)
        `
      ).run();

      db.prepare(
        `
        INSERT INTO summary_sources (summary_id, claim_id, record_id, record_type)
        VALUES ('sum-graph-1', 'claim-graph-1', ?, 'note')
        `
      ).run(baseNote.id);

      const graph = getKnowledgeGraph();

      expect(graph.stats.nodeCount).toBe(graph.nodes.length);
      expect(graph.stats.edgeCount).toBe(graph.edges.length);

      const nodeTypes = new Set(graph.nodes.map((n) => n.type));
      expect(nodeTypes).toEqual(
        new Set(['note', 'lesson', 'concept', 'file', 'session', 'action', 'summary'])
      );

      expect(graph.nodes.find((n) => n.id === baseNote.id)?.type).toBe('note');
      expect(graph.nodes.find((n) => n.id === lessonNote.id)?.type).toBe('lesson');
      expect(graph.nodes.find((n) => n.id === 'concept:sqlite')?.type).toBe('concept');
      expect(graph.nodes.find((n) => n.id === 'file:src/lib/db.ts')?.type).toBe('file');
      expect(graph.nodes.find((n) => n.id === 'sess-graph-1')?.type).toBe('session');
      expect(graph.nodes.find((n) => n.id === action.id)?.type).toBe('action');
      expect(graph.nodes.find((n) => n.id === 'sum-graph-1')?.type).toBe('summary');

      const hasEdge = (source: string, target: string, type: string) =>
        graph.edges.some((e) => e.source === source && e.target === target && e.type === type);

      expect(hasEdge(baseNote.id, 'concept:sqlite', 'has_concept')).toBe(true);
      expect(hasEdge(baseNote.id, 'concept:wal', 'has_concept')).toBe(true);
      expect(hasEdge(baseNote.id, 'file:src/lib/db.ts', 'touches_file')).toBe(true);
      expect(hasEdge(lessonNote.id, baseNote.id, 'supersedes')).toBe(true);
      expect(hasEdge(baseNote.id, 'sess-graph-1', 'from_session')).toBe(true);
      expect(hasEdge(lessonNote.id, 'sess-graph-1', 'from_session')).toBe(true);
      expect(hasEdge(action.id, 'sess-graph-1', 'from_session')).toBe(true);
      expect(hasEdge('sum-graph-1', baseNote.id, 'cites_source')).toBe(true);
    });

    it('filters by projectId and scope', () => {
      createNote({
        id: 'note-p1',
        scope: 'project',
        projectId: 'proj-alpha',
        type: 'fact',
        title: 'Alpha note',
        content: 'Alpha content',
      });
      createNote({
        id: 'note-p2',
        scope: 'project',
        projectId: 'proj-beta',
        type: 'fact',
        title: 'Beta note',
        content: 'Beta content',
      });
      createNote({
        id: 'note-g1',
        scope: 'global',
        type: 'pattern',
        title: 'Global pattern',
        content: 'Global content',
      });

      const alphaGraph = getKnowledgeGraph({ projectId: 'proj-alpha' });
      expect(alphaGraph.nodes.map((n) => n.id)).toEqual(['note-p1']);

      const globalGraph = getKnowledgeGraph({ scope: 'global' });
      expect(globalGraph.nodes.map((n) => n.id)).toEqual(['note-g1']);

      const combinedGraph = getKnowledgeGraph({ projectId: 'proj-beta', scope: 'project' });
      expect(combinedGraph.nodes.map((n) => n.id)).toEqual(['note-p2']);
    });

    it('clamps limit (default 80, max 200, non-positive and NaN fall back to 80)', () => {
      const db = getDb();
      const insert = db.prepare(
        `
        INSERT INTO notes (id, scope, project_id, type, title, content)
        VALUES (?, 'project', 'proj-limit', 'fact', ?, 'body')
        `
      );
      const insertMany = transaction(db, () => {
        for (let i = 0; i < 205; i++) {
          insert.run(`note-lim-${i}`, `Note ${i}`);
        }
      });
      insertMany();

      expect(getKnowledgeGraph({ projectId: 'proj-limit' }).nodes).toHaveLength(80);
      expect(getKnowledgeGraph({ projectId: 'proj-limit', limit: 0 }).nodes).toHaveLength(80);
      expect(getKnowledgeGraph({ projectId: 'proj-limit', limit: -10 }).nodes).toHaveLength(80);
      expect(getKnowledgeGraph({ projectId: 'proj-limit', limit: Number.NaN }).nodes).toHaveLength(
        80
      );
      expect(getKnowledgeGraph({ projectId: 'proj-limit', limit: 5 }).nodes).toHaveLength(5);
      expect(getKnowledgeGraph({ projectId: 'proj-limit', limit: 500 }).nodes).toHaveLength(200);
    });

    it('resolves cites_source edges to observation nodes within budget', () => {
      const db = getDb();
      const cap = captureObservations([
        {
          id: 'obs-graph-cited',
          scope: 'project',
          project_id: 'proj-obs-graph',
          kind: 'tool_call',
          tool_name: 'run_command',
          input: 'npm test',
          output: 'ok',
        },
      ]);
      expect(cap.accepted).toBe(1);

      db.prepare(
        `
        INSERT INTO summaries (id, scope, project_id, kind, outcome, producer_tier, prompt_version, verified)
        VALUES ('sum-obs-1', 'project', 'proj-obs-graph', 'session', 'success', 'agent', 'v1', 1)
        `
      ).run();
      db.prepare(
        `
        INSERT INTO summary_sources (summary_id, claim_id, record_id, record_type)
        VALUES ('sum-obs-1', NULL, 'obs-graph-cited', 'observation')
        `
      ).run();

      const graph = getKnowledgeGraph({ projectId: 'proj-obs-graph' });
      expect(graph.nodes.some((n) => n.id === 'obs-graph-cited' && n.type === 'observation')).toBe(true);
      expect(
        graph.edges.some(
          (e) => e.source === 'sum-obs-1' && e.target === 'obs-graph-cited' && e.type === 'cites_source'
        )
      ).toBe(true);
    });
  });

  describe('sessionStore.getSessionReplay & GET /sessions/:id/replay', () => {
    it('returns chronological timeline of observation, note, and action sorted ascending by timestamp', async () => {
      const db = getDb();
      const app = setupAuthedApp();

      startSession({
        id: 'sess-replay-1',
        scope: 'project',
        project_id: 'proj-replay',
        agent_name: 'qa-agent',
      });

      // Insert out of chronological order to verify sorting
      // 3rd: note at 2026-11-13T01:00:30.000Z (unix 1794531630)
      createNote({
        id: 'note-rep-1',
        scope: 'project',
        projectId: 'proj-replay',
        sessionId: 'sess-replay-1',
        type: 'lesson',
        title: 'Replay lesson',
        content: 'Learned something important.',
        createdAt: 1794531630,
        updatedAt: 1794531630,
      });

      // 1st: observation at 2026-11-13T01:00:10.000Z (unix 1794531610)
      const cap = captureObservations([
        {
          id: 'obs-rep-1',
          session_id: 'sess-replay-1',
          scope: 'project',
          project_id: 'proj-replay',
          kind: 'tool_call',
          tool_name: 'read_file',
          file_path: 'src/app.ts',
          input: 'read src/app.ts',
          output: 'ok',
          duration_ms: 12,
          failed: false,
        },
      ]);
      expect(cap.accepted).toBe(1);
      db.prepare('UPDATE observations SET created_at = ? WHERE id = ?').run(
        1794531610,
        'obs-rep-1'
      );

      // 2nd: action at 2026-11-13T01:00:20.000Z
      const action = createAction({
        id: 'act-rep-1',
        scope: 'project',
        project_id: 'proj-replay',
        session_id: 'sess-replay-1',
        title: 'Run replay test',
        description: 'Verify chronological ordering',
        status: 'ready',
      });
      db.prepare('UPDATE actions SET created_at = ? WHERE id = ?').run(
        '2026-11-13 01:00:20',
        action.id
      );

      const replay = getSessionReplay('sess-replay-1');
      expect(replay).toBeDefined();
      expect(replay!.session.id).toBe('sess-replay-1');
      expect(replay!.timeline.map((t) => t.kind)).toEqual(['observation', 'action', 'note']);
      expect(replay!.timeline.map((t) => t.id)).toEqual(['obs-rep-1', 'act-rep-1', 'note-rep-1']);
      expect(replay!.timeline[0].timestamp < replay!.timeline[1].timestamp).toBe(true);
      expect(replay!.timeline[1].timestamp < replay!.timeline[2].timestamp).toBe(true);

      const res = await request(app)
        .get('/sessions/sess-replay-1/replay')
        .set(auth)
        .expect(200);
      expect(res.body.session.id).toBe('sess-replay-1');
      expect(res.body.timeline).toHaveLength(3);
      expect(res.body.timeline.map((t: any) => t.kind)).toEqual([
        'observation',
        'action',
        'note',
      ]);
    });

    it('returns undefined from store and 404 from GET /sessions/:id/replay when session does not exist', async () => {
      const app = setupAuthedApp();

      expect(getSessionReplay('non-existent-session')).toBeUndefined();

      const res = await request(app)
        .get('/sessions/non-existent-session/replay')
        .set(auth)
        .expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('Graph & Dashboard HTTP routes', () => {
    it('GET /graph and GET /dashboard/api/graph return scoped knowledge graph', async () => {
      const app = setupAuthedApp();

      createNote({
        id: 'note-http-1',
        scope: 'project',
        projectId: 'proj-http',
        type: 'fact',
        title: 'HTTP graph node',
        content: 'Graph endpoint test',
        concepts: ['http'],
      });
      createNote({
        id: 'note-http-other',
        scope: 'global',
        type: 'fact',
        title: 'Other node',
        content: 'Should be filtered out',
      });

      const graphRes = await request(app)
        .get('/graph?project_id=proj-http&scope=project&limit=10')
        .set(auth)
        .expect(200);
      expect(graphRes.body.nodes.map((n: any) => n.id)).toEqual(['note-http-1', 'concept:http']);
      expect(graphRes.body.edges).toEqual([
        { source: 'note-http-1', target: 'concept:http', type: 'has_concept' },
      ]);
      expect(graphRes.body.stats).toEqual({ nodeCount: 2, edgeCount: 1 });

      const dashGraphRes = await request(app)
        .get('/dashboard/api/graph?project_id=proj-http&scope=project&limit=10')
        .set(auth)
        .expect(200);
      expect(dashGraphRes.body).toEqual(graphRes.body);
    });

    it('GET /dashboard/api/stats returns sessions, actions, and lessonsCount alongside existing fields', async () => {
      const app = setupAuthedApp();

      startSession({ id: 'sess-s1', scope: 'project', project_id: 'proj-stats' });
      startSession({ id: 'sess-s2', scope: 'project', project_id: 'proj-stats' });
      endSession('sess-s2', { status: 'completed', summary: 'Done' });

      createAction({
        id: 'act-s1',
        scope: 'project',
        project_id: 'proj-stats',
        title: 'Ready task',
        status: 'ready',
      });
      createAction({
        id: 'act-s2',
        scope: 'project',
        project_id: 'proj-stats',
        title: 'Blocked task',
        status: 'blocked',
        blocked_reason: 'Waiting on review',
      });

      createNote({
        id: 'note-l1',
        scope: 'project',
        projectId: 'proj-stats',
        type: 'lesson',
        title: 'Lesson 1',
        content: 'Content',
      });
      createNote({
        id: 'note-b1',
        scope: 'project',
        projectId: 'proj-stats',
        type: 'bug',
        title: 'Bug 1',
        content: 'Content',
      });
      createNote({
        id: 'note-f1',
        scope: 'project',
        projectId: 'proj-stats',
        type: 'fact',
        title: 'Fact 1',
        content: 'Content',
      });

      const res = await request(app).get('/dashboard/api/stats').set(auth).expect(200);

      expect(res.body.health).toBeDefined();
      expect(res.body.counts).toBeDefined();
      expect(res.body.recent_notes).toBeDefined();
      expect(res.body.recent_observations).toBeDefined();

      expect(res.body.sessions).toEqual({
        total: 2,
        active: 1,
        completed: 1,
        abandoned: 0,
      });

      expect(res.body.actions).toEqual({
        total: 2,
        ready: 1,
        blocked: 1,
        in_progress: 0,
        done: 0,
      });

      expect(res.body.lessonsCount).toBe(2);
    });

    it('GET /dashboard HTML contains Long Term, Short Term, Observations, and Graph tabs', async () => {
      verifyOrCreateStoreMeta();
      const app = createApp();

      const res = await request(app).get('/dashboard').expect(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('Long Term');
      expect(res.text).toContain('Short Term');
      expect(res.text).toContain('Observations');
      expect(res.text).toContain('Graph');
    });
  });
});
