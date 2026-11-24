import request from 'supertest';
import { randomUUID } from 'crypto';
import { getDb, resetDb } from '../../lib/db';
import { createApp } from '../../app';
import { verifyOrCreateStoreMeta } from '../../learning/storeMeta';
import { createNote } from '../../memory/noteStore';
import { inspectSchemaAlignment } from '../../lib/storeDiagnostics';

describe('GET /diagnostics/store', () => {
  const originalEnv = { ...process.env };
  const apiKey = 'test_api_key_diagnostics_store';
  let app: any;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_REQUIRE_API_KEY = '1';
    process.env.BRAIN_EMBED = 'none';
    resetDb();
    getDb()
      .prepare(`INSERT INTO api_keys (id, name, key, created_at) VALUES (?, 'test-key', ?, datetime('now'))`)
      .run(randomUUID(), apiKey);
    verifyOrCreateStoreMeta();
    createNote({ id: 'note-diag-1', scope: 'unknown', type: 'fact', title: 'Diag', content: 'Diag note' });
    app = createApp();
  });

  afterEach(() => {
    resetDb();
    process.env = { ...originalEnv };
  });

  it('requires an API key', async () => {
    const res = await request(app).get('/diagnostics/store');
    expect(res.status).toBe(401);
  });

  it('reports database health, schema alignment and counts from the service connection', async () => {
    const res = await request(app).get('/diagnostics/store').set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.db.ok).toBe(true);
    expect(res.body.schema).toEqual({ aligned: true, issues: [] });
    expect(res.body.counts).toMatchObject({ notes: 1, unknown_scope_notes: 1, observations: 0 });
  });

  it('flags disabled foreign keys on the service connection (Q27)', async () => {
    getDb().exec('PRAGMA foreign_keys = OFF;');
    const res = await request(app).get('/diagnostics/store').set('Authorization', `Bearer ${apiKey}`);
    expect(res.body.schema.aligned).toBe(false);
    expect(res.body.schema.issues).toContain('PRAGMA foreign_keys is not active');
    getDb().exec('PRAGMA foreign_keys = ON;');
  });

  it('skips the per-connection foreign_keys check when asked (doctor read-only handle)', () => {
    getDb().exec('PRAGMA foreign_keys = OFF;');
    expect(inspectSchemaAlignment(getDb(), { checkForeignKeys: false })).toEqual({ aligned: true, issues: [] });
    getDb().exec('PRAGMA foreign_keys = ON;');
  });
});
