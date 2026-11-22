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
});
