import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { createApp } from '../../app';
import { getDb, resetDb } from '../../lib/db';
import { inspectSchemaAlignment } from '../../lib/storeDiagnostics';
import { resolveEmbedderRecipe, serializeEmbedding } from '../../learning/embedding';
import { hybridSearch } from '../../learning/search';
import { commitStoreMeta, verifyOrCreateStoreMeta } from '../../learning/storeMeta';
import { createBrainMcpHandlers } from '../../mcp/server';
import { createNote } from '../../memory/noteStore';
import { captureObservations, getObservation } from '../../memory/observationStore';
import { runCleanup } from '../../memory/trajectoryStore';
import { createDirectBrainMcpHandlers } from '../../routes/mcp';

describe('Task 2: Relative-Date Anchoring, Temporal Query Window Recall, and Soft Boost', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'none';
    resetDb();
    verifyOrCreateStoreMeta();
  });

  afterEach(() => {
    resetDb();
    process.env = { ...originalEnv };
  });

  it('recovers zero-lexical-overlap observations & notes inside a relative temporal query window', async () => {
    captureObservations([
      {
        id: 'obs-5k-pr',
        scope: 'project',
        project_id: 'nb-temporal',
        kind: 'prompt',
        input: 'Ran my fastest 5K ever!',
        event_at: '2023-05-23T15:00:00Z',
      },
      {
        id: 'obs-distractor-stopword',
        scope: 'project',
        project_id: 'nb-temporal',
        kind: 'prompt',
        input: 'Two weeks ago I mentioned picking up coffee beans.',
        event_at: '2023-06-18T10:00:00Z',
      },
      {
        id: 'obs-other-project-leak-check',
        scope: 'project',
        project_id: 'other-isolated-proj',
        kind: 'prompt',
        input: 'Hit a major milestone on another project!',
        event_at: '2023-05-23T12:00:00Z',
      },
    ]);

    createNote({
      id: 'note-zero-lex',
      scope: 'project',
      project_id: 'nb-temporal',
      type: 'fact',
      title: ' Marathon prep block ',
      content: 'Completed sub-20 minute pace threshold workout.',
      event_at: '2023-05-24T09:00:00Z',
    });

    const obsRes = await hybridSearch({
      q: 'what milestone did I mention four weeks ago',
      project_id: 'nb-temporal',
      record_types: ['observation'],
      reference_date: '2023-06-20T12:00:00Z',
    });

    expect(obsRes.temporal_window).toEqual({
      start: '2023-05-16T12:00:00.000Z',
      end: '2023-05-30T12:00:00.000Z',
      expressions: ['four weeks ago'],
    });
    expect(obsRes.results.length).toBeGreaterThanOrEqual(1);
    expect(obsRes.results[0].id).toBe('obs-5k-pr');
    // Strictly isolated from other-isolated-proj
    expect(obsRes.results.map((r) => r.id)).not.toContain('obs-other-project-leak-check');

    const mixedRes = await hybridSearch({
      q: 'what milestone did I mention four weeks ago',
      project_id: 'nb-temporal',
      record_types: ['note', 'observation'],
      reference_date: '2023-06-20T12:00:00Z',
    });
    const topTwoIds = mixedRes.results.slice(0, 2).map((r) => r.id);
    expect(topTwoIds).toContain('obs-5k-pr');
    expect(topTwoIds).toContain('note-zero-lex');
  });

  it('matches resolved relative dates ("last Saturday" -> [2023-05-20]) while preserving raw SQLite input/output verbatim', async () => {
    const rawPuppyInput = 'I adopted a puppy last Saturday';
    const rawPuppyOutput = 'Congrats! Vet checkup scheduled tomorrow.';

    // Logged on Wednesday 2023-05-24 -> "last Saturday" = 2023-05-20, "tomorrow" = 2023-05-25
    const capRes = captureObservations([
      {
        id: 'obs-puppy',
        scope: 'project',
        project_id: 'nb-resolved',
        kind: 'prompt',
        input: rawPuppyInput,
        output: rawPuppyOutput,
        event_at: '2023-05-24T18:00:00Z',
      },
      {
        id: 'obs-later-unrelated',
        scope: 'project',
        project_id: 'nb-resolved',
        kind: 'prompt',
        input: 'What happened to the staging deploy?',
        event_at: '2023-06-15T10:00:00Z',
      },
    ]);
    expect(capRes.accepted).toBe(2);

    // 1. SQLite raw input/output MUST remain 100% verbatim
    const stored = getObservation('obs-puppy');
    expect(stored?.input).toBe(rawPuppyInput);
    expect(stored?.output).toBe(rawPuppyOutput);
    expect(stored?.condensed_text).toContain('last Saturday [2023-05-20]');
    expect(stored?.condensed_text).toContain('tomorrow [2023-05-25]');
    expect(stored?.resolved_dates_json).toBeTruthy();

    const parsedAnnotations = JSON.parse(stored!.resolved_dates_json!);
    expect(parsedAnnotations).toEqual([
      expect.objectContaining({
        field: 'input',
        phrase: 'last Saturday',
        resolved_date: '2023-05-20',
        granularity: 'day',
      }),
      expect.objectContaining({
        field: 'output',
        phrase: 'tomorrow',
        resolved_date: '2023-05-25',
        granularity: 'day',
      }),
    ]);

    // 2. Querying "what happened on May 20, 2023?" finds obs-puppy via resolved_dates_json overlap!
    const focusedSearch = await hybridSearch({
      q: 'what happened on May 20, 2023?',
      project_id: 'nb-resolved',
      record_types: ['observation'],
      snippet_mode: 'query_focused',
    });
    expect(focusedSearch.results[0].id).toBe('obs-puppy');
    expect(focusedSearch.results[0].record.input).toContain('last Saturday [2023-05-20]');
    expect(focusedSearch.results[0].snippet).toContain('last Saturday [2023-05-20]');

    // 3. 'condensed' mode also includes inline [2023-05-20]
    const condensedSearch = await hybridSearch({
      q: 'what happened on May 20, 2023?',
      project_id: 'nb-resolved',
      record_types: ['observation'],
      snippet_mode: 'condensed',
    });
    expect(condensedSearch.results[0].id).toBe('obs-puppy');
    expect(condensedSearch.results[0].snippet).toContain('last Saturday [2023-05-20]');

    // 4. 'raw' mode returns 100% verbatim record.input/record.output while snippet stays annotated
    const rawSearch = await hybridSearch({
      q: 'what happened on May 20, 2023?',
      project_id: 'nb-resolved',
      record_types: ['observation'],
      snippet_mode: 'raw',
    });
    expect(rawSearch.results[0].id).toBe('obs-puppy');
    expect(rawSearch.results[0].record.input).toBe(rawPuppyInput);
    expect(rawSearch.results[0].record.output).toBe(rawPuppyOutput);
    expect(rawSearch.results[0].snippet).toContain('last Saturday [2023-05-20]');
  });

  it('applies soft temporal boost (in-window > grace-zone > out-of-window) without hard-dropping out-of-window context', async () => {
    const sharedContent = 'Configured Redis maxmemory-policy to allkeys-lru in cluster config.';

    captureObservations([
      {
        id: 'obs-in-window-center',
        scope: 'project',
        project_id: 'nb-soft-boost',
        kind: 'prompt',
        input: sharedContent,
        // Exact center of "last week" ([ref - 14d, ref] -> center = ref - 7d = 2023-06-13T12:00Z)
        event_at: '2023-06-13T12:00:00Z',
      },
      {
        id: 'obs-grace-zone',
        scope: 'project',
        project_id: 'nb-soft-boost',
        kind: 'prompt',
        input: sharedContent,
        // 10 days outside center (inside 1x..2x halfWidthMs = 7d..14d from center -> 2023-06-03)
        event_at: '2023-06-03T12:00:00Z',
      },
      {
        id: 'obs-far-out-of-window',
        scope: 'project',
        project_id: 'nb-soft-boost',
        kind: 'prompt',
        input: sharedContent,
        // 4 months earlier (outside 2x halfWidthMs)
        event_at: '2023-02-10T12:00:00Z',
      },
      {
        id: 'obs-unrelated-in-window',
        scope: 'project',
        project_id: 'nb-soft-boost',
        kind: 'prompt',
        input: 'Fixed button border radius in login modal.',
        event_at: '2023-06-13T12:00:00Z',
      },
    ]);

    const res = await hybridSearch({
      q: 'Redis maxmemory-policy allkeys-lru last week',
      project_id: 'nb-soft-boost',
      record_types: ['observation'],
      reference_date: '2023-06-20T12:00:00Z',
      limit: 10,
    });

    const ids = res.results.map((r) => r.id);
    // All 3 topical matches are preserved (none hard-dropped!) and ordered: in-window > grace > far > unrelated
    expect(ids).toEqual([
      'obs-in-window-center',
      'obs-grace-zone',
      'obs-far-out-of-window',
      'obs-unrelated-in-window',
    ]);
    expect(res.results[0].score).toBeGreaterThan(res.results[1].score);
    expect(res.results[1].score).toBeGreaterThan(res.results[2].score);
    expect(res.results[2].score).toBeGreaterThan(res.results[3].score);
  });

  it('works in hybrid vector+RRF mode as well as BM25 mode', async () => {
    // Configure local/mocked store_meta + SQLite embeddings to exercise hybrid RRF branch
    process.env.BRAIN_EMBED = 'remote';
    process.env.BRAIN_EMBED_URL = 'http://127.0.0.1:1/unreachable-mock';
    process.env.BRAIN_EMBED_MODEL = 'bge-small-en-v1.5';
    process.env.BRAIN_EMBED_DIM = '4';
    resetDb();
    const db = getDb();
    commitStoreMeta(resolveEmbedderRecipe());

    const embModule = await import('../../learning/embedding');
    const spy = jest.spyOn(embModule, 'embedQuery').mockResolvedValue([0.5, 0.5, 0.5, 0.5]);

    try {
      const noteInWin = createNote({
        id: 'note-hyb-in',
        scope: 'project',
        project_id: 'nb-hyb-temp',
        type: 'fact',
        title: 'Sprint retro note',
        content: 'Shipped deterministic chunker module.',
        event_at: '2023-05-23T12:00:00Z',
      });
      const noteOutWin = createNote({
        id: 'note-hyb-out',
        scope: 'project',
        project_id: 'nb-hyb-temp',
        type: 'fact',
        title: 'Old retro note',
        content: 'Initial repo bootstrap.',
        event_at: '2023-01-10T12:00:00Z',
      });

      const vecBlob = serializeEmbedding([0.5, 0.5, 0.5, 0.5]);
      db.prepare('UPDATE notes SET embedding = ? WHERE id IN (?, ?)').run(
        vecBlob,
        noteInWin.id,
        noteOutWin.id
      );

      const hybRes = await hybridSearch({
        q: 'what did we ship four weeks ago',
        project_id: 'nb-hyb-temp',
        record_types: ['note'],
        reference_date: '2023-06-20T12:00:00Z',
      });

      expect(hybRes.mode).toBe('hybrid');
      expect(hybRes.results.map((r) => r.id)).toEqual(['note-hyb-in', 'note-hyb-out']);
      expect(hybRes.results[0].score).toBeGreaterThan(hybRes.results[1].score * 1.5);
    } finally {
      spy.mockRestore();
    }
  });

  it('copies resolved_dates_json on retention archival, checks alignment in storeDiagnostics, validates reference_date, and maintains MCP parity', async () => {
    captureObservations([
      {
        id: 'obs-archive-temp',
        scope: 'project',
        project_id: 'nb-parity-temp',
        kind: 'prompt',
        input: 'Switched DNS cutover yesterday',
        event_at: '2023-05-20T10:00:00Z',
      },
    ]);

    const db = getDb();

    // 1. storeDiagnostics schema alignment passes
    expect(inspectSchemaAlignment(db)).toEqual({ aligned: true, issues: [] });

    // 2. Updating resolved_dates_json does NOT re-trigger or break fts_observations
    const beforeRow = getObservation('obs-archive-temp');
    expect(beforeRow?.resolved_dates_json).toContain('2023-05-19');

    // 3. Test HTTP API validation on invalid reference_date & MCP REST vs Direct parity
    const testApiKey = 'test-temporal-mcp-key-999';
    db.prepare('INSERT INTO api_keys (id, name, key) VALUES (?, ?, ?)').run(
      'key-temp',
      'temp-test',
      testApiKey
    );
    const app = createApp();

    const badRefRes = await request(app)
      .post('/search')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        q: 'DNS cutover yesterday',
        project_id: 'nb-parity-temp',
        record_types: ['observation'],
        reference_date: 'not-an-iso-timestamp',
      });
    expect(badRefRes.status).toBe(400);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const port = (server.address() as AddressInfo).port;
      const restHandlers = createBrainMcpHandlers({
        apiBaseUrl: `http://127.0.0.1:${port}`,
        apiKey: testApiKey,
        defaultProjectId: 'nb-parity-temp',
      });
      const directHandlers = createDirectBrainMcpHandlers('nb-parity-temp');

      const searchArgs = {
        q: 'what DNS change happened yesterday',
        record_types: ['observation'],
        reference_date: '2023-05-20T18:00:00Z',
      };

      const restOut = await restHandlers.brainSearch(searchArgs);
      const directOut = await directHandlers.brainSearch(searchArgs);

      expect((restOut as any).isError).toBeUndefined();
      expect((directOut as any).isError).toBeUndefined();

      const restJson = JSON.parse(restOut.content[0].text);
      const directJson = JSON.parse(directOut.content[0].text);

      expect(restJson.temporal_window).toEqual(directJson.temporal_window);
      expect(restJson.results.map((r: any) => r.id)).toEqual(['obs-archive-temp']);
      expect(directJson.results.map((r: any) => r.id)).toEqual(['obs-archive-temp']);
      expect(restJson.results[0].snippet).toContain('yesterday [2023-05-19]');
      expect(directJson.results[0].snippet).toBe(restJson.results[0].snippet);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // 4. Retention archival copies resolved_dates_json to observations_archive
    const fortyDaysAgo = Math.floor(Date.now() / 1000) - 40 * 86_400;
    db.prepare('UPDATE observations SET created_at = ? WHERE id = ?').run(
      fortyDaysAgo,
      'obs-archive-temp'
    );
    const cleanupRes = runCleanup();
    expect(cleanupRes.observationsArchived).toBe(1);

    const archived = db
      .prepare(
        'SELECT original_observation_id, input, condensed_text, resolved_dates_json FROM observations_archive WHERE original_observation_id = ?'
      )
      .get('obs-archive-temp') as {
      original_observation_id: string;
      input: string;
      condensed_text: string | null;
      resolved_dates_json: string | null;
    };
    expect(archived.original_observation_id).toBe('obs-archive-temp');
    expect(archived.input).toBe('Switched DNS cutover yesterday');
    expect(archived.condensed_text).toContain('yesterday [2023-05-19]');
    expect(archived.resolved_dates_json).toContain('2023-05-19');
  });

  it('survives malformed, non-array, and non-object resolved_dates_json rows without throwing SQLite or TypeError 500s', async () => {
    const corruptedPayloads = [
      'invalid-json',
      '{}',
      '{"a":"b"}',
      '123',
      '"hello"',
      '["hello"]',
      '[null]',
      '[123, true, "str"]',
    ];

    captureObservations([
      {
        id: 'obs-valid-may20',
        scope: 'project',
        project_id: 'nb-corrupt-json',
        kind: 'prompt',
        input: 'Shipped schema patch last Saturday',
        event_at: '2023-05-24T12:00:00Z',
      },
      ...corruptedPayloads.map((_val, idx) => ({
        id: `obs-corrupt-${idx}`,
        scope: 'project' as const,
        project_id: 'nb-corrupt-json',
        kind: 'prompt' as const,
        input: `Legacy repaired observation ${idx} on May 20`,
        // Put inside the May 20, 2023 window so both SQL json_each AND JS getBestTemporalWindowDistanceMs execute on every row
        event_at: '2023-05-20T12:00:00Z',
      })),
    ]);

    const db = getDb();
    const updateStmt = db.prepare('UPDATE observations SET resolved_dates_json = ? WHERE id = ?');
    corruptedPayloads.forEach((payload, idx) => {
      updateStmt.run(payload, `obs-corrupt-${idx}`);
    });

    const testApiKey = 'test-corrupt-json-key';
    db.prepare('INSERT INTO api_keys (id, name, key) VALUES (?, ?, ?)').run(
      'key-corrupt',
      'corrupt-test',
      testApiKey
    );
    const app = createApp();

    const httpRes = await request(app)
      .post('/search')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        q: 'what shipped on May 20, 2023?',
        project_id: 'nb-corrupt-json',
        record_types: ['observation'],
        limit: 20,
      });

    expect(httpRes.status).toBe(200);
    expect(httpRes.body.results.map((r: any) => r.id)).toContain('obs-valid-may20');
  });

  it('strictly enforces explicit after/before bounds even when temporal_window spans outside them, and returns 400 on non-string reference_date', async () => {
    captureObservations([
      {
        id: 'obs-early-window',
        scope: 'project',
        project_id: 'nb-bounds',
        kind: 'prompt',
        input: 'Early May migration step',
        event_at: '2023-05-05T12:00:00Z',
      },
      {
        id: 'obs-mid-window',
        scope: 'project',
        project_id: 'nb-bounds',
        kind: 'prompt',
        input: 'Mid May migration step',
        event_at: '2023-05-15T12:00:00Z',
      },
      {
        id: 'obs-late-window-resolved-early',
        scope: 'project',
        project_id: 'nb-bounds',
        kind: 'prompt',
        // Logged on May 28 (outside before='2023-05-20T23:59:59Z'), even though "two weeks ago" resolves to May 14
        input: 'Discussed migration two weeks ago',
        event_at: '2023-05-28T12:00:00Z',
      },
    ]);

    createNote({
      id: 'note-early-window',
      scope: 'project',
      project_id: 'nb-bounds',
      type: 'fact',
      title: 'Early May note',
      content: 'Initial rollout checklist',
      event_at: '2023-05-04T12:00:00Z',
    });
    createNote({
      id: 'note-mid-window',
      scope: 'project',
      project_id: 'nb-bounds',
      type: 'fact',
      title: 'Mid May note',
      content: 'Mid-month verification complete',
      event_at: '2023-05-16T12:00:00Z',
    });

    // Query window "in May 2023" spans [2023-05-01..2023-05-31], but explicit after/before narrows to [May 10..May 20]
    const boundedRes = await hybridSearch({
      q: 'what happened in May 2023',
      project_id: 'nb-bounds',
      record_types: ['note', 'observation'],
      after: '2023-05-10T00:00:00Z',
      before: '2023-05-20T23:59:59Z',
    });

    expect(boundedRes.temporal_window).toEqual({
      start: '2023-05-01T00:00:00.000Z',
      end: '2023-05-31T23:59:59.999Z',
      expressions: ['in May 2023'],
    });
    const returnedIds = boundedRes.results.map((r) => r.id);
    expect(returnedIds).toContain('obs-mid-window');
    expect(returnedIds).toContain('note-mid-window');
    expect(returnedIds).not.toContain('obs-early-window');
    expect(returnedIds).not.toContain('note-early-window');
    expect(returnedIds).not.toContain('obs-late-window-resolved-early');

    // Non-string reference_date values via POST /search must return 400 (never 500)
    const db = getDb();
    const testApiKey = 'test-ref-type-key';
    db.prepare('INSERT INTO api_keys (id, name, key) VALUES (?, ?, ?)').run(
      'key-reftype',
      'reftype-test',
      testApiKey
    );
    const app = createApp();

    for (const invalidRef of [12345, { iso: '2023-05-20' }, ['2023-05-20'], true]) {
      const res = await request(app)
        .post('/search')
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({
          q: 'migration yesterday',
          project_id: 'nb-bounds',
          reference_date: invalidRef,
        });
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe('SCHEMA_INVALID');
    }
  });
});
