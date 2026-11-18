import express, { Request, Response } from 'express';
import request from 'supertest';
import { apiKeyAuth } from '../../middleware/auth';
import { requestTracing } from '../../middleware/tracing';
import { getDb, resetDb } from '../../lib/db';
import { randomUUID } from 'crypto';

beforeEach(() => {
  resetDb();
  process.env.DATABASE_URL = ':memory:';
  process.env.BRAIN_REQUIRE_API_KEY = '1';
  getDb();
});

afterAll(() => {
  resetDb();
});

describe('auth middleware', () => {
  const setupApp = () => {
    const app = express();
    app.use(requestTracing);
    app.use(apiKeyAuth);
    app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok' });
    });
    app.get('/dashboard', (_req: Request, res: Response) => {
      res.json({ dashboard: true });
    });
    app.get('/api/protected', (_req: Request, res: Response) => {
      res.json({ secret: 'data' });
    });
    return app;
  };

  it('exempts /health and /dashboard without authorization header', async () => {
    const app = setupApp();

    const healthRes = await request(app).get('/health');
    expect(healthRes.status).toBe(200);

    const dashboardRes = await request(app).get('/dashboard');
    expect(dashboardRes.status).toBe(200);
  });

  it('rejects protected route with 401 and standard error shape if no key provided', async () => {
    const app = setupApp();

    const res = await request(app).get('/api/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.trace_id).toBeDefined();
  });

  it('rejects invalid key with 401', async () => {
    const app = setupApp();

    const res = await request(app)
      .get('/api/protected')
      .set('Authorization', 'Bearer invalid-key-12345');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('allows valid api key and updates last_used_at', async () => {
    const app = setupApp();
    const db = getDb();
    const testKey = 'test-secret-key-999';

    db.prepare(`
      INSERT INTO api_keys (id, name, key, created_at)
      VALUES (?, 'test-client', ?, datetime('now'))
    `).run(randomUUID(), testKey);

    const res = await request(app)
      .get('/api/protected')
      .set('Authorization', `Bearer ${testKey}`);

    expect(res.status).toBe(200);
    expect(res.body.secret).toBe('data');

    const keyRecord = db
      .prepare('SELECT last_used_at FROM api_keys WHERE key = ?')
      .get(testKey) as { last_used_at: string };
    expect(keyRecord.last_used_at).toBeDefined();
  });

  it('bypasses auth when BRAIN_REQUIRE_API_KEY=0', async () => {
    process.env.BRAIN_REQUIRE_API_KEY = '0';
    const app = setupApp();

    const res = await request(app).get('/api/protected');
    expect(res.status).toBe(200);
    expect(res.body.secret).toBe('data');
  });

  it('invalidates existing dashboard session cookies when BRAIN_API_KEY rotates', () => {
    const {
      createDashboardSessionToken,
      ensureBootstrapApiKey,
      parseDashboardSessionCookie,
    } = require('../../middleware/auth');

    const origKey = process.env.BRAIN_API_KEY;
    try {
      process.env.BRAIN_API_KEY = 'initial-env-key-111';
      ensureBootstrapApiKey();

      const token = createDashboardSessionToken('env-configured-key', 'env-brain-api-key');
      const valid = parseDashboardSessionCookie(`brain_session=${token}`);
      expect(valid).toEqual({ apiKeyId: 'env-configured-key', apiKeyName: 'env-brain-api-key' });

      // Rotate BRAIN_API_KEY in-place for 'env-configured-key'
      process.env.BRAIN_API_KEY = 'rotated-env-key-222';
      ensureBootstrapApiKey();

      const invalidated = parseDashboardSessionCookie(`brain_session=${token}`);
      expect(invalidated).toBeNull();
    } finally {
      if (origKey === undefined) delete process.env.BRAIN_API_KEY;
      else process.env.BRAIN_API_KEY = origKey;
    }
  });
});
