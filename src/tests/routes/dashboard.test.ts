import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import { randomUUID } from 'crypto';
import { getDb, resetDb } from '../../lib/db';
import { createApp } from '../../app';
import { verifyOrCreateStoreMeta } from '../../learning/storeMeta';
import { createNote } from '../../memory/noteStore';
import { captureObservations } from '../../memory/observationStore';
import { captureTrajectories } from '../../memory/trajectoryStore';

describe('Web Operator Dashboard & UI Route Tests', () => {
  const originalEnv = { ...process.env };
  let app: any;
  const testApiKey = 'dashboard_test_key_abc123';
  let testSpoolDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_REQUIRE_API_KEY = '1'; // Strict auth mode active
    process.env.BRAIN_EMBED = 'none';

    testSpoolDir = path.join(os.tmpdir(), 'brain-test-spool-' + randomUUID());
    fs.mkdirSync(testSpoolDir, { recursive: true });
    process.env.BRAIN_SPOOL_PATH = testSpoolDir;

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
    if (testSpoolDir && fs.existsSync(testSpoolDir)) {
      fs.rmSync(testSpoolDir, { recursive: true, force: true });
    }
    process.env = { ...originalEnv };
  });

  describe('Route & Security Headers', () => {
    it('GET / redirects to /dashboard without requiring API key', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/dashboard');
    });

    it('GET /dashboard serves HTML5 shell with strict security headers', async () => {
      const res = await request(app).get('/dashboard');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');

      // Mandatory Security Headers
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none';"
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
      expect(res.headers['cache-control']).toBe('no-store');

      // Verify HTML content structure
      expect(res.text).toContain('<!DOCTYPE html>');
      expect(res.text).toContain('neuralbrain');
      expect(res.text).toContain('/dashboard/styles.css');
      expect(res.text).toContain('/dashboard/app.js');
      expect(res.text).toContain('Overview & Memory Layers');
      expect(res.text).toContain('subTabBtnShortSummaries');
      expect(res.text).toContain('Notes Explorer & Repair Queue');

      // Notes Explorer searchable dropdown markup
      expect(res.text).toContain('id="notesProjectDropdownWrapper"');
      expect(res.text).toContain('id="notesFilterProject"');
      expect(res.text).toContain('id="notesProjectDropdownToggle"');
      expect(res.text).toContain('id="notesProjectDropdownMenu"');

      // Hybrid Search & Push Simulator controls
      expect(res.text).toContain('id="searchProjectDropdownWrapper"');
      expect(res.text).toContain('id="searchInputProject"');
      expect(res.text).toContain('id="searchNoteType"');
      expect(res.text).toContain('id="injectProjectDropdownWrapper"');
      expect(res.text).toContain('id="injectInputProject"');
      expect(res.text).toContain('id="injectInputTaskType"');

      // API Key generation button, semantic form, and session management
      expect(res.text).toContain('id="formDashboardApiKey"');
      expect(res.text).toContain('id="inputDashboardApiKey"');
      expect(res.text).toContain('id="btnSubmitApiKey"');
      expect(res.text).toContain('Apply');
      expect(res.text).toContain('id="authSessionCluster"');
      expect(res.text).toContain('id="btnLogoutApiKey"');
      expect(res.text).toContain('Log Out');
      expect(res.text).toContain('id="btnGenerateApiKey"');
      expect(res.text).toContain('+ Generate API Key');
    });

    it('GET /dashboard/styles.css serves CSS with security headers and consistent dimensions', async () => {
      const res = await request(app).get('/dashboard/styles.css');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/css');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cache-control']).toBe('no-store');

      // Dimension and UI consistency rules
      expect(res.text).toContain('--control-height: 38px');
      expect(res.text).toContain('--control-radius: 8px');
      expect(res.text).toContain('cursor: pointer');
      expect(res.text).toContain(':hover');

      // Searchable dropdown, citation badges, note editor and inspector styles
      expect(res.text).toContain('.searchable-dropdown');
      expect(res.text).toContain('.dropdown-menu');
      expect(res.text).toContain('.dropdown-item');
      expect(res.text).toContain('.btn-icon-edit');
      expect(res.text).toContain('.scope-repair-widget');
      expect(res.text).toContain('.citation-badge');
      expect(res.text).toContain('tr.row-highlight');
      expect(res.text).toContain('.inspector-grid');
    });

    it('GET /dashboard/app.js serves JavaScript with security headers', async () => {
      const res = await request(app).get('/dashboard/app.js');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/javascript');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cache-control']).toBe('no-store');

      // Verify searchable dropdown, citation links and observation inspectors
      expect(res.text).toContain('syncKnownProjects');
      expect(res.text).toContain('renderProjectDropdown');
      expect(res.text).toContain('attachSearchableProjectDropdown');
      expect(res.text).toContain('inspectCitation');
      expect(res.text).toContain('showObservationModal');
      expect(res.text).toContain('showObservationNotFoundModal');
      expect(res.text).toContain('showTrajectoryModal');
      expect(res.text).toContain('Observation');
      expect(res.text).toContain('not found in active store (may have been archived or cleaned up)');

      // Key generator modal & auth status
      expect(res.text).not.toContain('window.__BRAIN_DASHBOARD_TOKEN__');
      expect(res.text).toContain('checkAuthStatus');
      expect(res.text).toContain('openApiKeyManagerModal');
      expect(res.text).toContain('Copy MCP JSON');

      // Permanent check: Validate that app.js is syntactically valid JavaScript
      expect(() => {
        new vm.Script(res.text);
      }).not.toThrow();
    });
  });

  describe('Secure Web Frontend Compliance (mandatory-secure-web-skills)', () => {
    it('verifies src/dashboard contains zero innerHTML, outerHTML, document.write, or insertAdjacentHTML in code', () => {
      const dashboardDir = path.resolve(__dirname, '../../dashboard');
      const files = fs.readdirSync(dashboardDir).filter((f) => f.endsWith('.ts'));

      for (const file of files) {
        const filePath = path.join(dashboardDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');

        // Strip single-line and multi-line comments before checking
        const codeWithoutComments = content
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');

        expect(codeWithoutComments).not.toMatch(/\.innerHTML/);
        expect(codeWithoutComments).not.toMatch(/\.outerHTML/);
        expect(codeWithoutComments).not.toMatch(/document\.write/);
        expect(codeWithoutComments).not.toMatch(/\.insertAdjacentHTML/);
      }
    });

    it('verifies src/dashboard contains zero localStorage or sessionStorage usage', () => {
      const dashboardDir = path.resolve(__dirname, '../../dashboard');
      const files = fs.readdirSync(dashboardDir).filter((f) => f.endsWith('.ts'));

      for (const file of files) {
        const filePath = path.join(dashboardDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const codeWithoutComments = content
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');

        expect(codeWithoutComments).not.toMatch(/localStorage/);
        expect(codeWithoutComments).not.toMatch(/sessionStorage/);
      }
    });

    it('verifies src/dashboard contains zero native alert(), confirm(), or prompt() calls', () => {
      const dashboardDir = path.resolve(__dirname, '../../dashboard');
      const files = fs.readdirSync(dashboardDir).filter((f) => f.endsWith('.ts'));

      for (const file of files) {
        const filePath = path.join(dashboardDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const codeWithoutComments = content
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');

        expect(codeWithoutComments).not.toMatch(/\balert\s*\(/);
        expect(codeWithoutComments).not.toMatch(/\bconfirm\s*\(/);
        expect(codeWithoutComments).not.toMatch(/\bprompt\s*\(/);
      }
    });
  });

  describe('Dashboard BFF API Endpoints', () => {
    it('GET /dashboard/api/stats returns full telemetry snapshot', async () => {
      // Seed data across grains
      createNote({
        scope: 'project',
        projectId: 'example-app',
        type: 'bug',
        title: 'Rate limiter issue in scraper',
        content: 'Yahoo finance endpoints return 429 when concurrency exceeds 4.',
        concepts: ['scraping', 'rate-limits'],
        files: ['src/scraper.ts'],
      });

      createNote({
        scope: 'unknown',
        type: 'architecture',
        title: 'Legacy note without scope',
        content: 'Original memory from agentmemory backfill.',
      });

      captureObservations([
        {
          scope: 'project',
          projectId: 'example-app',
          kind: 'tool_call',
          tool_name: 'Edit',
          file_path: 'src/scraper.ts',
          input: 'change rate limiter concurrency to 2',
          output: 'ok',
          duration_ms: 80,
          failed: 0,
        },
      ]);

      captureTrajectories([
        {
          scope: 'project',
          projectId: 'example-app',
          task_type: 'bugfix',
          description: 'Fix scraper 429 issue',
          result: 'All unit tests passing',
          success: true,
          duration_ms: 250,
        },
      ]);

      const res = await request(app)
        .get('/dashboard/api/stats')
        .set('Authorization', `Bearer ${testApiKey}`);
      expect(res.status).toBe(200);

      // Verify Health
      expect(res.body.health).toBeDefined();
      expect(res.body.health.db).toBe('ok');
      expect(res.body.health.store_meta).toBeDefined();
      expect(res.body.health.store_meta.match).toBe(true);

      // Verify Counts
      expect(res.body.counts).toBeDefined();
      expect(res.body.counts.notes.total).toBe(2);
      expect(res.body.counts.notes.project).toBe(1);
      expect(res.body.counts.notes.unknown).toBe(1);
      expect(res.body.counts.observations.total).toBe(1);
      expect(res.body.counts.trajectories.total).toBe(1);

      // Verify Projects Breakdown
      expect(Array.isArray(res.body.projects)).toBe(true);
      const exampleAppProj = res.body.projects.find((p: any) => p.project_id === 'example-app');
      expect(exampleAppProj).toBeDefined();
      expect(exampleAppProj.notes_count).toBe(1);
      expect(exampleAppProj.observations_count).toBe(1);
      expect(exampleAppProj.trajectories_count).toBe(1);

      // Verify Type Distribution
      expect(Array.isArray(res.body.type_distribution)).toBe(true);
      const bugType = res.body.type_distribution.find((t: any) => t.type === 'bug');
      expect(bugType).toBeDefined();
      expect(bugType.count).toBe(1);

      // Verify Unknown Notes (Repair Queue)
      expect(Array.isArray(res.body.unknown_notes)).toBe(true);
      expect(res.body.unknown_notes.length).toBe(1);
      expect(res.body.unknown_notes[0].scope).toBe('unknown');

      // Verify Spool Stats
      expect(res.body.spool).toBeDefined();
      expect(res.body.spool.maxBytes).toBeGreaterThan(0);
    });

    it('POST /dashboard/api/migrate runs migration successfully', async () => {
      const tmpSnapshot = path.join(os.tmpdir(), `dash-migrate-${process.pid}-${Date.now()}.json`);
      const memories = Array.from({ length: 1000 }, (_, i) => ({
        id: `mem_dash_${i}`,
        title: `Synthetic Dash Note ${i}`,
        content: `Synthetic content ${i}`,
        type: 'fact',
        project: i < 86 ? 'demo-project' : null,
        version: 1,
        isLatest: true,
        origin: { channel: 'agent' },
        concepts: [`c-${i}`],
        files: [`src/f-${i}.ts`],
      }));
      fs.writeFileSync(tmpSnapshot, JSON.stringify({ memories }), 'utf-8');
      process.env.AGENTMEMORY_SNAPSHOT_PATH = tmpSnapshot;
      try {
        const res = await request(app)
          .post('/dashboard/api/migrate')
          .set('Authorization', `Bearer ${testApiKey}`);
        expect(res.status).toBe(200);
        expect(res.body.totalRead).toBe(1000);
        expect(res.body.imported).toBe(1000);
      } finally {
        delete process.env.AGENTMEMORY_SNAPSHOT_PATH;
        if (fs.existsSync(tmpSnapshot)) fs.unlinkSync(tmpSnapshot);
      }
    });

    it('POST /dashboard/api/drain-embed executes queue drain', async () => {
      const res = await request(app)
        .post('/dashboard/api/drain-embed')
        .set('Authorization', `Bearer ${testApiKey}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.processed).toBeDefined();
      expect(res.body.remaining).toBeDefined();
    });

    it('supports repairing unknown notes via PATCH /notes/:id/scope', async () => {
      const note = createNote({
        scope: 'unknown',
        type: 'fact',
        title: 'Unscoped note to repair',
        content: 'This note was imported without project tag',
      });

      expect(note.scope).toBe('unknown');
      expect(note.project_id).toBeNull();

      // Repair the note using API key authentication
      const updateRes = await request(app)
        .patch(`/notes/${note.id}/scope`)
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({
          scope: 'project',
          projectId: 'demo-project',
        });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.scope).toBe('project');
      expect(updateRes.body.project_id).toBe('demo-project');

      // Check stats reflect repaired scope
      const statsRes = await request(app)
        .get('/dashboard/api/stats')
        .set('Authorization', `Bearer ${testApiKey}`);
      expect(statsRes.body.counts.notes.project).toBe(1);
      expect(statsRes.body.counts.notes.unknown).toBe(0);
    });

    it('supports fetching single observation and trajectory for summary citation clicks', async () => {
      // 1. Capture a real observation
      const obsCap = captureObservations([
        {
          scope: 'project',
          projectId: 'example-app',
          kind: 'tool_call',
          toolName: 'Edit',
          filePath: 'src/lib/db.ts',
          input: 'npm test -- memories',
          output: 'PASS memories.test.ts',
          failed: 0,
          durationMs: 120,
        },
      ]);
      expect(obsCap.accepted).toBe(1);
      const obsId = obsCap.ids[0];

      // 2. Fetch the observation by ID (as done when clicking citation [obs-id])
      const getObsRes = await request(app)
        .get(`/observations/${obsId}`)
        .set('Authorization', `Bearer ${testApiKey}`);
      expect(getObsRes.status).toBe(200);
      expect(getObsRes.body.id).toBe(obsId);
      expect(getObsRes.body.tool_name).toBe('Edit');
      expect(getObsRes.body.file_path).toBe('src/lib/db.ts');
      expect(getObsRes.body.input).toBe('npm test -- memories');

      // 3. Non-existent observation ID returns 404 (handled gracefully by showObservationNotFoundModal)
      const missingObsRes = await request(app)
        .get('/observations/obs_nonexistent_12345')
        .set('Authorization', `Bearer ${testApiKey}`);
      expect(missingObsRes.status).toBe(404);
      expect(missingObsRes.body.error.code).toBe('NOT_FOUND');

      // 4. Capture a real trajectory
      const trajCap = captureTrajectories([
        {
          scope: 'project',
          projectId: 'example-app',
          taskType: 'migration',
          description: 'Migrated database schema to v2',
          result: 'All 15 tables migrated successfully',
          success: true,
          durationMs: 450,
        },
      ]);
      expect(trajCap.accepted).toBe(1);
      const trajId = trajCap.ids[0];

      // 5. Fetch the trajectory by ID
      const getTrajRes = await request(app)
        .get(`/trajectories/${trajId}`)
        .set('Authorization', `Bearer ${testApiKey}`);
      expect(getTrajRes.status).toBe(200);
      expect(getTrajRes.body.id).toBe(trajId);
      expect(getTrajRes.body.task_type).toBe('migration');
      expect(getTrajRes.body.success).toBe(1);
    });

    it('persists authentication across page refreshes via HttpOnly session cookies', async () => {
      // 1. Unauthenticated request without key or cookie fails with 401
      const unauthRes = await request(app).get('/dashboard/api/stats');
      expect(unauthRes.status).toBe(401);

      // 2. Logging in with invalid key fails with 401
      const invalidLoginRes = await request(app)
        .post('/dashboard/api/session')
        .send({ key: 'wrong_key' });
      expect(invalidLoginRes.status).toBe(401);

      // 3. Logging in with valid key sets HttpOnly SameSite=Strict session cookie
      const loginRes = await request(app)
        .post('/dashboard/api/session')
        .send({ key: testApiKey });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.ok).toBe(true);
      expect(loginRes.body.authenticated).toBe(true);

      const cookieHeader = loginRes.headers['set-cookie'];
      expect(cookieHeader).toBeDefined();
      const sessionCookie = cookieHeader[0];
      expect(sessionCookie).toContain('brain_session=');
      expect(sessionCookie).toContain('HttpOnly');
      expect(sessionCookie).toContain('SameSite=Strict');
      expect(sessionCookie).toContain('Path=/');

      // 4. auth-status with session cookie reports authenticated: true
      const authStatusRes = await request(app)
        .get('/dashboard/api/auth-status')
        .set('Cookie', sessionCookie);
      expect(authStatusRes.status).toBe(200);
      expect(authStatusRes.body.authenticated).toBe(true);
      expect(authStatusRes.body.session_key_name).toBe('test-key');

      // 5. GET /dashboard/api/stats with session cookie (and NO Authorization header) succeeds with 200
      const statsWithCookieRes = await request(app)
        .get('/dashboard/api/stats')
        .set('Cookie', sessionCookie);
      expect(statsWithCookieRes.status).toBe(200);
      expect(statsWithCookieRes.body.health.db).toBe('ok');

      // 5b. GET /notes with session cookie (proves cookie allows access across all dashboard tabs/pages!)
      const notesWithCookieRes = await request(app)
        .get('/notes')
        .set('Cookie', sessionCookie);
      expect(notesWithCookieRes.status).toBe(200);

      // 6. DELETE /dashboard/api/session clears the cookie
      const logoutRes = await request(app)
        .delete('/dashboard/api/session')
        .set('Cookie', sessionCookie);
      expect(logoutRes.status).toBe(200);
      expect(logoutRes.body.authenticated).toBe(false);
      const clearCookie = logoutRes.headers['set-cookie'][0];
      expect(clearCookie).toContain('Max-Age=0');
    });
  });
});
