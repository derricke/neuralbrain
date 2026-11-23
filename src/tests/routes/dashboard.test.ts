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
import { createAction } from '../../memory/actionStore';
import { upsertEntity } from '../../memory/graphStore';
import { startSession } from '../../memory/sessionStore';

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
      expect(res.text).toContain('id="searchCheckAncestors"');
      expect(res.text).toContain('id="searchCheckChildren"');
      expect(res.text).toContain('id="searchCheckHistory"');
      expect(res.text).toContain('id="searchInputUserId"');
      expect(res.text).toContain('id="searchInputAfter"');
      expect(res.text).toContain('id="searchInputBefore"');
      expect(res.text).toContain('id="searchSelectTemporalBias"');
      expect(res.text).toContain('id="recordTypeCheckEntity"');
      expect(res.text).toContain('id="recordTypeCheckAction"');
      expect(res.text).toContain('id="injectProjectDropdownWrapper"');
      expect(res.text).toContain('id="injectInputProject"');
      expect(res.text).toContain('id="injectInputTaskType"');
      expect(res.text).toContain('id="injectCheckAncestors"');
      expect(res.text).toContain('id="injectCheckChildren"');
      expect(res.text).toContain('id="injectInputUserId"');

      // Long Term Notes hierarchical & user controls
      expect(res.text).toContain('id="notesCheckAncestors"');
      expect(res.text).toContain('id="notesCheckChildren"');
      expect(res.text).toContain('id="notesInputUserId"');

      // Short Term Sessions & Actions hierarchical / reminder controls
      expect(res.text).toContain('id="shortSessionsCheckAncestors"');
      expect(res.text).toContain('id="shortSessionsCheckChildren"');
      expect(res.text).toContain('id="shortSessionsInputUserId"');
      expect(res.text).toContain('id="shortActionsCheckAncestors"');
      expect(res.text).toContain('id="shortActionsCheckChildren"');
      expect(res.text).toContain('id="shortActionsCheckDueOnly"');
      expect(res.text).toContain('id="shortActionsInputUserId"');
      expect(res.text).toContain('id="btnOpenCreateActionModal"');

      // Graph hierarchical & entity/edge controls
      expect(res.text).toContain('id="graphCheckAncestors"');
      expect(res.text).toContain('id="graphCheckChildren"');
      expect(res.text).toContain('id="graphCheckGlobal"');
      expect(res.text).toContain('id="graphFilterDepth"');
      expect(res.text).toContain('id="graphFilterEntityType"');
      expect(res.text).toContain('id="btnOpenAddEntityModal"');
      expect(res.text).toContain('id="btnOpenLinkNodesModal"');

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
      expect(res.text).toContain('.tier-exact');
      expect(res.text).toContain('.tier-ancestor');
      expect(res.text).toContain('.tier-child');
      expect(res.text).toContain('.tier-global');
      expect(res.text).toContain('.overdue-pill');
      expect(res.text).toContain('.external-ref-link');
      expect(res.text).toContain('.project-hierarchy-cell');
      expect(res.text).toContain('.project-prefix-badge');
      expect(res.text).toContain('.project-row-expandable');
      expect(res.text).toContain('.project-expand-toggle');
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

      // Hierarchical memory, due actions, entities, and safe external_ref handling
      expect(res.text).toContain('createMatchTierBadge');
      expect(res.text).toContain('buildProjectTree');
      expect(res.text).toContain('renderProjectsTableBody');
      expect(res.text).toContain('project-children-badge');
      expect(res.text).not.toContain("createBadge('L' + depth");
      expect(res.text).toContain('createSafeExternalRefNode');
      expect(res.text).toContain('openActionModal');
      expect(res.text).toContain('openAddEntityModal');
      expect(res.text).toContain('openLinkNodesModal');
      expect(res.text).toContain('openDueActionsView');
      expect(res.text).toContain('/dashboard/api/actions/due');
      expect(res.text).toContain('/dashboard/api/graph/entities');
      expect(res.text).toContain('/dashboard/api/graph/edges');
      expect(res.text).toContain('https?:\\/\\/');

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

      // Verify new top-level entity & due-action counts without mutating actions/sessions schemas
      expect(res.body.entities_count).toBe(0);
      expect(res.body.due_actions_count).toBe(0);
      expect(exampleAppProj.entities_count).toBe(0);
    });

    it('GET /dashboard/api/stats reports entities_count, due_actions_count, and project entities_count while preserving actions/sessions schemas', async () => {
      startSession({ id: 'sess-stat-1', scope: 'project', project_id: 'acme/socials/calendar' });
      upsertEntity({
        scope: 'project',
        project_id: 'acme/socials/calendar',
        entity_type: 'tool',
        name: 'Calendar Sync',
        external_ref: 'https://example.com/calendar',
      });
      upsertEntity({
        scope: 'global',
        entity_type: 'brand',
        name: 'Acme Core',
      });
      createAction({
        scope: 'project',
        project_id: 'acme/socials/calendar',
        title: 'Overdue action',
        status: 'ready',
        due_at: '2020-01-01T00:00:00Z',
      });
      createAction({
        scope: 'project',
        project_id: 'acme/socials/calendar',
        title: 'Snoozed action',
        status: 'ready',
        due_at: '2020-01-01T00:00:00Z',
        snooze_until: '2099-01-01T00:00:00Z',
      });
      createAction({
        scope: 'project',
        project_id: 'acme/socials/calendar',
        title: 'Completed action',
        status: 'done',
        due_at: '2020-01-01T00:00:00Z',
      });

      const res = await request(app)
        .get('/dashboard/api/stats')
        .set('Authorization', `Bearer ${testApiKey}`);
      expect(res.status).toBe(200);
      expect(res.body.entities_count).toBe(2);
      expect(res.body.due_actions_count).toBe(1);
      expect(res.body.sessions).toEqual({
        total: 1,
        active: 1,
        completed: 0,
        abandoned: 0,
      });
      expect(res.body.actions).toEqual({
        total: 3,
        ready: 2,
        blocked: 0,
        in_progress: 0,
        done: 1,
      });

      const calProj = res.body.projects.find((p: any) => p.project_id === 'acme/socials/calendar');
      expect(calProj).toBeDefined();
      expect(calProj.entities_count).toBe(1);
    });

    it('supports hierarchical entities, cross-subproject edges, and CSRF/auth protection on /dashboard/api/graph/*', async () => {
      // Auth check
      const unauthList = await request(app).get('/dashboard/api/graph/entities');
      expect(unauthList.status).toBe(401);

      const unauthCreate = await request(app)
        .post('/dashboard/api/graph/entities')
        .send({ scope: 'project', project_id: 'acme', entity_type: 'brand', name: 'Acme' });
      expect(unauthCreate.status).toBe(401);

      // CSRF check: cross-origin without X-Requested-With and non-JSON Content-Type
      const csrfEntityRes = await request(app)
        .post('/dashboard/api/graph/entities')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('Origin', 'https://evil.example')
        .set('Host', '127.0.0.1:3737')
        .set('Content-Type', 'text/plain')
        .send('{"scope":"global","entity_type":"brand","name":"Evil"}');
      expect(csrfEntityRes.status).toBe(403);
      expect(csrfEntityRes.body.error.code).toBe('CSRF_REJECTED');

      const csrfEdgeRes = await request(app)
        .post('/dashboard/api/graph/edges')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('Origin', 'https://evil.example')
        .set('Host', '127.0.0.1:3737')
        .set('Content-Type', 'text/plain')
        .send('{"source_id":"a","target_id":"b","relation":"related_to"}');
      expect(csrfEdgeRes.status).toBe(403);
      expect(csrfEdgeRes.body.error.code).toBe('CSRF_REJECTED');

      const csrfDeleteRes = await request(app)
        .delete('/dashboard/api/graph/edges?id=edge_fake')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('Origin', 'https://evil.example')
        .set('Host', '127.0.0.1:3737');
      expect(csrfDeleteRes.status).toBe(403);
      expect(csrfDeleteRes.body.error.code).toBe('CSRF_REJECTED');

      // Create entities in parent & child subprojects + global
      const rootRes = await request(app)
        .post('/dashboard/api/graph/entities')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({
          scope: 'project',
          project_id: 'acme',
          entity_type: 'brand',
          name: 'Acme Brand',
          external_ref: 'https://example.com/acme',
        });
      expect(rootRes.status).toBe(201);
      expect(rootRes.body.entity.project_id).toBe('acme');

      const calRes = await request(app)
        .post('/dashboard/api/graph/entities')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({
          scope: 'project',
          project_id: 'acme/socials/calendar',
          entity_type: 'tool',
          name: 'Scheduler',
          user_id: 'user-1',
        });
      expect(calRes.status).toBe(201);

      const noteInCogs = createNote({
        scope: 'project',
        projectId: 'acme/cogs',
        type: 'architecture',
        title: 'COGS calculation rule',
        content: 'Compute unit margin before tax.',
      });

      // GET /dashboard/api/graph/entities with ancestors & user_id
      const listRes = await request(app)
        .get('/dashboard/api/graph/entities?project_id=acme/socials/calendar&include_ancestors=true&include_global=false')
        .set('Authorization', `Bearer ${testApiKey}`);
      expect(listRes.status).toBe(200);
      expect(listRes.body.entities.map((e: any) => e.name)).toEqual(['Scheduler', 'Acme Brand']);
      expect(listRes.body.entities[0].match_tier).toBe('exact');
      expect(listRes.body.entities[1].match_tier).toBe('ancestor');

      // Link cross-subproject nodes via POST /dashboard/api/graph/edges
      const linkRes = await request(app)
        .post('/dashboard/api/graph/edges')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({
          source_id: calRes.body.entity.id,
          target_id: noteInCogs.id,
          relation: 'references',
        });
      expect(linkRes.status).toBe(201);
      expect(linkRes.body.edge.source_id).toBe(calRes.body.entity.id);
      expect(linkRes.body.edge.target_id).toBe(noteInCogs.id);
      expect(linkRes.body.edge.relation).toBe('references');

      // Multi-hop graph includes linked cross-subproject note
      const graphRes = await request(app)
        .get('/dashboard/api/graph?project_id=acme/socials/calendar&depth=2&entity_type=tool')
        .set('Authorization', `Bearer ${testApiKey}`);
      expect(graphRes.status).toBe(200);
      expect(graphRes.body.nodes.some((n: any) => n.id === calRes.body.entity.id && n.type === 'entity')).toBe(true);
      expect(graphRes.body.nodes.some((n: any) => n.id === noteInCogs.id)).toBe(true);
      expect(graphRes.body.edges.some((e: any) => e.source === calRes.body.entity.id && e.target === noteInCogs.id && e.type === 'references')).toBe(true);

      // Unlink via DELETE /dashboard/api/graph/edges
      const unlinkRes = await request(app)
        .delete('/dashboard/api/graph/edges')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({ id: linkRes.body.edge.id });
      expect(unlinkRes.status).toBe(200);
      expect(unlinkRes.body.deleted).toBe(1);
    });

    it('GET /dashboard/api/actions/due enforces auth and returns hierarchical due/overdue actions', async () => {
      const unauth = await request(app).get('/dashboard/api/actions/due');
      expect(unauth.status).toBe(401);

      createAction({
        scope: 'project',
        project_id: 'acme',
        title: 'Ancestor overdue action',
        status: 'ready',
        priority: 'urgent',
        due_at: '2020-01-01T00:00:00Z',
        user_id: 'user-1',
      });
      createAction({
        scope: 'project',
        project_id: 'acme/socials/calendar',
        title: 'Exact reminded action',
        status: 'in_progress',
        remind_at: '2020-01-02T00:00:00Z',
        user_id: 'user-1',
      });
      createAction({
        scope: 'project',
        project_id: 'acme/socials/calendar',
        title: 'Snoozed future reminder',
        status: 'ready',
        due_at: '2020-01-01T00:00:00Z',
        snooze_until: '2099-01-01T00:00:00Z',
      });
      createAction({
        scope: 'global',
        title: 'Global due action',
        status: 'ready',
        due_at: '2020-01-03T00:00:00Z',
      });

      const dueRes = await request(app)
        .get('/dashboard/api/actions/due?project_id=acme/socials/calendar&include_ancestors=true&include_global=true')
        .set('Authorization', `Bearer ${testApiKey}`);
      expect(dueRes.status).toBe(200);
      expect(dueRes.body.actions.map((a: any) => a.title)).toEqual([
        'Ancestor overdue action',
        'Exact reminded action',
        'Global due action',
      ]);
      expect(dueRes.body.actions[0].match_tier).toBe('ancestor');
      expect(dueRes.body.actions[0].overdue).toBe(true);
      expect(dueRes.body.actions[1].match_tier).toBe('exact');
      expect(dueRes.body.actions[1].overdue).toBe(false);
      expect(dueRes.body.actions[2].match_tier).toBe('global');

      // Filter by user_id
      const userRes = await request(app)
        .get('/dashboard/api/actions/due?project_id=acme/socials/calendar&include_global=false&user_id=user-1')
        .set('Authorization', `Bearer ${testApiKey}`);
      expect(userRes.status).toBe(200);
      expect(userRes.body.actions).toHaveLength(2);
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

    it('deduplicates retried mutations sharing an Idempotency-Key header', async () => {
      const idemKey = 'idem-test-' + randomUUID();
      const firstRes = await request(app)
        .post('/dashboard/api/drain-embed')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('Idempotency-Key', idemKey);
      expect(firstRes.status).toBe(200);
      expect(firstRes.headers['x-idempotency-replayed']).toBeUndefined();

      const secondRes = await request(app)
        .post('/dashboard/api/drain-embed')
        .set('Authorization', `Bearer ${testApiKey}`)
        .set('Idempotency-Key', idemKey);
      expect(secondRes.status).toBe(200);
      expect(secondRes.headers['x-idempotency-replayed']).toBe('true');
      expect(secondRes.body).toEqual(firstRes.body);
    });
  });

  describe('UI Polish, Design System, UX Features & 12-Column Grid', () => {
    it('enforces visual polish rules in /dashboard/styles.css', async () => {
      const res = await request(app).get('/dashboard/styles.css');
      expect(res.status).toBe(200);
      const css = res.text;

      // 1. Nested rounded corners (inner = outer - padding, outer = inner + padding) & continuous squircle corners
      expect(css).toContain('calc(var(--radius-inner) + var(--card-padding))');
      expect(css).toContain('calc(var(--radius-outer) - var(--card-padding))');
      expect(css).toContain('corner-shape: squircle');

      // 2. Alpha borders
      expect(css).toContain('rgb(0 0 0 / 0.12)');
      expect(css).toContain('rgb(255 255 255 / 0.12)');

      // 3. OKLCH palettes (no hsl() colors)
      expect(css).toContain('oklch(');
      expect(css).not.toMatch(/\bhsl\s*\(/i);

      // 4. Vivid OKLCH gradients
      expect(css).toContain('linear-gradient(90deg in oklch, blue, orange)');
      expect(css).toContain('in oklch');

      // 5. Icon stroke width matched to font weight
      expect(css).toContain('stroke-width: 1.75');
      expect(css).toContain('stroke-width: 2.25');
      expect(css).toContain('stroke-width: 2.5');

      // 6. Carousel edge fade mask
      expect(css).toContain('mask: linear-gradient(90deg, transparent, black 15% 85%, transparent)');

      // 7. Icon swap blur
      expect(css).toContain('filter: blur(4px)');

      // 8. BRANDING.md OKLCH dark mode surface hierarchy
      expect(css).toContain('--bg-base: oklch(0.165');
      expect(css).toContain('--bg-card: oklch(0.208');
      expect(css).toContain('--bg-subtle: oklch(0.250');
      expect(css).toContain('--bg-elevated: oklch(0.310');

      // 9. Full-height 100dvh (no 100vh)
      expect(css).toContain('100dvh');
      expect(css).not.toContain('100vh');
      expect(css).toContain('90dvh');
      expect(css).not.toContain('90vh');

      // 10. Product shots on white
      expect(css).toContain('mix-blend-mode: multiply');
    });

    it('enforces design system rules (4px gaps, 4 font sizes, 2 shadow levels) and 4/8/12 grid', async () => {
      const res = await request(app).get('/dashboard/styles.css');
      expect(res.status).toBe(200);
      const css = res.text;

      // Strict 4 font sizes (--text-xs, --text-sm, --text-md, --text-lg)
      const fontSizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim());
      expect(fontSizes.length).toBeGreaterThan(0);
      for (const fsVal of fontSizes) {
        expect(['var(--text-xs)', 'var(--text-sm)', 'var(--text-md)', 'var(--text-lg)']).toContain(fsVal);
      }

      // Strict multiple-of-4 gaps
      const gaps = [...css.matchAll(/(?:^|\s)gap:\s*([^;]+);/gm)].map((m) => m[1].trim());
      expect(gaps.length).toBeGreaterThan(0);
      for (const gapVal of gaps) {
        expect([
          'var(--space-1)',
          'var(--space-2)',
          'var(--space-4)',
          'var(--space-6)',
          'var(--grid-gap)',
        ]).toContain(gapVal);
      }

      // Strictly 2 shadow levels
      const boxShadows = [...css.matchAll(/box-shadow:\s*([^;]+);/g)].map((m) => m[1].trim());
      expect(boxShadows.length).toBeGreaterThan(0);
      for (const bsVal of boxShadows) {
        expect(['var(--shadow-sm)', 'var(--shadow-lg)']).toContain(bsVal);
      }

      // 12-column responsive grid (4 mobile, 8 tablet, 12 desktop, larger margins centered)
      expect(css).toContain('--grid-columns: 4');
      expect(css).toContain('--grid-columns: 8');
      expect(css).toContain('--grid-columns: 12');
      expect(css).toContain('--page-margin: 16px');
      expect(css).toContain('--page-margin: 32px');
      expect(css).toContain('--page-margin: 48px');
      expect(css).toContain('--page-margin: 64px');
      expect(css).toContain('margin: 0 auto');

      // Tabular numbers, balanced headlines, hit slop, safe-area insets
      expect(css).toContain('font-variant-numeric: tabular-nums');
      expect(css).toContain('text-wrap: balance');
      expect(css).toContain('inset: -8px');
      expect(css).toContain('env(safe-area-inset-top');
      expect(css).toContain('env(safe-area-inset-bottom');
    });

    it('includes all 20 interactive UX patterns in HTML and client JS', async () => {
      const htmlRes = await request(app).get('/dashboard');
      expect(htmlRes.status).toBe(200);
      expect(htmlRes.text).toContain('viewport-fit=cover');
      expect(htmlRes.text).toContain('id="commandMenuOverlay"');
      expect(htmlRes.text).toContain('⌘K');
      expect(htmlRes.text).toContain('autocomplete="one-time-code"');
      expect(htmlRes.text).toContain('id="predictiveBackPreview"');

      const jsRes = await request(app).get('/dashboard/app.js');
      expect(jsRes.status).toBe(200);
      const js = jsRes.text;

      expect(js).toContain('createSkeletonLoader');
      expect(js).toContain('data-optimistic');
      expect(js).toContain('Deploy to production');
      expect(js).toContain('shortcut-hint');
      expect(js).toContain('showUndoToast');
      expect(js).toContain('swrCache');
      expect(js).toContain('updating');
      expect(js).toContain('prerenderTab');
      expect(js).toContain('initBlurHashPlaceholders');
      expect(js).toContain('startViewTransition');
      expect(js).toContain('attachSwipeToDismiss');
      expect(js).toContain('getAnimations');
      expect(js).toContain('initPredictiveBack');
      expect(js).toContain('initOtpAutofill');
      expect(js).toContain('Idempotency-Key');
      expect(js).toContain('isInSafeTriangle');
      expect(js).toContain('swapIconWithBlur');
    });

    it('enforces BRANDING.md palette, typography, contrast, and WCAG 2.2 AA/AAA accessibility rules', async () => {
      const [htmlRes, cssRes, jsRes] = await Promise.all([
        request(app).get('/dashboard'),
        request(app).get('/dashboard/styles.css'),
        request(app).get('/dashboard/app.js'),
      ]);

      expect(htmlRes.status).toBe(200);
      expect(cssRes.status).toBe(200);
      expect(jsRes.status).toBe(200);

      const html = htmlRes.text;
      const css = cssRes.text;
      const js = jsRes.text;

      // BRANDING.md color palette & fonts
      for (const hex of [
        '#0B0F19',
        '#111827',
        '#10B981',
        '#047857',
        '#F59E0B',
        '#FB7185',
        '#F43F5E',
        '#F3F4F6',
        '#9CA3AF',
      ]) {
        expect(css).toContain(hex);
      }
      expect(css).toContain("'Inter'");
      expect(css).toContain("'JetBrains Mono'");

      // Forbidden off-brand colors, glassmorphism, hsl(), and viewport-unit regressions
      for (const asset of [html, css, js]) {
        expect(asset).not.toMatch(/#6B7280/i);
        expect(asset).not.toMatch(/#64748b/i);
        expect(asset).not.toMatch(/#0284c7/i);
        expect(asset).not.toMatch(/#38bdf8/i);
        expect(asset).not.toMatch(/#a855f7/i);
        expect(asset).not.toMatch(/backdrop-filter/i);
        expect(asset).not.toMatch(/\bhsl\s*\(/i);
        expect(asset).not.toContain('100vh');
        expect(asset).not.toContain('90vh');
      }

      // Zero exclamation points in user-facing UI strings (BRANDING.md voice: calmly authoritative)
      const htmlWithoutComments = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE html>/i, '');
      expect(htmlWithoutComments).not.toContain('!');
      const jsStringLiterals: string[] = [];
      for (let i = 0; i < js.length; i++) {
        const ch = js[i];
        if (ch === '/' && js[i + 1] === '/') {
          while (i < js.length && js[i] !== '\n') i++;
        } else if (ch === '/' && js[i + 1] === '*') {
          i += 2;
          while (i < js.length && !(js[i] === '*' && js[i + 1] === '/')) i++;
          i++;
        } else if (ch === "'" || ch === '"') {
          const quote = ch;
          let lit = '';
          i++;
          while (i < js.length && js[i] !== quote) {
            if (js[i] === '\\' && i + 1 < js.length) {
              lit += js[i] + js[i + 1];
              i += 2;
            } else {
              lit += js[i];
              i++;
            }
          }
          jsStringLiterals.push(lit);
        }
      }
      expect(jsStringLiterals.length).toBeGreaterThan(0);
      for (const strLit of jsStringLiterals) {
        expect(strLit).not.toContain('!');
      }

      // Contrast & on-accent text rules
      expect(css).toContain('--text-on-accent: oklch(0.165 0.024 264)');
      expect(css).toMatch(/\.btn-primary\s*\{[^}]*color:\s*var\(--text-on-accent\)/s);
      expect(css).toMatch(/\.btn-emerald\.btn-solid\s*\{[^}]*color:\s*var\(--text-on-accent\)/s);
      expect(css).toMatch(/\.btn-amber\.btn-solid\s*\{[^}]*color:\s*var\(--text-on-accent\)/s);
      expect(css).toMatch(/\.btn-rose\.btn-solid\s*\{[^}]*color:\s*var\(--text-on-accent\)/s);
      expect(css).toMatch(/\.badge-emerald-fill\s*\{[^}]*color:\s*var\(--text-on-accent\)/s);
      expect(css).toMatch(/\.badge-amber-fill\s*\{[^}]*color:\s*var\(--text-on-accent\)/s);
      expect(css).toMatch(/\.badge-rose-fill\s*\{[^}]*color:\s*var\(--text-on-accent\)/s);
      expect(css).toMatch(/\.brand-logo\s*\{[^}]*color:\s*var\(--text-on-accent\)/s);
      expect(css).toMatch(/\.warning-banner\.warning-banner-solid\s*\{[^}]*color:\s*var\(--text-on-accent\)/s);
      expect(css).toMatch(/\.btn:disabled\s*\{[^}]*color:\s*var\(--text-muted\);[^}]*opacity:\s*1;/s);

      // Focus rings, body measure, and provenance
      expect(css).toContain('outline: 2px solid var(--accent-emerald)');
      expect(css).toContain('.command-menu-input:focus-visible');
      expect(css).toContain('max-width: 70ch');
      expect(css).toContain('line-height: 1.6');
      expect(css).toContain('.provenance-line');

      // HTML ARIA landmarks, dialogs, live region, tabs, and icon-control labels
      expect(html).toContain('id="toastContainer" class="toast-container" aria-live="polite"');
      expect(html).toContain('id="modalContainer" class="modal-overlay" role="dialog" aria-modal="true"');
      expect(html).toContain('id="commandMenuOverlay" class="command-menu-overlay" role="dialog" aria-modal="true"');
      expect(html).toContain('class="nav-tabs-container" role="tablist"');
      expect(html).toContain('role="tab" aria-selected="true"');
      expect(html).toContain('class="dropdown-chevron" role="button" tabindex="0" aria-label="Toggle project dropdown"');

      // Client JS accessibility, SVG icons, provenance, and Escape handling
      expect(js).toContain('createSvgIcon');
      expect(js).toContain('createBadge');
      expect(js).toContain('createProvenanceLine');
      expect(js).toContain("'aria-label': 'Close modal'");
      expect(js).toContain("'aria-label': 'Dismiss notification'");
      expect(js).toContain("'aria-label': 'Edit Scope'");
      expect(js).toContain("btn.setAttribute('aria-selected'");
      expect(js).toContain('lastFocusedBeforeModal');
      expect(js).toContain("e.key === 'Escape'");

      // Table wrapping, collapsible summary rows, and removed secondary project carousel
      expect(css).toContain('.table-cell-wrap');
      expect(css).toContain('.table-cell-nowrap');
      expect(css).toContain('.summary-collapsible-row');
      expect(js).toContain('summary-collapsible-row');
      expect(html).not.toContain('id="projectQuickCarousel"');
    });
  });
});
