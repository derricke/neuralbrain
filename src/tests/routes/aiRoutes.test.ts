import request from 'supertest';
import { randomUUID } from 'crypto';
import { getDb, resetDb } from '../../lib/db';
import { createApp } from '../../app';
import { verifyOrCreateStoreMeta } from '../../learning/storeMeta';
import { resetCircuitBreakers } from '../../ai/circuitBreaker';
import { resetReasoningProbeCache } from '../../ai/chat';

describe('generative producer HTTP surface', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  let app: any;
  const testApiKey = 'test_api_key_ai_routes';

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_REQUIRE_API_KEY = '1';
    process.env.BRAIN_EMBED = 'none';
    process.env.BRAIN_CHAT_PROBE = '0';
    delete process.env.BRAIN_AI;
    delete process.env.BRAIN_AI_CONSOLIDATE;
    delete process.env.BRAIN_VENDOR;
    resetDb();
    resetCircuitBreakers();
    resetReasoningProbeCache();

    getDb()
      .prepare(
        `INSERT INTO api_keys (id, name, key, created_at) VALUES (?, 'test-key', ?, datetime('now'))`
      )
      .run(randomUUID(), testApiKey);

    verifyOrCreateStoreMeta();
    app = createApp();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetDb();
    resetCircuitBreakers();
    resetReasoningProbeCache();
    process.env = { ...originalEnv };
  });

  it('GET /diagnostics/ai-config reports resolved tiers and the vendor capability split', async () => {
    process.env.BRAIN_AI = 'vendor';
    process.env.BRAIN_VENDOR = 'google';
    process.env.GOOGLE_API_KEY = 'g-secret-key';

    const res = await request(app)
      .get('/diagnostics/ai-config')
      .set('Authorization', `Bearer ${testApiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.consolidate.ok).toBe(true);
    expect(res.body.consolidate.tier).toBe('vendor');
    expect(res.body.consolidate.model).toBe('google/gemini-2.0-flash');
    expect(res.body.summarize.tier).toBe('vendor');
    expect(res.body.generative_vendors).toEqual(['openai', 'anthropic', 'google']);
    expect(res.body.embedding_vendors).toEqual(['openai', 'google']);
    expect(res.body.circuit_breakers).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('g-secret-key');
  });

  it('GET /diagnostics/ai-config surfaces a misconfiguration instead of hiding it', async () => {
    process.env.BRAIN_AI_CONSOLIDATE = 'vendor';

    const res = await request(app)
      .get('/diagnostics/ai-config')
      .set('Authorization', `Bearer ${testApiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.consolidate.ok).toBe(false);
    expect(res.body.consolidate.error).toMatch(/requires BRAIN_VENDOR/);
  });

  it("POST /consolidate/run reports the default 'agent' tier without calling a model", async () => {
    global.fetch = jest.fn() as any;

    const res = await request(app)
      .post('/consolidate/run')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('agent');
    expect(res.body.tier).toBe('agent');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('POST /consolidate/run answers 400 when the generative config cannot resolve', async () => {
    process.env.BRAIN_AI_CONSOLIDATE = 'local';

    const res = await request(app)
      .post('/consolidate/run')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('misconfigured');
    expect(res.body.message).toMatch(/only an encoder can run in-process/);
  });
});
