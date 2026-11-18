import fs from 'fs';
import http from 'http';
import { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { getDb, resetDb } from '../lib/db';
import { commitStoreMeta } from '../learning/storeMeta';
import {
  resolveEmbedderRecipe,
  embedDocument,
  embedQuery,
  serializeEmbedding,
  deserializeEmbedding,
} from '../learning/embedding';
import { createApp } from '../app';

export interface SmokeTestReport {
  serverStarted: boolean;
  port: number;
  healthOk: boolean;
  storeMetaMatch: boolean;
  dashboardOk: boolean;
  securityHeadersOk: boolean;
  noteCreated: boolean;
  realEmbeddingOk: boolean;
  vectorDimensions: number;
  l2Normalized: boolean;
  hybridSearchOk: boolean;
  searchResultsCount: number;
}

export async function runLiveSmokeTest(): Promise<SmokeTestReport> {
  const originalEnv = { ...process.env };
  const devApiKey = 'brain-dev-key-12345';

  // A smoke test must never seed, read or mutate a real database: a direct
  // writer bypasses validation and the embed queue, and this script writes
  // throwaway rows. Default to a fresh temp file; DATABASE_URL still wins if an
  // operator deliberately points it somewhere.
  process.env.DATABASE_URL =
    process.env.DATABASE_URL?.trim() ||
    path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'brain-smoke-')),
      'smoke.db'
    );
  process.env.BRAIN_REQUIRE_API_KEY = '1';
  process.env.BRAIN_EMBED = 'local';
  process.env.BRAIN_EMBED_MODEL = 'nomic';
  process.env.BRAIN_EMBED_DIM = '512';
  process.env.BRAIN_MODEL_CACHE_DIR = path.resolve(process.cwd(), 'data', 'models');

  resetDb();

  // Commit store_meta for nomic 512
  const recipe = resolveEmbedderRecipe();
  commitStoreMeta(recipe, 'brain');

  // Seed the dev key. This used to be inherited from data/brain.db, which meant
  // the smoke test only passed on a machine that had already been used — it
  // could not run on a fresh checkout or in CI. Seeding it here makes the run
  // self-contained, which is the whole point of a smoke test.
  getDb()
    .prepare(
      `INSERT INTO api_keys (id, name, key) VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING`
    )
    .run(`key_smoke_${Date.now()}`, 'smoke-test', devApiKey);

  const app = createApp();
  const server = http.createServer(app);

  // Bind strictly to 127.0.0.1 on ephemeral port (port 0)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  console.log(`[SmokeTest] Live server started on 127.0.0.1:${addr.port}`);

  try {
    // 1. Check /health
    const healthRes = await fetch(`${baseUrl}/health`);
    const healthJson = await healthRes.json() as any;
    const healthOk = healthRes.status === 200 && healthJson.status === 'ok';
    const storeMetaMatch = healthJson.store_meta?.match === true;
    console.log(`[SmokeTest] 1. /health: ${healthOk ? 'OK' : 'FAIL'} (store_meta match: ${storeMetaMatch})`);

    // 2. Check /dashboard and security headers
    const dashRes = await fetch(`${baseUrl}/dashboard`);
    const csp = dashRes.headers.get('content-security-policy');
    const xcto = dashRes.headers.get('x-content-type-options');
    const xfo = dashRes.headers.get('x-frame-options');
    const dashHtml = await dashRes.text();
    const dashboardOk = dashRes.status === 200 && dashHtml.includes('neuralbrain');
    const securityHeadersOk = Boolean(csp && xcto === 'nosniff' && xfo === 'DENY');
    console.log(`[SmokeTest] 2. /dashboard: ${dashboardOk ? 'OK' : 'FAIL'} (Security headers: ${securityHeadersOk ? 'OK' : 'FAIL'})`);

    // 3. Create Note via API
    const noteRes = await fetch(`${baseUrl}/notes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${devApiKey}`,
      },
      body: JSON.stringify({
        scope: 'project',
        projectId: 'smoke-test-project',
        type: 'fact',
        title: 'Real In-Process Model Smoke Test Note',
        content: 'Verifying in-process ONNX embeddings using nomic-embed-text-v1.5 and SQLite.',
        concepts: ['smoke-test', 'nomic', 'local-model'],
        files: ['src/learning/embedding.ts'],
      }),
    });
    const noteJson = await noteRes.json() as any;
    const noteCreated = noteRes.status === 201 && Boolean(noteJson.id);
    console.log(`[SmokeTest] 3. POST /notes: ${noteCreated ? 'OK' : 'FAIL'} (id: ${noteJson.id})`);

    // 4. Real in-process embedding
    console.log('[SmokeTest] 4. Loading local pipeline nomic-ai/nomic-embed-text-v1.5 from data/models...');
    const vector = await embedDocument('search_document: In-process local transformer embedding test for neuralbrain.');
    const vectorDimensions = vector.length;
    const l2Norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    const l2Normalized = Math.abs(l2Norm - 1.0) < 0.01;
    const realEmbeddingOk = vectorDimensions === 512 && l2Normalized;
    console.log(`[SmokeTest] 4. In-Process Embedding: ${realEmbeddingOk ? 'OK' : 'FAIL'} (${vectorDimensions} dims, L2 norm: ${l2Norm.toFixed(4)})`);

    // Store sample embedding into SQLite
    const db = getDb();
    db.prepare('UPDATE notes SET embedding = ? WHERE id = ?').run(
      serializeEmbedding(vector),
      noteJson.id
    );

    // 5. Query Embedding & POST /search
    const queryVector = await embedQuery('local transformer embedding test');
    const searchRes = await fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${devApiKey}`,
      },
      body: JSON.stringify({
        q: 'local transformer embedding test',
        grains: ['note'],
        project_id: 'smoke-test-project',
        limit: 5,
      }),
    });
    const searchJson = await searchRes.json() as any;
    const searchResultsCount = searchJson.results?.length ?? 0;
    const hybridSearchOk = searchRes.status === 200 && searchResultsCount > 0;
    console.log(`[SmokeTest] 5. POST /search (hybrid): ${hybridSearchOk ? 'OK' : 'FAIL'} (${searchResultsCount} results found)`);

    return {
      serverStarted: true,
      port: addr.port,
      healthOk,
      storeMetaMatch,
      dashboardOk,
      securityHeadersOk,
      noteCreated,
      realEmbeddingOk,
      vectorDimensions,
      l2Normalized,
      hybridSearchOk,
      searchResultsCount,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetDb();
    process.env = { ...originalEnv };
    console.log('[SmokeTest] Server closed and resources released.');
  }
}

if (require.main === module) {
  runLiveSmokeTest()
    .then((report) => {
      console.log('\n[SmokeTest] SUCCESSFUL REPORT:\n', JSON.stringify(report, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n[SmokeTest] FAILED:\n', err);
      process.exit(1);
    });
}
