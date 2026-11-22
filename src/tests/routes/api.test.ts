import request from 'supertest';
import { randomUUID } from 'crypto';
import { getDb, resetDb } from '../../lib/db';
import { createApp } from '../../app';
import { verifyOrCreateStoreMeta } from '../../learning/storeMeta';
import { setCustomEmbedder } from '../../learning/embedding';

describe('HTTP API routes', () => {
  const originalEnv = { ...process.env };
  let app: any;
  const testApiKey = 'test_api_key_12345';

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_REQUIRE_API_KEY = '1';
    process.env.BRAIN_EMBED = 'none'; // Fast BM25 mode for router tests
    resetDb();

    // Seed test API key
    const db = getDb();
    db.prepare(`
      INSERT INTO api_keys (id, name, key, created_at)
      VALUES (?, 'test-key', ?, datetime('now'))
    `).run(randomUUID(), testApiKey);

    verifyOrCreateStoreMeta();
    app = createApp();
  });

  afterEach(() => {
    resetDb();
    setCustomEmbedder(null);
    process.env = { ...originalEnv };
  });

  it('GET /health is unauthenticated and reports status and store_meta', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('ok');
    expect(res.body.store_meta).toBeDefined();
    expect(res.body.store_meta.match).toBe(true);
    expect(res.body.embed_queue_pending).toBeDefined();
  });

  it('enforces authentication on protected routes (401 without Bearer token)', async () => {
    const unauthedRes = await request(app).get('/notes');
    expect(unauthedRes.status).toBe(401);
    expect(unauthedRes.body.error).toBeDefined();
    expect(unauthedRes.body.error.code).toBe('UNAUTHORIZED');

    const invalidKeyRes = await request(app)
      .get('/notes')
      .set('Authorization', 'Bearer invalid_key_9999');
    expect(invalidKeyRes.status).toBe(401);

    const authedRes = await request(app)
      .get('/notes')
      .set('Authorization', `Bearer ${testApiKey}`);
    expect(authedRes.status).toBe(200);
  });

  it('allows /capture/observations to survive >200 calls in a minute without 429', async () => {
    // 205 sequential capture calls
    for (let i = 0; i < 205; i++) {
      const res = await request(app)
        .post('/capture/observations')
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({
          observations: [
            {
              scope: 'project',
              project_id: 'stress-test',
              session_id: 'sess-stress',
              kind: 'tool_call',
              tool_name: 'Edit',
              file_path: 'src/stress.ts',
              input: `edit ${i}`,
              output: 'ok',
              duration_ms: 10,
              failed: 0,
            },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.accepted).toBe(1);
    }
  }, 60000); // 205 sequential round trips by design — proves rule 3, needs room under parallel load

  it('handles /capture/trajectories, /inject, /maintenance/cleanup, /maintenance/reembed', async () => {
    // 1. Capture trajectory
    const trajRes = await request(app)
      .post('/capture/trajectories')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        trajectories: [
          {
            scope: 'project',
            projectId: 'proj-inject',
            taskType: 'build',
            description: 'Run build command',
            result: 'Build succeeded',
            success: true,
          },
        ],
      });
    expect(trajRes.status).toBe(201);
    expect(trajRes.body.accepted).toBe(1);

    // 2. Create note
    const noteRes = await request(app)
      .post('/notes')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        scope: 'project',
        projectId: 'proj-inject',
        type: 'bug',
        title: 'Webpack out of memory',
        content: 'Webpack fails when node heap limit is under 2GB',
        files: ['webpack.config.js'],
      });
    expect(noteRes.status).toBe(201);

    // 3. Test /files/:path/notes
    const fileNotesRes = await request(app)
      .get('/files/webpack.config.js/notes')
      .set('Authorization', `Bearer ${testApiKey}`);
    expect(fileNotesRes.status).toBe(200);
    expect(fileNotesRes.body.length).toBe(1);
    expect(fileNotesRes.body[0].id).toBe(noteRes.body.id);

    // 4. Test /inject
    const injectRes = await request(app)
      .get('/inject?project_id=proj-inject&task_type=build&limit=5')
      .set('Authorization', `Bearer ${testApiKey}`);
    expect(injectRes.status).toBe(200);
    expect(injectRes.body.prior_outcomes).toBeDefined();
    expect(injectRes.body.notes).toBeDefined();
    expect(injectRes.body.failure_patterns).toBeDefined();

    // 5. Test /maintenance/cleanup
    const cleanupRes = await request(app)
      .post('/maintenance/cleanup')
      .set('Authorization', `Bearer ${testApiKey}`);
    expect(cleanupRes.status).toBe(200);
    expect(cleanupRes.body.archived).toBeDefined();

    // 6. Test /maintenance/reembed
    const reembedRes = await request(app)
      .post('/maintenance/reembed')
      .set('Authorization', `Bearer ${testApiKey}`);
    expect(reembedRes.status).toBe(200);
    expect(reembedRes.body.processed).toBeDefined();

    const reembedStatusRes = await request(app)
      .get('/maintenance/reembed')
      .set('Authorization', `Bearer ${testApiKey}`);
    expect(reembedStatusRes.status).toBe(200);
    expect(reembedStatusRes.body.status).toBe('completed');
  });

  it('executes POST /search successfully in bm25 mode', async () => {
    await request(app)
      .post('/notes')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        scope: 'global',
        type: 'fact',
        title: 'TypeScript strict mode enabled',
        content: 'tsconfig has strict set to true across entire codebase',
      });

    const searchRes = await request(app)
      .post('/search')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        q: 'typescript strict mode',
        record_types: ['note'],
      });

    expect(searchRes.status).toBe(200);
    expect(searchRes.body.mode).toBe('bm25');
    expect(searchRes.body.results.length).toBeGreaterThan(0);
    expect(searchRes.body.results[0].record.title).toBe('TypeScript strict mode enabled');
  });

  it('supports hierarchical scoping across list endpoints and /inject (ancestors inherited, siblings isolated, children rolled up)', async () => {
    // Seed notes across acme, acme/socials, acme/socials/calendar, acme/socials/generator, acme/cogs
    await request(app)
      .post('/notes')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        scope: 'project',
        project_id: 'acme',
        type: 'architecture',
        title: 'Acme brand guidelines',
        content: 'Shared voice guidelines for all acme work.',
        files: ['docs/brand.md'],
        user_id: 'alice',
        agent_id: 'agent-alpha',
      })
      .expect(201);

    await request(app)
      .post('/notes')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        scope: 'project',
        project_id: 'acme/socials',
        type: 'workflow',
        title: 'Socials approval workflow',
        content: 'Schedule drafts 48h before publish.',
        files: ['docs/brand.md'],
        user_id: 'alice',
        agent_id: 'agent-beta',
      })
      .expect(201);

    await request(app)
      .post('/notes')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        scope: 'project',
        project_id: 'acme/socials/calendar',
        type: 'fact',
        title: 'Calendar timezone policy',
        content: 'Publish slots are stored in UTC.',
        files: ['docs/brand.md'],
        user_id: 'bob',
        agent_id: 'agent-alpha',
      })
      .expect(201);

    await request(app)
      .post('/notes')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        scope: 'project',
        project_id: 'acme/socials/generator',
        type: 'fact',
        title: 'Generator sibling secret',
        content: 'Should not leak to calendar.',
        files: ['docs/brand.md'],
      })
      .expect(201);

    await request(app)
      .post('/notes')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        scope: 'project',
        project_id: 'acme/cogs',
        type: 'fact',
        title: 'COGS unit pricing',
        content: 'Unrelated sibling project.',
      })
      .expect(201);

    // 1. GET /notes on acme/socials/calendar inherits acme + acme/socials, isolates siblings
    const calNotesRes = await request(app)
      .get('/notes?project_id=acme/socials/calendar&include_global=false')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    const calTitles = calNotesRes.body.map((n: any) => n.title);
    expect(calTitles).toContain('Calendar timezone policy');
    expect(calTitles).toContain('Socials approval workflow');
    expect(calTitles).toContain('Acme brand guidelines');
    expect(calTitles).not.toContain('Generator sibling secret');
    expect(calTitles).not.toContain('COGS unit pricing');

    // 2. GET /notes with user_id=alice returns both agent-alpha and agent-beta (never filtered on agent_id)
    const aliceNotesRes = await request(app)
      .get('/notes?project_id=acme/socials/calendar&user_id=alice&include_global=false')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    expect(aliceNotesRes.body.map((n: any) => n.title).sort()).toEqual([
      'Acme brand guidelines',
      'Socials approval workflow',
    ]);

    // 3. GET /notes on acme with include_children=true rolls up all descendants
    const parentRollupRes = await request(app)
      .get('/notes?project_id=acme&include_children=true&include_global=false')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    expect(parentRollupRes.body).toHaveLength(5);
    expect(
      parentRollupRes.body.find((n: any) => n.project_id === 'acme/cogs')?.match_tier
    ).toBe('child');

    // 4. GET /files/:path/notes supports include_ancestors, include_children, include_global, user_id
    const fileNotesRes = await request(app)
      .get('/files/docs%2Fbrand.md/notes?project_id=acme/socials/calendar&include_ancestors=false')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    expect(fileNotesRes.body.map((n: any) => n.title)).toEqual(['Calendar timezone policy']);

    // 5. Sessions, trajectories, observations preserve include_global=false default when project_id set
    await request(app)
      .post('/sessions/start')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({ id: 'sess-global-only', scope: 'global', agent_name: 'global-bot' })
      .expect(201);
    await request(app)
      .post('/sessions/start')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        id: 'sess-acme-parent',
        scope: 'project',
        project_id: 'acme',
        user_id: 'alice',
        agent_id: 'planner',
        agent_name: 'parent-bot',
      })
      .expect(201);

    const calSessionsRes = await request(app)
      .get('/sessions?project_id=acme/socials/calendar')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    expect(calSessionsRes.body.sessions.map((s: any) => s.id)).toEqual(['sess-acme-parent']);

    const calSessionsWithGlobalRes = await request(app)
      .get('/sessions?project_id=acme/socials/calendar&include_global=true')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    expect(calSessionsWithGlobalRes.body.sessions.map((s: any) => s.id).sort()).toEqual([
      'sess-acme-parent',
      'sess-global-only',
    ]);

    // 6. Observations & trajectories hierarchical query params
    await request(app)
      .post('/capture/observations')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        observations: [
          {
            id: 'obs-parent-1',
            scope: 'project',
            project_id: 'acme',
            user_id: 'alice',
            agent_id: 'runner-1',
            kind: 'response',
            input: 'parent prompt',
            output: 'parent response',
          },
          {
            id: 'obs-sibling-1',
            scope: 'project',
            project_id: 'acme/cogs',
            user_id: 'bob',
            kind: 'tool_call',
            tool_name: 'Edit',
          },
        ],
      })
      .expect(201);

    const obsRes = await request(app)
      .get('/observations?project_id=acme/socials/calendar&user_id=alice')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    expect(obsRes.body.map((o: any) => o.id)).toEqual(['obs-parent-1']);

    await request(app)
      .post('/capture/trajectories')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        trajectories: [
          {
            id: 'traj-parent-1',
            scope: 'project',
            projectId: 'acme',
            userId: 'alice',
            agentId: 'runner-2',
            taskType: 'deploy',
            description: 'Failed deploy on root',
            result: 'timeout reaching registry',
            success: false,
          },
        ],
      })
      .expect(201);

    const trajRes = await request(app)
      .get('/trajectories?project_id=acme/socials/calendar&user_id=alice')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    expect(trajRes.body.map((t: any) => t.id)).toEqual(['traj-parent-1']);

    // 7. Failure patterns + /inject inherit ancestor patterns, notes, ready_actions, and due_actions
    const fpRes = await request(app)
      .get('/failure-patterns?project_id=acme/socials/calendar&include_global=false')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    expect(fpRes.body.some((f: any) => f.error_text.includes('timeout reaching registry'))).toBe(true);

    const pastIso = new Date(Date.now() - 3600_000).toISOString();
    await request(app)
      .post('/actions')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        scope: 'project',
        project_id: 'acme',
        title: 'Root overdue reminder',
        priority: 'urgent',
        due_at: pastIso,
        remind_at: pastIso,
      })
      .expect(201);

    const injectRes = await request(app)
      .get('/inject?project_id=acme/socials/calendar&limit=10')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    expect(injectRes.body.failure_patterns.some((f: any) => f.project_id === 'acme')).toBe(true);
    expect(injectRes.body.notes.some((n: any) => n.title === 'Acme brand guidelines')).toBe(true);
    expect(injectRes.body.due_actions.some((a: any) => a.title === 'Root overdue reminder')).toBe(
      true
    );
    expect(
      injectRes.body.due_actions.find((a: any) => a.title === 'Root overdue reminder')?.overdue
    ).toBe(true);
  });

  it('supports Entity Graph HTTP CRUD (entities, edges, multi-hop /graph, DELETE) and 3-signal RRF search', async () => {
    // 1. Create entities in two sibling subprojects + global
    const entGenRes = await request(app)
      .post('/graph/entities')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        scope: 'project',
        project_id: 'acme/socials/generator',
        entity_type: 'asset',
        name: 'Summer Launch Reel',
        description: 'Vertical short-form video asset',
        external_ref: 's3://acme-assets/summer-reel.mp4',
        user_id: 'alice',
        agent_id: 'media-bot',
      })
      .expect(201);
    const entGen = entGenRes.body.entity;
    expect(entGen.id).toBeDefined();
    expect('embedding' in entGen).toBe(false);

    // 2. Create note in acme/marketing/launch with no direct query keyword overlap to "Summer Launch Reel"
    const noteLaunchRes = await request(app)
      .post('/notes')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        scope: 'project',
        project_id: 'acme/marketing/launch',
        type: 'fact',
        title: 'Primary hero video placement',
        content: 'Publish at 09:00 UTC across flagship channels.',
        user_id: 'alice',
      })
      .expect(201);
    const noteLaunch = noteLaunchRes.body;

    // 3. Link note -> entity across subprojects via POST /graph/edges
    const edgeRes = await request(app)
      .post('/graph/edges')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        source_id: noteLaunch.id,
        target_id: entGen.id,
        relation: 'references',
        metadata: { channel: 'hero' },
      })
      .expect(201);
    expect(edgeRes.body.edge.relation).toBe('references');
    expect(edgeRes.body.edge.source_type).toBe('note');
    expect(edgeRes.body.edge.target_type).toBe('entity');

    // 4. GET /graph/entities & GET /graph/entities/:id
    const listEntRes = await request(app)
      .get('/graph/entities?project_id=acme&include_children=true&entity_type=asset&user_id=alice')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    expect(listEntRes.body.entities.map((e: any) => e.id)).toEqual([entGen.id]);
    expect(listEntRes.body.entities[0].match_tier).toBe('child');

    const getEntRes = await request(app)
      .get(`/graph/entities/${entGen.id}`)
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    expect(getEntRes.body.entity.external_ref).toBe('s3://acme-assets/summer-reel.mp4');

    await request(app)
      .get('/graph/entities/ent_nonexistent')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(404);

    // 5. GET /graph with node_id and depth=1 traverses cross-subproject edge
    const graphRes = await request(app)
      .get(`/graph?project_id=acme/marketing/launch&node_id=${noteLaunch.id}&depth=1`)
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    expect(graphRes.body.nodes.some((n: any) => n.id === entGen.id && n.type === 'entity')).toBe(
      true
    );
    expect(
      graphRes.body.edges.some(
        (e: any) => e.source === noteLaunch.id && e.target === entGen.id && e.type === 'references'
      )
    ).toBe(true);

    // 6. POST /search surfaces noteLaunch via Entity-Graph signal when querying entity name under parent acme with include_children=true
    const searchRes = await request(app)
      .post('/search')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        q: 'Summer Launch Reel',
        project_id: 'acme',
        include_children: true,
        record_types: ['note', 'entity'],
      })
      .expect(200);
    const linkedNoteHit = searchRes.body.results.find((r: any) => r.id === noteLaunch.id);
    expect(linkedNoteHit).toBeDefined();
    expect(linkedNoteHit.matched_entities).toContain('Summer Launch Reel');

    // 7. DELETE /graph/edges/:id and 404 on second delete
    const delRes = await request(app)
      .delete(`/graph/edges/${edgeRes.body.edge.id}`)
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    expect(delRes.body.deleted).toBe(1);

    await request(app)
      .delete(`/graph/edges/${edgeRes.body.edge.id}`)
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(404);
  });

  it('supports temporal search filters (as_of, after, before, include_history) and rejects invalid ISO timestamps with 400', async () => {
    const v1 = await request(app)
      .post('/notes')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        scope: 'project',
        project_id: 'acme/cogs',
        type: 'fact',
        title: 'Supplier contract rate',
        content: 'Q1 supplier rate was $10/unit.',
        event_at: '2026-02-01T00:00:00Z',
        valid_from: '2026-01-01T00:00:00Z',
        valid_until: '2026-03-31T23:59:59Z',
      })
      .expect(201);

    await request(app)
      .post('/notes')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        scope: 'project',
        project_id: 'acme/cogs',
        type: 'fact',
        title: 'Supplier contract rate',
        content: 'Q2 supplier rate increased to $12/unit.',
        supersedes: v1.body.id,
        event_at: '2026-04-01T00:00:00Z',
        valid_from: '2026-04-01T00:00:00Z',
        valid_until: '2026-06-30T23:59:59Z',
      })
      .expect(201);

    const q1Res = await request(app)
      .post('/search')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        q: 'supplier rate',
        project_id: 'acme/cogs',
        record_types: ['note'],
        include_history: true,
        as_of: '2026-02-15T00:00:00Z',
      })
      .expect(200);
    expect(q1Res.body.results).toHaveLength(1);
    expect(q1Res.body.results[0].record.content).toContain('$10/unit');

    const badDateRes = await request(app)
      .post('/search')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        q: 'supplier',
        after: 'not-a-valid-date',
      })
      .expect(400);
    expect(badDateRes.body.error.code).toBe('SCHEMA_INVALID');
  });

  it('supports action reminders (/actions/due, /actions?due_only=true, /actions/reminders/check & ack, snooze, recurring spawn)', async () => {
    const now = Date.now();
    const pastDue = new Date(now - 2 * 3600_000).toISOString();
    const pastRemind = new Date(now - 3 * 3600_000).toISOString();
    const futureSnooze = new Date(now + 24 * 3600_000).toISOString();

    const dueActRes = await request(app)
      .post('/actions')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        scope: 'project',
        project_id: 'acme/socials/calendar',
        user_id: 'alice',
        agent_id: 'agent-1',
        title: 'Weekly KPI export',
        priority: 'high',
        due_at: pastDue,
        remind_at: pastRemind,
        recurrence: 'P1W',
      })
      .expect(201);
    const dueAct = dueActRes.body.action;

    const snoozedActRes = await request(app)
      .post('/actions')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        scope: 'project',
        project_id: 'acme/socials/calendar',
        user_id: 'alice',
        title: 'Snoozed reminder',
        due_at: pastDue,
        snooze_until: futureSnooze,
      })
      .expect(201);
    const snoozedAct = snoozedActRes.body.action;

    // 1. GET /actions/due returns dueAct and excludes snoozedAct
    const dueRes = await request(app)
      .get('/actions/due?project_id=acme/socials/calendar&user_id=alice')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    expect(dueRes.body.actions.map((a: any) => a.id)).toEqual([dueAct.id]);
    expect(dueRes.body.actions[0].overdue).toBe(true);

    // 2. GET /actions?due_only=true returns same due item
    const listDueRes = await request(app)
      .get('/actions?project_id=acme/socials/calendar&due_only=true')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(200);
    expect(listDueRes.body.actions.map((a: any) => a.id)).toEqual([dueAct.id]);

    // 3. POST /actions/reminders/check dry_run=true does not stamp last_reminded_at
    const dryCheckRes = await request(app)
      .post('/actions/reminders/check')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({ project_id: 'acme/socials/calendar', dry_run: true })
      .expect(200);
    expect(dryCheckRes.body.marked_count).toBe(0);
    expect(dryCheckRes.body.reminders.map((r: any) => r.id)).toEqual([dueAct.id]);

    // 4. POST /actions/reminders/check live stamps last_reminded_at, second check within cooldown returns 0
    const liveCheckRes = await request(app)
      .post('/actions/reminders/check')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({ project_id: 'acme/socials/calendar', cooldown_ms: 3600_000 })
      .expect(200);
    expect(liveCheckRes.body.marked_count).toBe(1);

    const secondCheckRes = await request(app)
      .post('/actions/reminders/check')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({ project_id: 'acme/socials/calendar', cooldown_ms: 3600_000 })
      .expect(200);
    expect(secondCheckRes.body.marked_count).toBe(0);
    expect(secondCheckRes.body.reminders).toHaveLength(0);

    // 5. POST /actions/reminders/ack validates ids array and stamps reminded_at
    await request(app)
      .post('/actions/reminders/ack')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({ ids: 'not-an-array' })
      .expect(400);

    const ackRes = await request(app)
      .post('/actions/reminders/ack')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({ ids: [snoozedAct.id] })
      .expect(200);
    expect(ackRes.body.updated).toBe(1);
    expect(ackRes.body.reminded_at).toBeDefined();

    // 6. PATCH /actions/:id status='done' on recurring action spawns next_occurrence (+7 days, preserving 1h lead)
    const patchRes = await request(app)
      .patch(`/actions/${dueAct.id}`)
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({ status: 'done' })
      .expect(200);
    expect(patchRes.body.action.status).toBe('done');
    expect(patchRes.body.action.next_occurrence).toBeDefined();
    expect(patchRes.body.action.next_occurrence.parent_action_id).toBe(dueAct.id);
    expect(patchRes.body.action.next_occurrence.status).toBe('ready');
    const nextDueMs = Date.parse(patchRes.body.action.next_occurrence.due_at);
    const nextRemindMs = Date.parse(patchRes.body.action.next_occurrence.remind_at);
    expect(nextDueMs - Date.parse(pastDue)).toBe(7 * 86_400_000);
    expect(nextDueMs - nextRemindMs).toBe(3600_000);
  });
});
