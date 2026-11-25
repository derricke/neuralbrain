import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { createApp } from '../../app';
import { getDb, resetDb } from '../../lib/db';
import { openDatabase } from '../../lib/sqlite';
import { inspectSchemaAlignment } from '../../lib/storeDiagnostics';
import { serializeEmbedding, resolveEmbedderRecipe } from '../../learning/embedding';
import { detectQueryKindIntent, hybridSearch, parseSignalTags } from '../../learning/search';
import { commitStoreMeta } from '../../learning/storeMeta';
import { detectQuerySignalIntent } from '../../lib/signalTags';
import { createBrainMcpHandlers } from '../../mcp/server';
import { captureObservations, getObservation } from '../../memory/observationStore';
import { runCleanup } from '../../memory/trajectoryStore';
import { createDirectBrainMcpHandlers } from '../../routes/mcp';

describe('signal_tags storage, search boosting, filtering, resilience, and archival', () => {
  const savedDbUrl = process.env.DATABASE_URL;
  const savedEmbed = process.env.BRAIN_EMBED;
  const savedEmbedUrl = process.env.BRAIN_EMBED_URL;
  const savedEmbedModel = process.env.BRAIN_EMBED_MODEL;
  const savedEmbedDim = process.env.BRAIN_EMBED_DIM;

  beforeEach(() => {
    resetDb();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'none';
  });

  afterEach(() => {
    resetDb();
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
    if (savedEmbed === undefined) delete process.env.BRAIN_EMBED;
    else process.env.BRAIN_EMBED = savedEmbed;
    if (savedEmbedUrl === undefined) delete process.env.BRAIN_EMBED_URL;
    else process.env.BRAIN_EMBED_URL = savedEmbedUrl;
    if (savedEmbedModel === undefined) delete process.env.BRAIN_EMBED_MODEL;
    else process.env.BRAIN_EMBED_MODEL = savedEmbedModel;
    if (savedEmbedDim === undefined) delete process.env.BRAIN_EMBED_DIM;
    else process.env.BRAIN_EMBED_DIM = savedEmbedDim;
  });

  it('persists signal_tags additively while keeping raw input/output 100% verbatim and leaving FTS trigger OF list untouched', () => {
    const rawPrompt = 'I strongly prefer Vitest for unit testing, and we recently migrated from Jest to Vitest.';
    const rawAssistant = 'If you prefer Vitest, here are configuration tips you might like.';

    const cap = captureObservations([
      {
        id: 'obs-sig-prompt',
        scope: 'project',
        project_id: 'nb-sig',
        kind: 'prompt',
        input: rawPrompt,
      },
      {
        id: 'obs-sig-resp',
        scope: 'project',
        project_id: 'nb-sig',
        kind: 'response',
        input: 'vitest tips',
        output: rawAssistant,
      },
    ]);
    expect(cap.accepted).toBe(2);

    const promptRow = getObservation('obs-sig-prompt');
    expect(promptRow?.input).toBe(rawPrompt);
    expect(promptRow?.signal_tags).toBe(JSON.stringify(['preference', 'state_update']));

    const respRow = getObservation('obs-sig-resp');
    expect(respRow?.output).toBe(rawAssistant);
    expect(respRow?.signal_tags).toBeNull();

    // Verify trg_fts_observations_au OF list was NOT widened to signal_tags
    const db = getDb();
    const triggerRow = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_fts_observations_au'"
      )
      .get() as { sql: string } | undefined;
    expect(triggerRow?.sql).toContain(
      'AFTER UPDATE OF id, tool_name, file_path, input, output, condensed_text'
    );
    expect(triggerRow?.sql).not.toContain('signal_tags');
  });

  it('boosts preference-tagged observations on recommendation queries', async () => {
    const nowSec = Math.floor(Date.parse('2026-06-15T12:00:00Z') / 1000);
    captureObservations([
      {
        id: 'obs-neutral-chart',
        scope: 'project',
        project_id: 'nb-pref-boost',
        kind: 'prompt',
        // Identical target token frequency ('charting library typescript') without preference cue
        input: 'Checked charting library documentation for typescript dashboard metrics.',
        created_at: nowSec,
      },
      {
        id: 'obs-pref-chart',
        scope: 'project',
        project_id: 'nb-pref-boost',
        kind: 'prompt',
        input: 'I prefer uPlot as our charting library for typescript dashboard metrics.',
        created_at: nowSec,
      },
      {
        id: 'obs-assistant-chart',
        scope: 'project',
        project_id: 'nb-pref-boost',
        kind: 'response',
        output: 'If you prefer a charting library for typescript dashboard metrics, consider Chart.js.',
        created_at: nowSec,
      },
    ]);

    expect(getObservation('obs-neutral-chart')?.signal_tags).toBeNull();
    expect(getObservation('obs-pref-chart')?.signal_tags).toBe('["preference"]');
    expect(getObservation('obs-assistant-chart')?.signal_tags).toBeNull();

    const recRes = await hybridSearch({
      q: 'Which charting library for typescript dashboard metrics would you recommend?',
      project_id: 'nb-pref-boost',
      record_types: ['observation'],
      reference_date: '2026-06-15T12:00:00Z',
    });

    expect(recRes.results.length).toBeGreaterThanOrEqual(2);
    expect(recRes.results[0].id).toBe('obs-pref-chart');
    const prefScore = recRes.results.find((r) => r.id === 'obs-pref-chart')!.score;
    const neutralScore = recRes.results.find((r) => r.id === 'obs-neutral-chart')!.score;
    expect(prefScore).toBeGreaterThan(neutralScore * 1.15);
  });

  it('boosts state_update observations and breaks ties in favor of newer updates on current-state queries (BM25 + Hybrid)', async () => {
    const refMs = Date.parse('2026-06-20T12:00:00Z');
    const twoDaysAgoSec = Math.floor((refMs - 2 * 86_400_000) / 1000);
    const fourMonthsAgoSec = Math.floor((refMs - 120 * 86_400_000) / 1000);

    captureObservations([
      {
        id: 'obs-state-old',
        scope: 'project',
        project_id: 'nb-state-boost',
        kind: 'prompt',
        input: 'We recently switched to Redis for session cache storage.',
        created_at: fourMonthsAgoSec,
      },
      {
        id: 'obs-state-new',
        scope: 'project',
        project_id: 'nb-state-boost',
        kind: 'prompt',
        input: 'We recently switched to Valkey for session cache storage.',
        created_at: twoDaysAgoSec,
      },
      {
        id: 'obs-untagged-cache',
        scope: 'project',
        project_id: 'nb-state-boost',
        kind: 'prompt',
        input: 'Inspected Memcached configuration for session cache storage.',
        created_at: twoDaysAgoSec,
      },
    ]);

    expect(getObservation('obs-state-old')?.signal_tags).toBe('["state_update"]');
    expect(getObservation('obs-state-new')?.signal_tags).toBe('["state_update"]');
    expect(getObservation('obs-untagged-cache')?.signal_tags).toBeNull();

    // 1. BM25 mode
    const bm25Res = await hybridSearch({
      q: 'What engine do we currently use for session cache storage?',
      project_id: 'nb-state-boost',
      record_types: ['observation'],
      reference_date: '2026-06-20T12:00:00Z',
    });

    expect(bm25Res.results.map((r) => r.id)).toEqual([
      'obs-state-new',
      'obs-state-old',
      'obs-untagged-cache',
    ]);
    expect(bm25Res.results[0].score).toBeGreaterThan(bm25Res.results[1].score);
    expect(bm25Res.results[1].score).toBeGreaterThan(bm25Res.results[2].score);

    // 2. Hybrid mode (mocked Qdrant dense scores with equal cosine similarity)
    process.env.BRAIN_EMBED = 'remote';
    process.env.BRAIN_EMBED_URL = 'http://127.0.0.1:1/unreachable-mock';
    process.env.BRAIN_EMBED_MODEL = 'bge-small-en-v1.5';
    process.env.BRAIN_EMBED_DIM = '4';
    commitStoreMeta(resolveEmbedderRecipe());

    const embModule = await import('../../learning/embedding');
    const embedWorkerModule = await import('../../learning/embedWorker');
    const qSpy = jest.spyOn(embModule, 'embedQuery').mockResolvedValue([0.5, 0.5, 0.5, 0.5]);
    const qdrantSpy = jest.spyOn(embedWorkerModule, 'getQdrantClient').mockReturnValue({
      search: async () => [
        { id: 'obs-state-old', score: 0.88, payload: { record_id: 'obs-state-old', record_type: 'observation' } },
        { id: 'obs-state-new', score: 0.88, payload: { record_id: 'obs-state-new', record_type: 'observation' } },
        { id: 'obs-untagged-cache', score: 0.88, payload: { record_id: 'obs-untagged-cache', record_type: 'observation' } },
      ],
    } as any);
    void serializeEmbedding;

    try {
      const hybRes = await hybridSearch({
        q: 'What engine do we currently use for session cache storage?',
        project_id: 'nb-state-boost',
        record_types: ['observation'],
        reference_date: '2026-06-20T12:00:00Z',
      });
      expect(hybRes.mode).toBe('hybrid');
      expect(hybRes.results.map((r) => r.id)).toEqual([
        'obs-state-new',
        'obs-state-old',
        'obs-untagged-cache',
      ]);
    } finally {
      qdrantSpy.mockRestore();
      qSpy.mockRestore();
    }
  });

  it('filters observations safely via filters.signal_tag and survives malformed signal_tags JSON via HTTP 200', async () => {
    // Unit-verify parseSignalTags helper resilience
    expect(parseSignalTags(null)).toEqual([]);
    expect(parseSignalTags(undefined)).toEqual([]);
    expect(parseSignalTags('bad-json')).toEqual([]);
    expect(parseSignalTags('{}')).toEqual([]);
    expect(parseSignalTags('"str"')).toEqual([]);
    expect(parseSignalTags('123')).toEqual([]);
    expect(parseSignalTags('[null, 123, {}, "", "preference"]')).toEqual(['preference']);

    const corruptedJsonValues = [
      'bad-json',
      '{}',
      '{"tag":"preference"}',
      '"str"',
      '"preference"',
      '123',
      '[null]',
      '[null, 123, false]',
    ];

    captureObservations([
      {
        id: 'obs-filter-pref',
        scope: 'project',
        project_id: 'nb-sig-filter',
        kind: 'prompt',
        input: 'I prefer PostgreSQL for transactional storage.',
      },
      {
        id: 'obs-filter-plan',
        scope: 'project',
        project_id: 'nb-sig-filter',
        kind: 'prompt',
        input: "I'm planning to benchmark transactional storage throughput.",
      },
      ...corruptedJsonValues.map((_raw, idx) => ({
        id: `obs-corrupt-sig-${idx}`,
        scope: 'project' as const,
        project_id: 'nb-sig-filter',
        kind: 'prompt' as const,
        input: `Legacy transactional storage note ${idx}`,
      })),
    ]);

    const db = getDb();
    const corruptStmt = db.prepare('UPDATE observations SET signal_tags = ? WHERE id = ?');
    corruptedJsonValues.forEach((payload, idx) => {
      corruptStmt.run(payload, `obs-corrupt-sig-${idx}`);
    });

    const testApiKey = 'test-sig-tags-api-key';
    db.prepare('INSERT INTO api_keys (id, name, key) VALUES (?, ?, ?)').run(
      'key-sig-1',
      'sig-test',
      testApiKey
    );
    const app = createApp();

    // 1. POST /search with filters.signal_tag = 'preference' over rows containing malformed JSON -> HTTP 200
    const prefFilterRes = await request(app)
      .post('/search')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        q: 'transactional storage',
        project_id: 'nb-sig-filter',
        record_types: ['observation'],
        filters: { signal_tag: 'preference' },
      });

    expect(prefFilterRes.status).toBe(200);
    expect(prefFilterRes.body.results.map((r: any) => r.id)).toEqual(['obs-filter-pref']);

    // 2. POST /search with filters.signal_tag = 'planned_action' -> HTTP 200
    const planFilterRes = await request(app)
      .post('/search')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        q: 'transactional storage',
        project_id: 'nb-sig-filter',
        record_types: ['observation'],
        filters: { signal_tag: 'planned_action' },
      });

    expect(planFilterRes.status).toBe(200);
    expect(planFilterRes.body.results.map((r: any) => r.id)).toEqual(['obs-filter-plan']);

    // 3. Parameterized SQL injection probe in filters.signal_tag -> HTTP 200, empty results
    const sqliRes = await request(app)
      .post('/search')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        q: 'transactional storage',
        project_id: 'nb-sig-filter',
        record_types: ['observation'],
        filters: { signal_tag: "' OR 1=1 --" },
      });

    expect(sqliRes.status).toBe(200);
    expect(sqliRes.body.results).toEqual([]);

    // 4. Unfiltered recommendation query over all corrupted signal_tags rows -> HTTP 200, zero 500s
    const unfilteredRecRes = await request(app)
      .post('/search')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        q: 'What transactional storage do you recommend currently?',
        project_id: 'nb-sig-filter',
        record_types: ['observation'],
      });

    expect(unfilteredRecRes.status).toBe(200);
    expect(unfilteredRecRes.body.results[0].id).toBe('obs-filter-pref');

    // 5. Non-string filters.signal_tag (number, array, object) -> HTTP 200, no .trim TypeError
    for (const nonStrSignalTag of [123, ['preference'], { tag: 'preference' }, true]) {
      const nonStrRes = await request(app)
        .post('/search')
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({
          q: 'transactional storage',
          project_id: 'nb-sig-filter',
          record_types: ['observation'],
          filters: { signal_tag: nonStrSignalTag },
        });
      expect(nonStrRes.status).toBe(200);
    }

    // 6. Adversarial non-string fuzzing across ALL filters.*, user_id, and project_id fields -> HTTP 200 (never 500 TypeError)
    const fuzzFiltersRes = await request(app)
      .post('/search')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        q: 'transactional storage',
        project_id: 789,
        include_children: true,
        user_id: 456,
        record_types: ['note', 'trajectory', 'observation', 'summary', 'entity', 'action'],
        filters: {
          signal_tag: 123,
          kind: 123,
          file_path: ['src/lib/db.ts'],
          entity_type: 99,
          agent: true,
          task_type: 42,
          note_ref: { bad: 1 },
          task_ref: ['t1'],
          session_id: 777,
          user_id: 123,
          type: [{ bad: 1 }],
        },
      });
    expect(fuzzFiltersRes.status).toBe(200);

    // 7. MCP REST vs Direct parity for signal_tag on brain_search (bound strictly to 127.0.0.1)
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const port = (server.address() as AddressInfo).port;
      const restHandlers = createBrainMcpHandlers({
        apiBaseUrl: `http://127.0.0.1:${port}`,
        apiKey: testApiKey,
        defaultProjectId: 'nb-sig-filter',
      });
      const directHandlers = createDirectBrainMcpHandlers('nb-sig-filter');

      const mcpArgs = {
        q: 'transactional storage',
        record_types: ['observation'],
        signal_tag: 'planned_action' as const,
      };
      const restOut = await restHandlers.brainSearch(mcpArgs);
      const directOut = await directHandlers.brainSearch(mcpArgs);

      expect((restOut as any).isError).toBeUndefined();
      expect((directOut as any).isError).toBeUndefined();
      expect(JSON.parse(restOut.content[0].text).results.map((r: any) => r.id)).toEqual([
        'obs-filter-plan',
      ]);
      expect(JSON.parse(directOut.content[0].text).results.map((r: any) => r.id)).toEqual([
        'obs-filter-plan',
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('disambiguates ASSISTANT_INTENT_RE vs detectQuerySignalIntent and preserves assistant response priority on past-tense assistant recall', async () => {
    // Forward-looking recommendation / advice queries -> 'general' + wantsPreference: true
    for (const q of [
      'Can you recommend a coffee shop?',
      'Would you suggest any Python tips?',
      'What would you advise?',
    ]) {
      expect(detectQueryKindIntent(q)).toBe('general');
      expect(detectQuerySignalIntent(q)).toEqual({
        wantsPreference: true,
        wantsStateUpdate: false,
      });
    }

    // Past-tense / possessive assistant recall queries -> 'assistant'
    for (const q of [
      'What did you recommend last week?',
      'Which book did you suggest?',
      'Your recipe for sourdough',
    ]) {
      expect(detectQueryKindIntent(q)).toBe('assistant');
    }

    // End-to-end ranking: on an assistant-recall query ("What ... did you recommend?"),
    // an assistant response MUST outrank an equally matched preference-tagged user prompt.
    const nowSec = Math.floor(Date.parse('2026-06-22T12:00:00Z') / 1000);
    captureObservations([
      {
        id: 'obs-asst-recall-prompt',
        scope: 'project',
        project_id: 'nb-asst-disambig',
        kind: 'prompt',
        input: 'I prefer seventyfive percent sourdough hydration ratio for open crumb.',
        created_at: nowSec,
      },
      {
        id: 'obs-asst-recall-resp',
        scope: 'project',
        project_id: 'nb-asst-disambig',
        kind: 'response',
        output: 'Recommended seventyfive percent sourdough hydration ratio for open crumb.',
        created_at: nowSec,
      },
    ]);

    expect(getObservation('obs-asst-recall-prompt')?.signal_tags).toBe('["preference"]');
    expect(getObservation('obs-asst-recall-resp')?.signal_tags).toBeNull();

    const recallRes = await hybridSearch({
      q: 'What sourdough hydration ratio for open crumb did you recommend?',
      project_id: 'nb-asst-disambig',
      record_types: ['observation'],
      reference_date: '2026-06-22T12:00:00Z',
    });

    expect(recallRes.results.length).toBe(2);
    expect(recallRes.results[0].id).toBe('obs-asst-recall-resp');
    expect(recallRes.results[0].score).toBeGreaterThan(recallRes.results[1].score);

    // Hybrid mode (production RRF): assistant response must STILL outrank preference prompt on assistant-recall queries
    process.env.BRAIN_EMBED = 'remote';
    process.env.BRAIN_EMBED_URL = 'http://127.0.0.1:1/unreachable-mock';
    process.env.BRAIN_EMBED_MODEL = 'bge-small-en-v1.5';
    process.env.BRAIN_EMBED_DIM = '4';
    commitStoreMeta(resolveEmbedderRecipe());

    const embModule = await import('../../learning/embedding');
    const embedWorkerModule = await import('../../learning/embedWorker');
    const qSpy = jest.spyOn(embModule, 'embedQuery').mockResolvedValue([0.5, 0.5, 0.5, 0.5]);
    const qdrantSpy = jest.spyOn(embedWorkerModule, 'getQdrantClient').mockReturnValue({
      search: async () => [
        {
          id: 'obs-asst-recall-prompt',
          score: 0.89,
          payload: { record_id: 'obs-asst-recall-prompt', record_type: 'observation' },
        },
        {
          id: 'obs-asst-recall-resp',
          score: 0.89,
          payload: { record_id: 'obs-asst-recall-resp', record_type: 'observation' },
        },
      ],
    } as any);

    try {
      const hybRecallRes = await hybridSearch({
        q: 'What sourdough hydration ratio for open crumb did you recommend?',
        project_id: 'nb-asst-disambig',
        record_types: ['observation'],
        reference_date: '2026-06-22T12:00:00Z',
      });
      expect(hybRecallRes.mode).toBe('hybrid');
      expect(hybRecallRes.results[0].id).toBe('obs-asst-recall-resp');
      expect(hybRecallRes.results[0].score).toBeGreaterThan(hybRecallRes.results[1].score);
    } finally {
      qdrantSpy.mockRestore();
      qSpy.mockRestore();
    }
  });

  it('copies signal_tags to observations_archive on retention cleanup and verifies storeDiagnostics alignment', () => {
    captureObservations([
      {
        id: 'obs-archive-sig',
        scope: 'project',
        project_id: 'nb-sig-archive',
        kind: 'prompt',
        input: 'I just deployed the billing worker and we switched to Stripe API v2026.',
      },
    ]);

    const db = getDb();
    expect(inspectSchemaAlignment(db)).toEqual({ aligned: true, issues: [] });

    const liveRow = getObservation('obs-archive-sig');
    expect(liveRow?.signal_tags).toBe(JSON.stringify(['state_update', 'completed_action']));

    const fortyDaysAgo = Math.floor(Date.now() / 1000) - 40 * 86_400;
    db.prepare('UPDATE observations SET created_at = ? WHERE id = ?').run(
      fortyDaysAgo,
      'obs-archive-sig'
    );

    const cleanupRes = runCleanup();
    expect(cleanupRes.observationsArchived).toBe(1);

    const archived = db
      .prepare(
        'SELECT original_observation_id, input, signal_tags FROM observations_archive WHERE original_observation_id = ?'
      )
      .get('obs-archive-sig') as {
      original_observation_id: string;
      input: string;
      signal_tags: string | null;
    };

    expect(archived.original_observation_id).toBe('obs-archive-sig');
    expect(archived.input).toBe(
      'I just deployed the billing worker and we switched to Stripe API v2026.'
    );
    expect(archived.signal_tags).toBe(JSON.stringify(['state_update', 'completed_action']));

    // Verify inspectSchemaAlignment catches missing signal_tags on an unmigrated DB
    const unalignedDb = openDatabase(':memory:');
    try {
      unalignedDb.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE observations (id TEXT PRIMARY KEY, project_id TEXT, event_at TEXT, condensed_text TEXT, resolved_dates_json TEXT);
        CREATE TABLE observations_archive (id TEXT PRIMARY KEY, project_id TEXT, event_at TEXT, condensed_text TEXT, resolved_dates_json TEXT);
      `);
      const diag = inspectSchemaAlignment(unalignedDb);
      expect(diag.aligned).toBe(false);
      expect(diag.issues).toContain('observations.signal_tags missing');
      expect(diag.issues).toContain('observations_archive.signal_tags missing');
    } finally {
      unalignedDb.close();
    }
  });
});
