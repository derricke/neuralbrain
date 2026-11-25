import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, resetDb } from '../../lib/db';
import { openDatabase } from '../../lib/sqlite';
import { runDoctor } from '../../scripts/doctor';
import { createNote } from '../../memory/noteStore';
import { verifyOrCreateStoreMeta } from '../../learning/storeMeta';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('neuralbrain doctor', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    resetDb();
  });

  describe('local mode against a provided connection', () => {
    beforeEach(() => {
      process.env.DATABASE_URL = ':memory:';
      process.env.BRAIN_EMBED = 'none';
      resetDb();
      verifyOrCreateStoreMeta();
      // A small store for the counts doctor reports: 3 project-scoped notes, 2 unknown.
      for (let i = 0; i < 5; i++) {
        createNote({
          id: `note-doctor-${i}`,
          scope: i < 3 ? 'project' : 'unknown',
          projectId: i < 3 ? 'demo-project' : undefined,
          type: 'fact',
          title: `Doctor fixture ${i}`,
          content: `Fixture note ${i} for doctor diagnostics.`,
        });
      }
    });

    it('passes all checks with one consistent verdict', async () => {
      const report = await runDoctor({ mode: 'local', db: getDb(), ai: true, quiet: true });

      expect(report.source).toBe('local');
      expect(report.dbOk).toBe(true);
      expect(report.schemaAligned).toBe(true);
      expect(report.storeMetaMatch).toBe(true);
      expect(report.noteCount).toBe(5);
      expect(report.unknownScopeCount).toBe(2);
      expect(report.aiDiagnostics.all_passing).toBe(true);
      expect(report.aiDiagnostics.total_count).toBe(8);
      expect(report.aiDiagnostics.passed_count).toBe(8);

      // Never "N/M passing" and "all passing" at once.
      expect(report.allPassing).toBe(report.checks.every((c) => c.pass) && report.aiDiagnostics.all_passing);
      expect(report.allPassing).toBe(true);
      expect(report.version).toBeTruthy();
      expect(report.install.version).toBe(report.version);
      expect(report.install.installKind).toBe('checkout');
      expect(report.install.isGlobal).toBe(false);
      expect(report.install.location).toBe(fs.realpathSync(path.resolve(__dirname, '../../..')));
    });

    it('runs the AI fixtures in a throwaway database, leaving the inspected store untouched', async () => {
      const db = getDb();
      const count = (table: string) =>
        (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
      const before = {
        observations: count('observations'),
        summaries: count('summaries'),
        leases: count('consolidation_leases'),
        deadLetters: count('dead_letters'),
        embedQueue: count('embed_queue'),
      };
      const urlBefore = process.env.DATABASE_URL;

      const report = await runDoctor({ mode: 'local', db, ai: true, quiet: true });
      expect(report.aiDiagnostics.passed_count).toBe(8);

      // Same connection, same rows, same env.
      expect(getDb()).toBe(db);
      expect(process.env.DATABASE_URL).toBe(urlBefore);
      expect({
        observations: count('observations'),
        summaries: count('summaries'),
        leases: count('consolidation_leases'),
        deadLetters: count('dead_letters'),
        embedQueue: count('embed_queue'),
      }).toEqual(before);
    });

    it('reports a store_meta mismatch and never claims all passing', async () => {
      process.env.BRAIN_EMBED = 'local';
      const db = getDb();
      db.prepare('UPDATE store_meta SET embed_dim = 99999 WHERE id = 1').run();

      const report = await runDoctor({ mode: 'local', db, ai: false, quiet: true });
      expect(report.allPassing).toBe(false);
      const check = report.checks.find((c) => c.name === 'Store Meta Consistency');
      expect(check?.pass).toBe(false);
      expect(check?.message).toContain('dim=99999');
    });

    it('detects schema misalignment in columns and nullability (Q27)', async () => {
      const db = getDb();
      db.exec(`
        DROP TABLE trajectories;
        CREATE TABLE trajectories (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          project_id TEXT,
          success INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);

      const report = await runDoctor({ mode: 'local', db, ai: false, quiet: true });
      expect(report.schemaAligned).toBe(false);
      expect(report.allPassing).toBe(false);
      const check = report.checks.find((c) => c.name === 'Schema Alignment');
      expect(check?.pass).toBe(false);
      expect(check?.message).toContain('trajectories.success is not nullable');
      expect(check?.message).toContain('trajectories.session_id missing');
    });

    it('detects missing entities, FTS5 tables, and action/note reminder/temporal columns', async () => {
      const db = getDb();
      db.exec(`
        DROP TABLE IF EXISTS fts_entities;
        DROP TABLE IF EXISTS entity_edges;
        DROP TABLE IF EXISTS entities;
      `);

      const report = await runDoctor({ mode: 'local', db, ai: false, quiet: true });
      const check = report.checks.find((c) => c.name === 'Schema Alignment');
      expect(check?.pass).toBe(false);
      expect(check?.message).toContain('table entities does not exist');
      expect(check?.message).toContain('table entity_edges does not exist');
      expect(check?.message).toContain('FTS5 table fts_entities does not exist');
    });
  });

  describe('local mode against a database file', () => {
    let dir: string;
    let dbPath: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-doctor-'));
      dbPath = path.join(dir, 'brain.db');
      process.env.DATABASE_URL = dbPath;
      process.env.BRAIN_EMBED = 'none';
      resetDb();
      verifyOrCreateStoreMeta();
      createNote({
        id: 'note-file-1',
        scope: 'global',
        type: 'fact',
        title: 'File-backed doctor fixture',
        content: 'Lives in a real file so the read-only open is exercised.',
      });
      // Close the writer, as when the service is stopped.
      resetDb();
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('opens the file read-only and writes nothing to it, even with --ai', async () => {
      const mtimeBefore = fs.statSync(dbPath).mtimeMs;
      const sizeBefore = fs.statSync(dbPath).size;

      const report = await runDoctor({ mode: 'local', dbPath, ai: true, quiet: true });

      expect(report.source).toBe('local');
      expect(report.target).toBe(path.resolve(dbPath));
      expect(report.dbOk).toBe(true);
      expect(report.schemaAligned).toBe(true);
      expect(report.noteCount).toBe(1);
      expect(report.aiDiagnostics.passed_count).toBe(8);
      expect(report.allPassing).toBe(true);

      expect(fs.statSync(dbPath).mtimeMs).toBe(mtimeBefore);
      expect(fs.statSync(dbPath).size).toBe(sizeBefore);
      const ro = openDatabase(dbPath, { readOnly: true });
      try {
        const obs = ro.prepare('SELECT COUNT(*) as c FROM observations').get() as { c: number };
        expect(obs.c).toBe(0);
      } finally {
        ro.close();
      }
    });

    it('reports a missing database file instead of creating one', async () => {
      const missing = path.join(dir, 'absent.db');
      const report = await runDoctor({ mode: 'local', dbPath: missing, ai: false, quiet: true });

      expect(report.dbOk).toBe(false);
      expect(report.allPassing).toBe(false);
      expect(report.checks.find((c) => c.name === 'Database Health')?.message).toContain('No database at');
      expect(fs.existsSync(missing)).toBe(false);
    });

    it('falls back to local mode when the service does not answer /health', async () => {
      const unreachable = (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as unknown as typeof fetch;

      const report = await runDoctor({ apiUrl: 'http://127.0.0.1:1', fetchFn: unreachable, dbPath, ai: false, quiet: true });
      expect(report.source).toBe('local');
      expect(report.noteCount).toBe(1);
    });
  });

  describe('service mode', () => {
    const aiReport = {
      status: 'ok',
      all_passing: true,
      passed_count: 8,
      total_count: 8,
      results: [{ name: 'gate: reject unresolved citation with 422', pass: true }],
    };

    function fakeService(overrides: Record<string, () => Response> = {}) {
      const calls: Array<{ url: string; auth: string | null }> = [];
      const routes: Record<string, () => Response> = {
        '/health': () =>
          jsonResponse(200, {
            status: 'ok',
            db: 'ok',
            store_meta: { match: true, embed_tier: 'local-gpu', embed_dim: 512, mismatch_reason: null },
          }),
        '/diagnostics/store': () =>
          jsonResponse(200, {
            db: { ok: true, journal_mode: 'wal' },
            schema: { aligned: true, issues: [] },
            counts: { dead_letters: 3, unknown_scope_notes: 1, notes: 42, trajectories: 7, observations: 900 },
          }),
        '/diagnostics/ai-config': () =>
          jsonResponse(200, { summarize: { ok: true, tier: 'agent' }, consolidate: { ok: true, tier: 'agent' } }),
        '/diagnostics/ai': () => jsonResponse(200, aiReport),
        ...overrides,
      };
      const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        calls.push({ url: url.pathname, auth: headers.get('authorization') });
        const handler = routes[url.pathname];
        return handler ? handler() : jsonResponse(404, { error: { message: 'not found' } });
      }) as unknown as typeof fetch;
      return { fetchFn, calls };
    }

    it('takes every answer from the service and opens no database', async () => {
      // Any getDb() call would open this path; it must never come into existence.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-doctor-svc-'));
      process.env.DATABASE_URL = path.join(dir, 'must-not-exist.db');
      resetDb();

      const { fetchFn, calls } = fakeService();
      const report = await runDoctor({ apiUrl: 'http://brain.test', apiKey: 'k-123', fetchFn, ai: true, quiet: true });

      expect(report.source).toBe('service');
      expect(report.target).toBe('http://brain.test');
      expect(report.allPassing).toBe(true);
      expect(report.noteCount).toBe(42);
      expect(report.observationCount).toBe(900);
      expect(report.aiDiagnostics.passed_count).toBe(8);
      expect(calls.map((c) => c.url)).toEqual(['/health', '/diagnostics/store', '/diagnostics/ai-config', '/diagnostics/ai']);
      expect(calls.filter((c) => c.url !== '/health').every((c) => c.auth === 'Bearer k-123')).toBe(true);
      expect(fs.existsSync(path.join(dir, 'must-not-exist.db'))).toBe(false);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('uses the service-resolved store_meta, not the host environment', async () => {
      process.env.BRAIN_EMBED = 'local'; // the host shell disagrees with the container
      const { fetchFn } = fakeService();
      const report = await runDoctor({ apiUrl: 'http://brain.test', apiKey: 'k', fetchFn, ai: false, quiet: true });
      expect(report.storeMetaMatch).toBe(true);
      expect(report.checks.find((c) => c.name === 'Store Meta Consistency')?.message).toContain('local-gpu');
    });

    it('reports a rejected API key instead of passing', async () => {
      const { fetchFn } = fakeService({
        '/diagnostics/store': () => jsonResponse(401, { error: { message: 'Unauthorized' } }),
      });
      const report = await runDoctor({ apiUrl: 'http://brain.test', apiKey: 'wrong', fetchFn, ai: false, quiet: true });
      expect(report.allPassing).toBe(false);
      expect(report.checks.find((c) => c.name === 'Database Health')?.message).toContain('BRAIN_API_KEY');
    });

    it('surfaces a service-side store_meta mismatch', async () => {
      const { fetchFn } = fakeService({
        '/health': () =>
          jsonResponse(503, {
            status: 'degraded',
            db: 'ok',
            store_meta: { match: false, mismatch_reason: 'vector search unavailable: dim differs' },
          }),
      });
      const report = await runDoctor({ apiUrl: 'http://brain.test', apiKey: 'k', fetchFn, ai: false, quiet: true });
      expect(report.source).toBe('service');
      expect(report.storeMetaMatch).toBe(false);
      expect(report.allPassing).toBe(false);
      expect(report.checks.find((c) => c.name === 'Store Meta Consistency')?.message).toContain('dim differs');
    });

    it('explains a service that predates /diagnostics/store instead of failing opaquely', async () => {
      const { fetchFn } = fakeService({
        '/diagnostics/store': () => jsonResponse(404, { error: { message: 'Not Found' } }),
      });
      const report = await runDoctor({ apiUrl: 'http://brain.test', apiKey: 'k', fetchFn, ai: false, quiet: true });
      expect(report.dbOk).toBe(true);
      expect(report.allPassing).toBe(false);
      expect(report.checks.find((c) => c.name === 'Schema Alignment')?.message).toContain('predates GET /diagnostics/store');
    });

    it('fails rather than falling back when --service is forced and nothing answers', async () => {
      const unreachable = (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as unknown as typeof fetch;
      const report = await runDoctor({ mode: 'service', apiUrl: 'http://127.0.0.1:1', fetchFn: unreachable, ai: false, quiet: true });
      expect(report.source).toBe('service');
      expect(report.allPassing).toBe(false);
      expect(report.checks[0].name).toBe('Service Reachable');
    });
  });
});

describe('doctor test isolation', () => {
  it('refuses to probe a real service from a test run', async () => {
    await expect(runDoctor({ ai: false, quiet: true })).rejects.toThrow('refusing to probe a real service');
  });
});
