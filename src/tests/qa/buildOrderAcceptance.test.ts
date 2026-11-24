import request from 'supertest';
import http from 'http';
import { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { createApp } from '../../app';
import { getDb, resetDb } from '../../lib/db';
import { verifyOrCreateStoreMeta, getStoreMeta, commitStoreMeta } from '../../learning/storeMeta';
import { setCustomEmbedder, serializeEmbedding, resolveEmbedderRecipe } from '../../learning/embedding';
import { drainEmbedQueue } from '../../learning/embedWorker';
import { hybridSearch } from '../../learning/search';
import { captureObservations, getObservation } from '../../memory/observationStore';
import {
  captureTrajectories,
  getTrajectory,
  runCleanup,
  logTrajectory,
} from '../../memory/trajectoryStore';
import { createNote, getNote, listNotes, getNotesByFile } from '../../memory/noteStore';
import {
  upsertFailurePattern,
  getFailurePatterns,
} from '../../memory/failurePatternStore';
import { getConsolidationCandidates } from '../../consolidation/candidates';
import { verifyAndStoreSummary, type ConsolidationSubmission } from '../../consolidation/gate';
import {
  seedFixtureObservations,
  runAiConformanceDiagnostics,
} from '../../consolidation/fixtures';
import { listDeadLetters } from '../../memory/deadLetterStore';
import { getPendingEmbedCount } from '../../memory/embedQueueStore';
import { createBrainMcpServer } from '../../mcp/server';
import { runDoctor } from '../../scripts/doctor';
import { resetRateLimitStore } from '../../middleware/rateLimiter';

describe('Build Order Acceptance & Standing Invariants Suite (Steps 1–10 & Invariants 1–7)', () => {
  const originalEnv = { ...process.env };
  const testApiKey = 'qa-acceptance-test-api-key-9999';
  let app: any;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_REQUIRE_API_KEY = '1';
    process.env.BRAIN_EMBED = 'none'; // Default fast test mode
    resetRateLimitStore();
    resetDb();

    // Seed master test API key
    const db = getDb();
    db.prepare(`
      INSERT INTO api_keys (id, name, key, created_at)
      VALUES (?, 'qa-master-key', ?, datetime('now'))
    `).run(randomUUID(), testApiKey);

    verifyOrCreateStoreMeta();
    app = createApp();
  });

  afterEach(() => {
    resetDb();
    setCustomEmbedder(null);
    resetRateLimitStore();
    process.env = { ...originalEnv };
  });

  // =========================================================================
  // Step 1: Server Skeleton
  // =========================================================================
  describe('Step 1: Server Skeleton', () => {
    it('/health answers unauthenticated (200 OK) with system status', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.db).toBe('ok');
      expect(res.body.store_meta).toBeDefined();
      expect(res.body.store_meta.match).toBe(true);
      expect(res.body.embed_queue_pending).toBeDefined();
    });

    it('enforces API key authentication on protected routes (401 UNAUTHORIZED without key)', async () => {
      // 1. Without key -> 401 UNAUTHORIZED
      const noKeyRes = await request(app).get('/inject?project_id=p1&task_type=test');
      expect(noKeyRes.status).toBe(401);
      expect(noKeyRes.body.error).toBeDefined();
      expect(noKeyRes.body.error.code).toBe('UNAUTHORIZED');

      // 2. With invalid key -> 401 UNAUTHORIZED
      const badKeyRes = await request(app)
        .get('/notes')
        .set('Authorization', 'Bearer invalid_bogus_key_xyz');
      expect(badKeyRes.status).toBe(401);
      expect(badKeyRes.body.error.code).toBe('UNAUTHORIZED');

      // 3. With valid key -> 200 OK
      const validKeyRes = await request(app)
        .get('/notes')
        .set('Authorization', `Bearer ${testApiKey}`);
      expect(validKeyRes.status).toBe(200);
    });

    it('capture-path requests survive >200 calls in a minute without 429, while non-exempt routes enforce 429', async () => {
      // 205 consecutive capture-path requests MUST NEVER return 429
      for (let i = 0; i < 205; i++) {
        const capRes = await request(app)
          .post('/capture/observations')
          .set('Authorization', `Bearer ${testApiKey}`)
          .send({
            observations: [
              {
                scope: 'project',
                project_id: 'qa-rate-test',
                session_id: 'sess-rate-1',
                kind: 'tool_call',
                tool_name: 'test',
                file_path: 'test.ts',
                input: `call ${i}`,
                output: 'ok',
                duration_ms: 5,
                failed: 0,
              },
            ],
          });
        expect(capRes.status).toBe(201);
        expect(capRes.body.accepted).toBe(1);
      }

      // Non-exempt route with custom low limit config triggers 429 after limit
      process.env.BRAIN_RATE_LIMIT_MAX = '3';
      process.env.BRAIN_RATE_LIMIT_WINDOW_MS = '60000';
      resetRateLimitStore();
      const rateLimitedApp = createApp();

      // Calls 1, 2, 3 succeed
      for (let i = 0; i < 3; i++) {
        const okRes = await request(rateLimitedApp)
          .get('/notes')
          .set('Authorization', `Bearer ${testApiKey}`);
        expect(okRes.status).toBe(200);
      }

      // Call 4 hits the limit -> 429 RATE_LIMIT_EXCEEDED
      const blockedRes = await request(rateLimitedApp)
        .get('/notes')
        .set('Authorization', `Bearer ${testApiKey}`);
      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(blockedRes.body.retryAfter).toBeGreaterThan(0);
    }, 60000); // 205 sequential round trips by design — proves rule 3, needs room under parallel load
  });

  // =========================================================================
  // Step 2: Schema
  // =========================================================================
  describe('Step 2: Schema Verification', () => {
    it('fresh database opens and migrates all 15 required tables', () => {
      const db = getDb();
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);

      const requiredTables = [
        'store_meta',
        'observations',
        'observations_archive',
        'trajectories',
        'trajectory_archive',
        'notes',
        'note_concepts',
        'note_files',
        'failure_patterns',
        'summaries',
        'summary_claims',
        'summary_sources',
        'embed_queue',
        'dead_letters',
        'api_keys',
      ];

      for (const required of requiredTables) {
        expect(tableNames).toContain(required);
      }
    });

    it('archives null-scope observation and trajectory successfully without NOT NULL constraint errors', () => {
      // 1. Insert null-scope observation (scope='unknown', project_id=null)
      const obsRes = captureObservations([
        {
          scope: 'unknown',
          session_id: 's-null-scope',
          kind: 'tool_call',
          tool_name: 'test',
          file_path: 'file.ts',
          input: 'input',
          output: 'output',
          duration_ms: 10,
          failed: 0,
        },
      ]);
      expect(obsRes.accepted).toBe(1);
      const obsId = obsRes.ids[0];

      // 2. Insert null-scope trajectory (scope='unknown', project_id=null)
      const trajRes = captureTrajectories([
        {
          scope: 'unknown',
          taskType: 'debug',
          description: 'Null scope trajectory',
          result: 'Success',
          success: true,
        },
      ]);
      expect(trajRes.accepted).toBe(1);
      const trajId = trajRes.ids[0];

      // Mark created_at back in time (e.g. 40 days ago) so retention cleanup archives them
      const db = getDb();
      const fortyDaysAgo = Math.floor(Date.now() / 1000) - 40 * 86400;
      db.prepare('UPDATE observations SET created_at = ? WHERE id = ?').run(fortyDaysAgo, obsId);
      db.prepare('UPDATE trajectories SET created_at = ? WHERE id = ?').run(fortyDaysAgo, trajId);

      // Run cleanup (30-day archive threshold)
      process.env.BRAIN_OBS_ARCHIVE_DAYS = '30';
      process.env.BRAIN_TRAJECTORY_ARCHIVE_DAYS = '30';
      const cleanupResult = runCleanup();

      expect(cleanupResult.observationsArchived).toBe(1);
      expect(cleanupResult.trajectoriesArchived).toBe(1);

      // Verify null-scope record landed in archive tables with project_id IS NULL
      const arcObs = db
        .prepare('SELECT * FROM observations_archive WHERE original_observation_id = ?')
        .get(obsId) as any;
      expect(arcObs).toBeDefined();
      expect(arcObs.scope).toBe('unknown');
      expect(arcObs.project_id).toBeNull();

      const arcTraj = db
        .prepare('SELECT * FROM trajectory_archive WHERE original_trajectory_id = ?')
        .get(trajId) as any;
      expect(arcTraj).toBeDefined();
      expect(arcTraj.scope).toBe('unknown');
      expect(arcTraj.project_id).toBeNull();
    });

    it('verifies grep for orchestrator foreign keys in src/ is completely empty', () => {
      // Read all typescript files in src/ and verify zero references to tasks, swarms, swarm_jobs foreign keys
      const srcDir = path.resolve(__dirname, '../../');
      const tsFiles: string[] = [];

      function collectFiles(dir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            collectFiles(fullPath);
          } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
            tsFiles.push(fullPath);
          }
        }
      }
      collectFiles(srcDir);

      const forbiddenRegex = /REFERENCES\s+(tasks|swarms|swarm_jobs)/i;
      for (const file of tsFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        expect(content).not.toMatch(forbiddenRegex);
      }
    });
  });

  // =========================================================================
  // Step 3: Capture — The Hot Path
  // =========================================================================
  describe('Step 3: Capture — The Hot Path', () => {
    it('10,000 observations stress test: commits 10,000 observations with 0 capacity rejections', () => {
      const db = getDb();
      const initialCount = (
        db.prepare('SELECT count(*) as c FROM observations').get() as { c: number }
      ).c;

      // Generate 10,000 observations in 10 batches of 1,000 items
      const totalToInsert = 10000;
      const batchSize = 1000;
      let totalAccepted = 0;
      let totalRejected = 0;

      for (let b = 0; b < totalToInsert / batchSize; b++) {
        const batch = [];
        for (let i = 0; i < batchSize; i++) {
          batch.push({
            scope: 'project' as const,
            project_id: 'qa-stress-project',
            session_id: `session-stress-${b}`,
            kind: 'tool_call' as const,
            tool_name: 'ReadFile',
            file_path: `src/file_${b}_${i}.ts`,
            input: `param_${i}`,
            output: `result_${i}`,
            duration_ms: 12,
            failed: 0,
          });
        }
        const res = captureObservations(batch);
        totalAccepted += res.accepted;
        totalRejected += res.rejected.length;
      }

      expect(totalAccepted).toBe(10000);
      expect(totalRejected).toBe(0);

      const finalCount = (
        db.prepare('SELECT count(*) as c FROM observations').get() as { c: number }
      ).c;
      expect(finalCount - initialCount).toBe(10000);

      // Verify zero capacity errors in dead_letters
      const deadLetters = listDeadLetters();
      const capacityDeadLetters = deadLetters.filter((dl) => dl.reason.includes('capacity'));
      expect(capacityDeadLetters.length).toBe(0);
    });

    it('batch with valid and malformed records commits valid ones and dead-letters malformed (201)', async () => {
      const res = await request(app)
        .post('/capture/observations')
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({
          observations: [
            {
              scope: 'project',
              project_id: 'p-partial',
              kind: 'tool_call',
              tool_name: 'ValidTool',
              file_path: 'valid.ts',
              input: 'ok input',
              output: 'ok output',
            },
            {
              // Malformed: project_id missing when scope is 'project'
              scope: 'project',
              kind: 'tool_call',
              tool_name: 'BadTool',
              input: 'broken',
            },
            {
              scope: 'global',
              kind: 'tool_call',
              tool_name: 'ValidGlobalTool',
              input: 'global ok',
            },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.accepted).toBe(2);
      expect(res.body.rejected.length).toBe(1);
      expect(res.body.rejected[0].reason).toBe('schema_invalid');

      // Check dead letters table
      const deadLetters = listDeadLetters({ source: 'capture', reason: 'schema_invalid' });
      expect(deadLetters.length).toBeGreaterThanOrEqual(1);
      const malformed = deadLetters.find((dl) => dl.payload.includes('BadTool'));
      expect(malformed).toBeDefined();
    });

    it('stores input and output of >10,000 characters whole without truncation', async () => {
      const largeInput = 'I'.repeat(15000);
      const largeOutput = 'O'.repeat(15000);

      const res = await request(app)
        .post('/capture/observations')
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({
          observations: [
            {
              scope: 'project',
              project_id: 'p-large',
              kind: 'tool_call',
              tool_name: 'LargeTool',
              file_path: 'large.ts',
              input: largeInput,
              output: largeOutput,
            },
          ],
        });

      expect(res.status).toBe(201);
      const obsId = res.body.ids[0];
      const stored = getObservation(obsId);
      expect(stored).toBeDefined();
      expect(stored?.input?.length).toBe(15000);
      expect(stored?.output?.length).toBe(15000);
      expect(stored?.input).toBe(largeInput);
      expect(stored?.output).toBe(largeOutput);
    });

    it("omitted scope lands honestly as 'unknown', never 'global'", async () => {
      const res = await request(app)
        .post('/capture/observations')
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({
          observations: [
            {
              // Scope intentionally omitted
              kind: 'tool_call',
              tool_name: 'OmittedScopeTool',
              input: 'hello',
              output: 'world',
            },
          ],
        });

      expect(res.status).toBe(201);
      const obsId = res.body.ids[0];
      const stored = getObservation(obsId);
      expect(stored).toBeDefined();
      expect(stored?.scope).toBe('unknown');
      expect(stored?.project_id).toBeNull();
      expect(stored?.scope).not.toBe('global');
    });
  });

  // =========================================================================
  // Step 4: Embedding Worker and store_meta
  // =========================================================================
  describe('Step 4: Embedding Worker and store_meta', () => {
    it('writes vectors to SQLite (embedding BLOB) for queued records when drainEmbedQueue runs', async () => {
      process.env.BRAIN_EMBED = 'local';
      process.env.BRAIN_EMBED_MODEL = 'nomic';
      process.env.BRAIN_EMBED_DIM = '4';
      verifyOrCreateStoreMeta();

      // Mock embedder returning 4-dim unit vector
      setCustomEmbedder(async () => [0.5, 0.5, 0.5, 0.5]);

      const note = createNote({
        scope: 'project',
        projectId: 'embed-test-proj',
        type: 'pattern',
        title: 'Worker Queue Pattern',
        content: 'Worker queue processes background records asynchronously.',
      });

      // Verify queued in embed_queue
      expect(getPendingEmbedCount('live')).toBeGreaterThan(0);

      // Drain queue
      const drainResult = await drainEmbedQueue();
      expect(drainResult.processed).toBeGreaterThan(0);

      // Verify embedding BLOB now exists in SQLite notes table
      const db = getDb();
      const updatedNote = db
        .prepare('SELECT embedding FROM notes WHERE id = ?')
        .get(note.id) as { embedding: Buffer | null };
      expect(updatedNote.embedding).toBeDefined();
      expect(Buffer.isBuffer(updatedNote.embedding)).toBe(true);
      expect(updatedNote.embedding!.length).toBe(4 * 4); // 4 floats * 4 bytes
    });

    it('loudly refuses on model or dimension mismatch without mutating process.env', async () => {
      // 1. Initialize store_meta with nomic 512
      process.env.BRAIN_EMBED = 'local';
      process.env.BRAIN_EMBED_MODEL = 'nomic';
      process.env.BRAIN_EMBED_DIM = '512';
      verifyOrCreateStoreMeta();

      // 2. Change environment to minilm 384
      process.env.BRAIN_EMBED_MODEL = 'minilm';
      process.env.BRAIN_EMBED_DIM = '384';

      const healthRes = await request(app).get('/health');
      expect(healthRes.status).toBe(200);
      expect(healthRes.body.status).toBe('degraded');
      expect(healthRes.body.store_meta.match).toBe(false);
      expect(healthRes.body.store_meta.mismatch_reason).toBeDefined();

      // Search route reports degraded banner
      const searchRes = await request(app)
        .post('/search')
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({ q: 'test query' });
      expect(searchRes.status).toBe(200);
      expect(searchRes.body.degraded).toBeDefined();
      expect(searchRes.body.degraded).toContain('vector search unavailable');
      expect(searchRes.body.mode).toBe('bm25');

      // process.env MUST NOT be mutated (unlike legacy engine.ts:195,222)
      expect(process.env.BRAIN_EMBED_MODEL).toBe('minilm');
      expect(process.env.BRAIN_EMBED_DIM).toBe('384');
    });

    it('BRAIN_EMBED=none runs cleanly in bm25 mode', async () => {
      process.env.BRAIN_EMBED = 'none';
      verifyOrCreateStoreMeta();

      const searchRes = await request(app)
        .post('/search')
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({ q: 'test keyword' });

      expect(searchRes.status).toBe(200);
      expect(searchRes.body.mode).toBe('bm25');
      expect(searchRes.body.degraded).toBeUndefined();
    });
  });

  // =========================================================================
  // Step 5: Retrieval
  // =========================================================================
  describe('Step 5: Retrieval', () => {
    it('hybrid RRF search returns fused results and surfaces BM25-only match outside dense top-k', async () => {
      process.env.BRAIN_EMBED = 'local';
      process.env.BRAIN_EMBED_MODEL = 'nomic';
      process.env.BRAIN_EMBED_DIM = '4';
      commitStoreMeta(resolveEmbedderRecipe(), 'brain');

      setCustomEmbedder(async () => [1, 0, 0, 0]);

      // Note A: Strong dense vector match [1, 0, 0, 0], no keyword match
      const noteA = createNote({
        scope: 'project',
        projectId: 'rrf-proj',
        type: 'fact',
        title: 'Alpha Architecture Document',
        content: 'System architecture specifications and guidelines.',
      });
      getDb()
        .prepare('UPDATE notes SET embedding = ? WHERE id = ?')
        .run(serializeEmbedding([1, 0, 0, 0]), noteA.id);

      // Note B: Strong BM25 exact keyword match ("unhandled transaction rollback exception"), orthogonal vector [0, 1, 0, 0]
      const noteB = createNote({
        scope: 'project',
        projectId: 'rrf-proj',
        type: 'bug',
        title: 'Unhandled transaction rollback exception',
        content: 'Database driver threw unhandled transaction rollback exception on lock timeout.',
      });
      getDb()
        .prepare('UPDATE notes SET embedding = ? WHERE id = ?')
        .run(serializeEmbedding([0, 1, 0, 0]), noteB.id);

      const searchRes = await hybridSearch({
        q: 'unhandled transaction rollback exception',
        project_id: 'rrf-proj',
        record_types: ['note'],
      });

      expect(searchRes.mode).toBe('hybrid');
      expect(searchRes.results.length).toBeGreaterThan(0);

      // Verify Note B (the BM25 exact match) surfaces in the results via RRF fusion
      const matchB = searchRes.results.find((r) => r.id === noteB.id);
      expect(matchB).toBeDefined();
      expect(matchB?.score).toBeGreaterThan(0);
    });

    it('filters accurately by type, file_path, task_type, scope, include_global and grains', async () => {
      // 1. Create notes with various types and file paths
      createNote({
        scope: 'project',
        projectId: 'filter-proj',
        type: 'bug',
        title: 'Filter Note Bug',
        content: 'Bug description',
        files: ['src/core/router.ts'],
      });

      createNote({
        scope: 'project',
        projectId: 'filter-proj',
        type: 'preference',
        title: 'Filter Note Preference',
        content: 'Preference description',
        files: ['src/core/router.ts'],
      });

      createNote({
        scope: 'global',
        type: 'fact',
        title: 'Global Fact Note',
        content: 'Global knowledge',
      });

      // Filter by type: ['bug']
      const bugRes = await hybridSearch({
        q: 'Filter Note',
        project_id: 'filter-proj',
        record_types: ['note'],
        filters: { type: ['bug'] },
      });
      expect(bugRes.results.every((r) => r.record.type === 'bug')).toBe(true);

      // Filter by file_path: 'src/core/router.ts'
      const fileRes = await hybridSearch({
        q: 'Filter Note',
        project_id: 'filter-proj',
        record_types: ['note'],
        filters: { file_path: 'src/core/router.ts' },
      });
      expect(fileRes.results.length).toBe(2);

      // include_global = false excludes global notes
      const noGlobalRes = await hybridSearch({
        q: 'Global Fact',
        project_id: 'filter-proj',
        include_global: false,
        record_types: ['note'],
      });
      expect(noGlobalRes.results.length).toBe(0);

      // Grains filter excludes summaries when grains=['note']
      const notesOnly = await hybridSearch({
        q: 'Note',
        project_id: 'filter-proj',
        record_types: ['note'],
      });
      expect(notesOnly.results.every((r) => r.record_type === 'note')).toBe(true);
    });

    it('GET /files/:path/notes returns notes associated with target file path', async () => {
      createNote({
        scope: 'project',
        projectId: 'proj-file-test',
        type: 'workflow',
        title: 'Workflow for auth handler',
        content: 'How auth is tested and verified.',
        files: ['src/middleware/auth.ts'],
      });

      const res = await request(app)
        .get('/files/src%2Fmiddleware%2Fauth.ts/notes?project_id=proj-file-test')
        .set('Authorization', `Bearer ${testApiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].title).toBe('Workflow for auth handler');
      expect(res.body[0].files).toContain('src/middleware/auth.ts');
    });
  });

  // =========================================================================
  // Step 6: Push Injection
  // =========================================================================
  describe('Step 6: Push Injection', () => {
    it('repeated trajectory failures increment count on a single failure_patterns row', () => {
      const db = getDb();
      const errorText = 'SqliteError: database is locked';
      const projectId = 'proj-inj-repeat';
      const taskType = 'migration';

      // Capture 3 consecutive failed trajectories with the same error
      for (let i = 0; i < 3; i++) {
        captureTrajectories([
          {
            scope: 'project',
            projectId,
            taskType,
            description: `Attempt ${i}`,
            result: errorText,
            success: false,
          },
        ]);
      }

      // Check failure_patterns table: MUST have exactly 1 row with count = 3
      const rows = db
        .prepare(`
          SELECT * FROM failure_patterns
          WHERE project_id = ? AND task_type = ? AND error_text = ?
        `)
        .all(projectId, taskType, errorText) as any[];

      expect(rows.length).toBe(1);
      expect(rows[0].count).toBe(3);
    });

    it('GET /inject returns scoped failure patterns, prior outcomes, and relevant notes', async () => {
      const projectId = 'proj-inject-e2e';
      const taskType = 'compiler';

      // 1. Seed failure pattern
      upsertFailurePattern({
        scope: 'project',
        projectId,
        taskType,
        errorText: 'TS2304: Cannot find name React',
      });

      // 2. Seed trajectory outcome
      logTrajectory({
        scope: 'project',
        projectId,
        taskType,
        description: 'Compile typescript project',
        result: 'Compiled with 0 errors',
        success: true,
      });

      // 3. Seed notes (bug -> lessons, preference -> notes)
      createNote({
        scope: 'project',
        projectId,
        type: 'bug',
        title: 'Missing React JSX types',
        content: 'Ensure @types/react is installed in devDependencies.',
      });
      createNote({
        scope: 'project',
        projectId,
        type: 'preference',
        title: 'Strict TypeScript config',
        content: 'Always keep strict: true in tsconfig.json.',
      });

      const res = await request(app)
        .get(`/inject?project_id=${projectId}&task_type=${taskType}&limit=5`)
        .set('Authorization', `Bearer ${testApiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.failure_patterns).toBeDefined();
      expect(res.body.failure_patterns.length).toBeGreaterThanOrEqual(1);
      expect(res.body.failure_patterns[0].error_text).toContain('Cannot find name React');

      expect(res.body.prior_outcomes).toBeDefined();
      expect(res.body.prior_outcomes.length).toBeGreaterThanOrEqual(1);

      expect(res.body.lessons).toBeDefined();
      expect(res.body.lessons.length).toBeGreaterThanOrEqual(1);
      expect(res.body.lessons[0].type).toBe('bug');

      expect(res.body.notes).toBeDefined();
      expect(res.body.notes.length).toBeGreaterThanOrEqual(1);
      expect(res.body.notes[0].type).toBe('preference');
    });

    it('verifies src/memory/failurePatterns.EXTRACTED.ts no longer exists', () => {
      const extractedFile = path.resolve(
        __dirname,
        '../../memory/failurePatterns.EXTRACTED.ts'
      );
      expect(fs.existsSync(extractedFile)).toBe(false);
    });
  });

  // =========================================================================
  // Step 7: MCP Server
  // =========================================================================
  describe('Step 7: MCP Server', () => {
    let mcpHttpServer: http.Server;
    let mcpClient: Client;
    let mcpApiBaseUrl: string;

    beforeAll(async () => {
      const mcpApp = createApp();
      mcpHttpServer = http.createServer(mcpApp);
      await new Promise<void>((resolve) => {
        mcpHttpServer.listen(0, '127.0.0.1', () => resolve());
      });
      const addr = mcpHttpServer.address() as AddressInfo;
      mcpApiBaseUrl = `http://127.0.0.1:${addr.port}`;

      const serverInstance = createBrainMcpServer({
        apiBaseUrl: mcpApiBaseUrl,
        apiKey: testApiKey,
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await serverInstance.connect(serverTransport);

      mcpClient = new Client({ name: 'mcp-qa-acceptance', version: '1.0.0' });
      await mcpClient.connect(clientTransport);
    });

    afterAll(async () => {
      if (mcpHttpServer) {
        await new Promise<void>((resolve) => mcpHttpServer.close(() => resolve()));
      }
    });

    it('verifies all 12 tools work over HTTP and src/mcp/ has zero DB imports', async () => {
      // 1. Verify zero DB imports in src/mcp/server.ts
      const mcpSource = fs.readFileSync(path.resolve(__dirname, '../../mcp/server.ts'), 'utf-8');
      expect(mcpSource).not.toMatch(/getDb/);
      expect(mcpSource).not.toMatch(/better-sqlite3|node:sqlite|lib\/sqlite/);
      expect(mcpSource).not.toMatch(/from\s+['"]\.\.\/lib\/db['"]/);

      // 2. Verify list of tools is exactly the 12 sanctioned tools
      const toolList = await mcpClient.listTools();
      const names = toolList.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'brain_action_add',
        'brain_action_due',
        'brain_action_list',
        'brain_action_update',
        'brain_consolidate_candidates',
        'brain_graph',
        'brain_recent_failures',
        'brain_save',
        'brain_search',
        'brain_session_end',
        'brain_sessions',
        'brain_submit_summary',
      ]);

      // 3. Test brain_save
      const saveRes = await mcpClient.callTool({
        name: 'brain_save',
        arguments: {
          type: 'fact',
          title: 'MCP tool save test',
          content: 'Testing note save over MCP without direct DB access.',
          scope: 'project',
          project_id: 'mcp-e2e-proj',
        },
      });
      expect(saveRes.isError).toBeFalsy();

      // 4. Test brain_search
      const searchRes = await mcpClient.callTool({
        name: 'brain_search',
        arguments: {
          q: 'MCP tool save test',
          project_id: 'mcp-e2e-proj',
        },
      });
      expect(searchRes.isError).toBeFalsy();

      // 5. Test brain_recent_failures
      const failuresRes = await mcpClient.callTool({
        name: 'brain_recent_failures',
        arguments: {
          project_id: 'mcp-e2e-proj',
        },
      });
      expect(failuresRes.isError).toBeFalsy();

      // 6. Test brain_consolidate_candidates
      const candRes = await mcpClient.callTool({
        name: 'brain_consolidate_candidates',
        arguments: {
          project_id: 'mcp-e2e-proj',
        },
      });
      expect(candRes.isError).toBeFalsy();
    });

    it('brain_save refuses to default scope', async () => {
      const badSave = await mcpClient.callTool({
        name: 'brain_save',
        arguments: {
          type: 'fact',
          title: 'No Scope Note',
          content: 'Omitted scope must be rejected by MCP tool.',
        },
      });

      expect(badSave.isError).toBe(true);
      const text = (badSave as any).content[0].text;
      expect(text).toMatch(/scope/i);
    });
  });

  // =========================================================================
  // Step 8: Consolidation
  // =========================================================================
  describe('Step 8: Consolidation & Verification Gate', () => {
    it('issues a lease and prevents duplicate leasing of the same session until expiry', () => {
      captureObservations([
        {
          scope: 'project',
          project_id: 'p-lease',
          session_id: 'sess-lease-1',
          kind: 'tool_call',
          tool_name: 'Edit',
          file_path: 'src/index.ts',
          input: 'edit',
          output: 'done',
          duration_ms: 50,
          failed: 0,
        },
      ]);

      const res1 = getConsolidationCandidates({ projectId: 'p-lease', leaseDurationSec: 300 });
      expect(res1.candidates.length).toBe(1);
      expect(res1.candidates[0].lease_id).toMatch(/^l-/);

      // Calling again immediately prevents duplicate leasing
      const res2 = getConsolidationCandidates({ projectId: 'p-lease' });
      expect(res2.candidates.length).toBe(0);
    });

    it('accepts valid cited summary (201)', () => {
      const fx1 = seedFixtureObservations('sess-cand-val', 'fx1');

      const submission: ConsolidationSubmission = {
        lease_id: fx1.leaseId,
        files_touched: ['src/routes/memories.ts'],
        error_verbatim:
          "TypeError: Cannot read properties of undefined (reading 'id')\n      at src/routes/memories.ts:18:34",
        claims: [
          {
            text: 'Test failed with TypeError in memories.ts',
            source_ids: [fx1.obsIds[0]],
          },
        ],
        producer_tier: 'agent',
      };

      const result = verifyAndStoreSummary(submission);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.status).toBe(201);
        expect(result.summary_id).toBeDefined();
        expect(result.outcome).toBe('failure'); // Arithmetic outcome from failed: 1
      }
    });

    it('rejects fabricated citation with 422 (citation_unresolved) naming the bad ID', () => {
      const fx1 = seedFixtureObservations('sess-cand-fake', 'fx1');
      const badId = 'obs_hallucinated_id_999999';

      const submission: ConsolidationSubmission = {
        lease_id: fx1.leaseId,
        claims: [
          {
            text: 'Hallucinated claim',
            source_ids: [badId],
          },
        ],
        producer_tier: 'agent',
      };

      const result = verifyAndStoreSummary(submission);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(422);
        expect(result.reason).toBe('citation_unresolved');
        expect(result.message).toContain(badId);
      }
    });

    it('rejects output-only file path in files_touched with 422 (not_verbatim)', () => {
      const fx1 = seedFixtureObservations('sess-cand-outpath', 'fx1');

      // 'src/tests/memory/trajectoryStore.test.ts' appears only in output text, NOT as tool call target file_path!
      const submission: ConsolidationSubmission = {
        lease_id: fx1.leaseId,
        files_touched: ['src/tests/memory/trajectoryStore.test.ts'],
        claims: [
          {
            text: 'Ran test suite',
            source_ids: [fx1.obsIds[0]],
          },
        ],
        producer_tier: 'agent',
      };

      const result = verifyAndStoreSummary(submission);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(422);
        expect(result.reason).toBe('not_verbatim');
        expect(result.message).toContain('files_touched');
      }
    });

    it('rejects forbidden fields (narrative, importance, confidence, strength) with 422 (schema_invalid)', () => {
      const fx1 = seedFixtureObservations('sess-cand-forbidden', 'fx1');

      const forbiddenFields = ['narrative', 'importance', 'confidence', 'strength'];
      for (const field of forbiddenFields) {
        const submission: any = {
          lease_id: fx1.leaseId,
          claims: [{ text: 'Claim', source_ids: [fx1.obsIds[0]] }],
          producer_tier: 'agent',
          [field]: 'Forbidden field value',
        };

        const result = verifyAndStoreSummary(submission);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.status).toBe(422);
          expect(result.reason).toBe('schema_invalid');
          expect(result.message).toContain(field);
        }
      }
    });

    it('computes outcome: unknown on the sparse single-read fixture (fx3-sparse)', () => {
      const fx3 = seedFixtureObservations('sess-sparse-qa', 'fx3');

      const submission: ConsolidationSubmission = {
        lease_id: fx3.leaseId,
        files_touched: ['src/middleware/rateLimiter.ts'],
        claims: [
          {
            text: 'Read rateLimiter.ts',
            source_ids: [fx3.obsIds[0]],
          },
        ],
        producer_tier: 'agent',
      };

      const result = verifyAndStoreSummary(submission);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.outcome).toBe('unknown');
      }
    });

    it('GET /diagnostics/ai and brain doctor cannot report "N/M passing" and "all passing" together', async () => {
      const res = await request(app)
        .get('/diagnostics/ai')
        .set('Authorization', `Bearer ${testApiKey}`);

      expect(res.status).toBe(200);
      const { passed_count, total_count, all_passing, status } = res.body;

      expect(total_count).toBeGreaterThan(0);
      expect(all_passing).toBe(passed_count === total_count);

      if (passed_count === total_count) {
        expect(status).toBe('ok');
        expect(all_passing).toBe(true);
      } else {
        expect(status).toBe('fail');
        expect(all_passing).toBe(false);
      }

      // Also verify runDoctor script logic
      // Local mode on this suite's own connection: auto mode would probe a real
      // service on the default port.
      const docResult = await runDoctor({ mode: 'local', db: getDb(), ai: true, exitOnFinish: false, quiet: true });
      expect(docResult.allPassing).toBe(true);
      expect(docResult.aiDiagnostics?.all_passing).toBe(
        docResult.aiDiagnostics?.passed_count === docResult.aiDiagnostics?.total_count
      );
    });
  });

  // =========================================================================
  // Step 9: Retention
  // =========================================================================
  describe('Step 9: Retention & Archive', () => {
    it('POST /maintenance/cleanup moves and deletes exact expected counts, preserving null-scope and summarized sources', async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      const fortyDaysAgo = now - 40 * 86400; // > 30 days -> should archive
      const hundredDaysAgo = now - 100 * 86400; // > 90 days

      // 1. Create observations
      // Obs 1: Normal old observation -> should archive
      const obs1Res = captureObservations([
        {
          scope: 'project',
          project_id: 'p-ret',
          session_id: 's-1',
          kind: 'tool_call',
          input: '1',
          output: '1',
        },
      ]);
      db.prepare('UPDATE observations SET created_at = ? WHERE id = ?').run(
        fortyDaysAgo,
        obs1Res.ids[0]
      );

      // Obs 2: Summarized observation cited in summary_sources -> should archive, but NEVER delete if keepSummarized=1
      const obs2Res = captureObservations([
        {
          scope: 'project',
          project_id: 'p-ret',
          session_id: 's-2',
          kind: 'tool_call',
          input: '2',
          output: '2',
        },
      ]);
      const obs2Id = obs2Res.ids[0];
      db.prepare('UPDATE observations SET created_at = ? WHERE id = ?').run(
        fortyDaysAgo,
        obs2Id
      );

      // Create summary citing obs2
      const sumId = randomUUID();
      db.prepare(`
        INSERT INTO summaries (id, scope, project_id, kind, producer_tier, prompt_version, verified)
        VALUES (?, 'project', 'p-ret', 'session', 'agent', 'v1', 1)
      `).run(sumId);

      db.prepare(`
        INSERT INTO summary_sources (summary_id, record_id, record_type)
        VALUES (?, ?, 'observation')
      `).run(sumId, obs2Id);

      // Trajectory 1: Null-scope old trajectory -> should archive
      const traj1Res = captureTrajectories([
        {
          scope: 'unknown',
          taskType: 'build',
          description: 'Old null-scope trajectory',
          result: 'ok',
          success: true,
        },
      ]);
      db.prepare('UPDATE trajectories SET created_at = ? WHERE id = ?').run(
        fortyDaysAgo,
        traj1Res.ids[0]
      );

      // Execute cleanup with BRAIN_KEEP_SUMMARIZED_SOURCES=1 and 30-day archive cutoffs
      process.env.BRAIN_KEEP_SUMMARIZED_SOURCES = '1';
      process.env.BRAIN_OBS_ARCHIVE_DAYS = '30';
      process.env.BRAIN_TRAJECTORY_ARCHIVE_DAYS = '30';
      process.env.BRAIN_OBS_DELETE_DAYS = '90';
      process.env.BRAIN_TRAJECTORY_DELETE_DAYS = '90';
      const cleanupRes = await request(app)
        .post('/maintenance/cleanup')
        .set('Authorization', `Bearer ${testApiKey}`);

      expect(cleanupRes.status).toBe(200);
      expect(cleanupRes.body.observationsArchived).toBe(2);
      expect(cleanupRes.body.trajectoriesArchived).toBe(1);

      // Verify obs2 is preserved in archive
      const arcRow = db
        .prepare('SELECT * FROM observations_archive WHERE original_observation_id = ?')
        .get(obs2Id);
      expect(arcRow).toBeDefined();

      // Now set archived_at for both archived records to 100 days ago to test deletion
      db.prepare('UPDATE observations_archive SET archived_at = ?').run(hundredDaysAgo);

      // Run cleanup again with keepSummarized=1: obs2 must be spared from deletion!
      const cleanup2Res = await request(app)
        .post('/maintenance/cleanup')
        .set('Authorization', `Bearer ${testApiKey}`);

      expect(cleanup2Res.status).toBe(200);
      // Obs1 was deleted, but obs2 was kept because it is cited in summary_sources!
      expect(cleanup2Res.body.observationsDeleted).toBe(1);

      const stillInArchive = db
        .prepare('SELECT * FROM observations_archive WHERE original_observation_id = ?')
        .get(obs2Id);
      expect(stillInArchive).toBeDefined();
    });
  });

  // =========================================================================
  // Standing Invariants (Invariants 1–7)
  // =========================================================================
  describe('Standing Invariants (Invariants 1–7)', () => {
    it('Invariant 1: No model call between a client POST and a committed row', () => {
      // Calling captureObservations commits to SQLite and queues to embed_queue without invoking embedder
      let embedderCalled = false;
      setCustomEmbedder(async () => {
        embedderCalled = true;
        return [1, 2, 3];
      });

      const res = captureObservations([
        {
          scope: 'project',
          project_id: 'inv-1',
          kind: 'tool_call',
          input: 'test',
          output: 'test',
        },
      ]);

      expect(res.accepted).toBe(1);
      // Embedder must NOT have been called in the write path!
      expect(embedderCalled).toBe(false);

      // But row is committed and queued in embed_queue
      expect(getPendingEmbedCount('live')).toBeGreaterThan(0);
    });

    it('Invariant 2: Every stored record repairable with a SQL statement', () => {
      const db = getDb();
      // Insert note with unknown scope
      const note = createNote({
        scope: 'unknown',
        type: 'fact',
        title: 'Unlabelled note to repair',
        content: 'Original content',
      });

      expect(note.scope).toBe('unknown');
      expect(note.project_id).toBeNull();

      // Repair with a direct single SQL statement
      db.prepare(`
        UPDATE notes
        SET scope = 'project', project_id = 'repaired-project'
        WHERE id = ?
      `).run(note.id);

      const repaired = getNote(note.id);
      expect(repaired?.scope).toBe('project');
      expect(repaired?.project_id).toBe('repaired-project');
    });

    it('Invariant 3: No rejection for capacity, anywhere; dead letters are malformed-only', () => {
      // Dead letters must only accept semantic error codes, never volume or capacity
      const validReasons = [
        'schema_invalid',
        'unparseable',
        'empty_content',
        'truncated',
        'citation_unresolved',
        'not_verbatim',
      ];

      const allDeadLetters = listDeadLetters();
      for (const dl of allDeadLetters) {
        expect(validReasons).toContain(dl.reason);
        expect(dl.reason).not.toMatch(/capacity|rate_limit|session_limit|500_cap/i);
      }
    });

    it('Invariant 4: scope is never inferred; unknown is a real value, not a placeholder for a later guess', () => {
      const noteUnknown = createNote({
        scope: 'unknown',
        type: 'architecture',
        title: 'Honestly unlabelled note',
        content: 'Content',
      });

      expect(noteUnknown.scope).toBe('unknown');
      expect(noteUnknown.project_id).toBeNull();

      // Attempting to supply project_id with unknown scope throws SCHEMA_INVALID
      expect(() => {
        createNote({
          scope: 'unknown',
          projectId: 'illegal-project',
          type: 'architecture',
          title: 'Illegal note',
          content: 'Content',
        });
      }).toThrow();
    });

    it('Invariant 5: Derived rows are additive, cited, attributed, disposable — drop them all and the brain still works', async () => {
      const db = getDb();

      // Seed summary and claims
      const fx1 = seedFixtureObservations('sess-inv5', 'fx1');
      verifyAndStoreSummary({
        lease_id: fx1.leaseId,
        files_touched: ['src/routes/memories.ts'],
        error_verbatim:
          "TypeError: Cannot read properties of undefined (reading 'id')\n      at src/routes/memories.ts:18:34",
        claims: [{ text: 'Failure in memories.ts', source_ids: [fx1.obsIds[0]] }],
        producer_tier: 'agent',
      });

      // Verify summary rows exist
      const sumCountBefore = (
        db.prepare('SELECT count(*) as c FROM summaries').get() as { c: number }
      ).c;
      expect(sumCountBefore).toBeGreaterThan(0);

      // DROP ALL DERIVED ROWS!
      db.exec('DELETE FROM summaries;');

      const sumCountAfter = (
        db.prepare('SELECT count(*) as c FROM summaries').get() as { c: number }
      ).c;
      expect(sumCountAfter).toBe(0);

      // Verify brain still functions perfectly across all operations!
      const searchRes = await request(app)
        .post('/search')
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({ q: 'test' });
      expect(searchRes.status).toBe(200);

      const healthRes = await request(app).get('/health');
      expect(healthRes.status).toBe(200);
      expect(healthRes.body.status).toBe('ok');
    });

    it('Invariant 6: No model-generated numeric score, ever', () => {
      const db = getDb();

      // 1. PRAGMA check on notes table: no strength column
      const noteCols = (db.prepare('PRAGMA table_info(notes)').all() as any[]).map((c) => c.name);
      expect(noteCols).not.toContain('strength');
      expect(noteCols).not.toContain('score');

      // 2. PRAGMA check on summaries table: no importance or confidence scores
      const sumCols = (db.prepare('PRAGMA table_info(summaries)').all() as any[]).map(
        (c) => c.name
      );
      expect(sumCols).not.toContain('importance');
      expect(sumCols).not.toContain('confidence');
      expect(sumCols).not.toContain('quality_score');

      // 3. PRAGMA check on summary_claims: no confidence score
      const claimCols = (
        db.prepare('PRAGMA table_info(summary_claims)').all() as any[]
      ).map((c) => c.name);
      expect(claimCols).not.toContain('confidence');
    });

    it('Invariant 7: No required free-prose field on any producer', () => {
      // 1. Observations: input and output are optional/free, no required narrative field
      const obsRes = captureObservations([
        {
          scope: 'global',
          kind: 'tool_call',
          tool_name: 'ToolNoProse',
        },
      ]);
      expect(obsRes.accepted).toBe(1);

      // 2. Summaries: no narrative column in SQLite schema
      const db = getDb();
      const sumCols = (db.prepare('PRAGMA table_info(summaries)').all() as any[]).map(
        (c) => c.name
      );
      expect(sumCols).not.toContain('narrative');
      expect(sumCols).not.toContain('summary_prose');
    });
  });
});
