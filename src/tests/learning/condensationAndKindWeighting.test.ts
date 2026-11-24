import fs from 'fs';
import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { createApp } from '../../app';
import { getDb, resetDb } from '../../lib/db';
import { inspectSchemaAlignment } from '../../lib/storeDiagnostics';
import { detectQueryKindIntent, hybridSearch } from '../../learning/search';
import { verifyOrCreateStoreMeta } from '../../learning/storeMeta';
import { createBrainMcpHandlers } from '../../mcp/server';
import { captureObservations, getObservation } from '../../memory/observationStore';
import { runCleanup, runRetentionCleanup } from '../../memory/trajectoryStore';
import { createDirectBrainMcpHandlers } from '../../routes/mcp';

describe('Task 1: Extractive Condensation, Query-Focused Snippets, and Intent-Aware Kind Weighting', () => {
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

  it('preserves raw input/output verbatim in SQLite, populates condensed_text, avoids FTS thrash, and copies condensed_text on retention archive', () => {
    const rawPrompt = 'I switched my local Postgres test port to 5439 in `.env.test`.';
    const verboseResponse = [
      "Sure, I'd be happy to help!",
      '---',
      '1. **General Tip One**: Always keep configuration tidy across environments so developers stay productive.',
      '2. **General Tip Two**: Review settings periodically with your team to maintain shared understanding.',
      '3. **Database Port Update**: Updated `POSTGRES_PORT=5439` in `src/config/env.ts` and verified healthcheck.',
      '---',
      'I hope this helps! Feel free to ask if you have any questions.',
    ].join('\n');

    const res = captureObservations([
      {
        id: 'obs-verbatim-prompt',
        scope: 'project',
        project_id: 'nb-condense',
        kind: 'prompt',
        input: rawPrompt,
      },
      {
        id: 'obs-verbatim-resp',
        scope: 'project',
        project_id: 'nb-condense',
        kind: 'response',
        input: 'update port config',
        output: verboseResponse,
      },
    ]);
    expect(res.accepted).toBe(2);

    const storedPrompt = getObservation('obs-verbatim-prompt');
    expect(storedPrompt?.input).toBe(rawPrompt);
    expect(storedPrompt?.condensed_text).toBe(rawPrompt);

    const storedResp = getObservation('obs-verbatim-resp');
    // Raw output in SQLite MUST remain 100% verbatim
    expect(storedResp?.output).toBe(verboseResponse);
    expect(storedResp?.condensed_text).toBeTruthy();
    expect(storedResp?.condensed_text).toContain('POSTGRES_PORT=5439');
    expect(storedResp?.condensed_text).not.toContain('happy to help');
    expect(storedResp?.condensed_text).not.toContain('Feel free to ask');

    // Verify trg_fts_observations_au keeps AFTER UPDATE OF id, tool_name, file_path, input, output
    const db = getDb();
    const triggerRow = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_fts_observations_au'")
      .get() as { sql: string } | undefined;
    expect(triggerRow?.sql).toContain('AFTER UPDATE OF id, tool_name, file_path, input, output');

    // Updating condensed_text leaves FTS index intact
    db.prepare('UPDATE observations SET condensed_text = ? WHERE id = ?').run(
      'Custom condensed override: POSTGRES_PORT=5439',
      'obs-verbatim-resp'
    );
    const ftsHits = db
      .prepare("SELECT record_id FROM fts_observations WHERE fts_observations MATCH 'healthcheck'")
      .all() as Array<{ record_id: string }>;
    expect(ftsHits).toEqual([{ record_id: 'obs-verbatim-resp' }]);

    // Retention archival copies condensed_text to observations_archive
    const fortyDaysAgo = Math.floor(Date.now() / 1000) - 40 * 86400;
    db.prepare('UPDATE observations SET created_at = ? WHERE id = ?').run(
      fortyDaysAgo,
      'obs-verbatim-resp'
    );

    expect(runRetentionCleanup).toBe(runCleanup);
    const cleanupRes = runRetentionCleanup();
    expect(cleanupRes.observationsArchived).toBe(1);

    const archivedRow = db
      .prepare(
        'SELECT original_observation_id, output, condensed_text FROM observations_archive WHERE original_observation_id = ?'
      )
      .get('obs-verbatim-resp') as {
      original_observation_id: string;
      output: string;
      condensed_text: string | null;
    };
    expect(archivedRow.original_observation_id).toBe('obs-verbatim-resp');
    expect(archivedRow.output).toBe(verboseResponse);
    expect(archivedRow.condensed_text).toBe('Custom condensed override: POSTGRES_PORT=5439');
  });

  it('rescues char 4,200+ tail answers in default query_focused mode (<= 600 chars) and supports condensed and raw modes', async () => {
    const fillerLine =
      'Scanning workspace directory entries and verifying cached incremental build artifacts. ';
    const prefix = `Starting diagnostic check.\n${fillerLine.repeat(49)}`;
    expect(prefix.length).toBeGreaterThan(4200);

    const tailFact =
      'RESOLVED ANSWER: Primary Redis Sentinel quorum endpoint is `sentinel-prod-03.internal:26379` with failover timeout 12000ms.';
    const suffix = `\n${fillerLine.repeat(8)}`;
    const fiveKbOutput = `${prefix}\n${tailFact}${suffix}`;
    expect(fiveKbOutput.length).toBeGreaterThan(5000);

    captureObservations([
      {
        id: 'obs-tail-5k',
        scope: 'project',
        project_id: 'nb-tail',
        kind: 'tool_call',
        tool_name: 'Bash',
        input: 'check sentinel',
        output: fiveKbOutput,
      },
    ]);

    // 1. Default mode ('query_focused'): rescues char 4,200+ match with [...] and total chars <= 600
    const focusedRes = await hybridSearch({
      q: 'Redis Sentinel quorum endpoint 26379',
      project_id: 'nb-tail',
      record_types: ['observation'],
    });
    expect(focusedRes.results).toHaveLength(1);
    const focusedHit = focusedRes.results[0];
    expect(focusedHit.record.output).toContain('sentinel-prod-03.internal:26379');
    expect(focusedHit.record.output).toContain('[...]');
    expect(focusedHit.snippet).toBeDefined();
    expect(focusedHit.snippet).toContain('sentinel-prod-03.internal:26379');
    expect(focusedHit.snippet).toContain('[...]');
    const totalFocusedChars =
      (focusedHit.record.input?.length ?? 0) + (focusedHit.record.output?.length ?? 0);
    expect(totalFocusedChars).toBeLessThanOrEqual(600);
    expect(focusedHit.snippet!.length).toBeLessThanOrEqual(600);

    // 2. 'condensed' mode: uses condensed_text capped at max_record_chars
    const condensedRes = await hybridSearch({
      q: 'Redis Sentinel quorum endpoint 26379',
      project_id: 'nb-tail',
      record_types: ['observation'],
      snippet_mode: 'condensed',
    });
    expect(condensedRes.results).toHaveLength(1);
    const condensedHit = condensedRes.results[0];
    expect(condensedHit.snippet).toBeTruthy();
    expect(condensedHit.snippet!.length).toBeLessThanOrEqual(600);
    expect(
      (condensedHit.record.input?.length ?? 0) + (condensedHit.record.output?.length ?? 0)
    ).toBeLessThanOrEqual(600);

    // 3. 'raw' mode: preserves full 5,000+ char output while still attaching query-focused snippet
    const rawRes = await hybridSearch({
      q: 'Redis Sentinel quorum endpoint 26379',
      project_id: 'nb-tail',
      record_types: ['observation'],
      snippet_mode: 'raw',
    });
    expect(rawRes.results).toHaveLength(1);
    const rawHit = rawRes.results[0];
    expect(rawHit.record.output).toBe(fiveKbOutput);
    expect(rawHit.record.output.length).toBeGreaterThan(5000);
    expect(rawHit.snippet).toContain('sentinel-prod-03.internal:26379');
    expect(rawHit.snippet!.length).toBeLessThanOrEqual(600);

    // 4. Explicit max_record_chars override
    const customCapRes = await hybridSearch({
      q: 'Redis Sentinel quorum endpoint 26379',
      project_id: 'nb-tail',
      record_types: ['observation'],
      snippet_mode: 'query_focused',
      max_record_chars: 240,
    });
    expect(customCapRes.results[0].snippet!.length).toBeLessThanOrEqual(240);
    expect(
      (customCapRes.results[0].record.input?.length ?? 0) +
        (customCapRes.results[0].record.output?.length ?? 0)
    ).toBeLessThanOrEqual(240);
  });

  it('applies intent-aware kind weighting (assistant vs tool vs general), density damping, and kind_weights override', async () => {
    expect(detectQueryKindIntent('What did you recommend for caching?', false)).toBe('assistant');
    expect(detectQueryKindIntent('Where is your recipe for sourdough?', false)).toBe('assistant');
    expect(detectQueryKindIntent('ENOENT error in src/learning/search.ts', false)).toBe('tool');
    expect(detectQueryKindIntent('hybridSearch ranking', false)).toBe('tool');
    expect(detectQueryKindIntent('preferred theme', true)).toBe('tool');
    expect(detectQueryKindIntent('favorite coffee roast preference', false)).toBe('general');

    // Insert 3 observations with identical lexical match strength on token 'zephyr_token'
    captureObservations([
      {
        id: 'obs-kind-prompt',
        scope: 'project',
        project_id: 'nb-intent',
        kind: 'prompt',
        input: 'zephyr_token configuration note',
      },
      {
        id: 'obs-kind-tool',
        scope: 'project',
        project_id: 'nb-intent',
        kind: 'tool_call',
        tool_name: 'Read',
        input: 'zephyr_token configuration note',
      },
      {
        id: 'obs-kind-response',
        scope: 'project',
        project_id: 'nb-intent',
        kind: 'response',
        output: 'zephyr_token configuration note',
      },
    ]);

    // Tool intent ('zephyr_token' is snake_case) -> tool_call ranks #1
    const toolRes = await hybridSearch({
      q: 'zephyr_token',
      project_id: 'nb-intent',
      record_types: ['observation'],
    });
    expect(toolRes.results[0].id).toBe('obs-kind-tool');

    // Assistant intent -> response ranks #1
    const assistantRes = await hybridSearch({
      q: 'what did you say about zephyr_token',
      project_id: 'nb-intent',
      record_types: ['observation'],
    });
    expect(assistantRes.results[0].id).toBe('obs-kind-response');

    // General intent -> prompt ranks #1
    captureObservations([
      {
        id: 'obs-gen-prompt',
        scope: 'project',
        project_id: 'nb-general',
        kind: 'prompt',
        input: 'velvet roast coffee beans',
      },
      {
        id: 'obs-gen-response',
        scope: 'project',
        project_id: 'nb-general',
        kind: 'response',
        output: [
          "Sure, I'd be happy to help!",
          '1. **Tip One**: Enjoy your coffee fresh every morning for balanced flavor and aroma.',
          '2. **Tip Two**: Store beans in an airtight container away from direct sunlight.',
          '3. **Tip Three**: Grind right before brewing so every cup tastes consistent and smooth.',
          '4. **Tip Four**: Keep your grinder burrs clean every month for uniform extraction.',
          '5. **Tip Five**: Try velvet beans occasionally when experimenting with different roasts.',
          '6. **Tip Six**: Warm your ceramic mug ahead of time to keep temperature steady.',
          '7. **Tip Seven**: Measure water temperature carefully for repeatable results every time.',
          '8. **Tip Eight**: Take notes on what you enjoy most so you can refine your routine.',
          'I hope this helps! Let me know if you need anything else!',
        ].join('\n'),
      },
    ]);

    const generalRes = await hybridSearch({
      q: 'velvet coffee',
      project_id: 'nb-general',
      record_types: ['observation'],
    });
    expect(generalRes.results[0].id).toBe('obs-gen-prompt');

    // Explicit kind_weights override flips response to #1 even on general query
    const overrideRes = await hybridSearch({
      q: 'velvet coffee',
      project_id: 'nb-general',
      record_types: ['observation'],
      kind_weights: { response: 4.5, prompt: 0.2 },
    });
    expect(overrideRes.results[0].id).toBe('obs-gen-response');
  });

  it('enforces max_kind_share diversity cap in pass 1 and backfills in pass 2 when alternatives do not exist', async () => {
    // 5 responses + 2 prompts matching 'quartz'
    const items: any[] = [];
    for (let i = 1; i <= 5; i++) {
      items.push({
        id: `obs-share-resp-${i}`,
        scope: 'project',
        project_id: 'nb-share',
        kind: 'response',
        // Give responses higher BM25 TF on 'quartz' so without cap all top 5 would be responses
        output: `quartz quartz quartz response detail ${i}`,
      });
    }
    items.push(
      {
        id: 'obs-share-prompt-1',
        scope: 'project',
        project_id: 'nb-share',
        kind: 'prompt',
        input: 'quartz user preference one',
      },
      {
        id: 'obs-share-prompt-2',
        scope: 'project',
        project_id: 'nb-share',
        kind: 'prompt',
        input: 'quartz user preference two',
      }
    );
    captureObservations(items);

    // Default { response: 0.6 } for limit=5, general intent -> max 3 responses, admitting the 2 prompts!
    const diverseRes = await hybridSearch({
      q: 'quartz',
      project_id: 'nb-share',
      record_types: ['observation'],
      limit: 5,
    });
    expect(diverseRes.results).toHaveLength(5);
    const respCount = diverseRes.results.filter((r) => r.record.kind === 'response').length;
    const promptCount = diverseRes.results.filter((r) => r.record.kind === 'prompt').length;
    expect(respCount).toBe(3);
    expect(promptCount).toBe(2);

    // Backfill check: project with ONLY 5 response hits and 0 alternatives must still return all 5!
    captureObservations(
      [1, 2, 3, 4, 5].map((i) => ({
        id: `obs-only-resp-${i}`,
        scope: 'project',
        project_id: 'nb-backfill',
        kind: 'response',
        output: `obsidian crystal note ${i}`,
      }))
    );

    const backfillRes = await hybridSearch({
      q: 'obsidian',
      project_id: 'nb-backfill',
      record_types: ['observation'],
      max_kind_share: { response: 0.4 },
      limit: 5,
    });
    expect(backfillRes.results).toHaveLength(5);
    for (let i = 1; i < backfillRes.results.length; i++) {
      expect(backfillRes.results[i - 1].score).toBeGreaterThanOrEqual(backfillRes.results[i].score);
    }
  });

  it('maintains 100% MCP parity across stdio REST handlers (src/mcp/server.ts) and direct HTTP handlers (src/routes/mcp.ts)', async () => {
    // Architectural guard: src/mcp/server.ts must never import ../lib/db
    const mcpServerSrc = fs.readFileSync(
      path.resolve(__dirname, '../../mcp/server.ts'),
      'utf-8'
    );
    expect(mcpServerSrc).not.toMatch(/from\s+['"]\.\.\/lib\/db['"]/);

    captureObservations([
      {
        id: 'obs-mcp-1',
        scope: 'project',
        project_id: 'nb-mcp-parity',
        kind: 'response',
        output: `${'Introductory filler line repeating routine context. '.repeat(90)}Answer: Use port 9091 for Prometheus metrics.`,
      },
      {
        id: 'obs-mcp-2',
        scope: 'project',
        project_id: 'nb-mcp-parity',
        kind: 'prompt',
        input: 'Prometheus metrics port preference',
      },
    ]);

    const testApiKey = 'test-mcp-parity-key-12345';
    getDb()
      .prepare('INSERT INTO api_keys (id, name, key) VALUES (?, ?, ?)')
      .run('key-parity', 'parity', testApiKey);
    const app = createApp();
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    try {
      const port = (server.address() as AddressInfo).port;
      const restHandlers = createBrainMcpHandlers({
        apiBaseUrl: `http://127.0.0.1:${port}`,
        apiKey: testApiKey,
        defaultProjectId: 'nb-mcp-parity',
      });
      const directHandlers = createDirectBrainMcpHandlers('nb-mcp-parity');

      const searchArgs = {
        q: 'Prometheus metrics 9091',
        record_types: ['observation'],
        snippet_mode: 'query_focused' as const,
        max_record_chars: 320,
        kind_weights: { response: 1.8, prompt: 0.9 },
        max_kind_share: { response: 0.5 },
        limit: 4,
      };

      const restOut = await restHandlers.brainSearch(searchArgs);
      const directOut = await directHandlers.brainSearch(searchArgs);

      expect((restOut as any).isError).toBeUndefined();
      expect((directOut as any).isError).toBeUndefined();

      const restParsed = JSON.parse(restOut.content[0].text);
      const directParsed = JSON.parse(directOut.content[0].text);

      expect(restParsed.results.map((r: any) => r.id)).toEqual(
        directParsed.results.map((r: any) => r.id)
      );
      expect(restParsed.results[0].id).toBe('obs-mcp-1');
      expect(restParsed.results[0].snippet).toContain('9091');
      expect(restParsed.results[0].snippet.length).toBeLessThanOrEqual(320);
      expect(directParsed.results[0].snippet).toBe(restParsed.results[0].snippet);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('survives adversarial POST /search payloads (NaN/negative/malformed params, FTS5 operators, null fields) while keeping SQLite rows 100% verbatim', async () => {
    const verbatimOutput = `${'Verbose diagnostic preamble line with filler context. '.repeat(110)}FINAL VERDICT: Set SQLITE_BUSY_TIMEOUT=7500ms in pool config.`;
    captureObservations([
      {
        id: 'obs-adv-verbose',
        scope: 'project',
        project_id: 'nb-adv',
        kind: 'response',
        input: null,
        output: verbatimOutput,
      },
      {
        id: 'obs-adv-null-out',
        scope: 'project',
        project_id: 'nb-adv',
        kind: 'prompt',
        input: 'SQLITE_BUSY_TIMEOUT preference check',
        output: null,
      },
    ]);

    const testApiKey = 'test-adv-search-key-67890';
    getDb()
      .prepare('INSERT INTO api_keys (id, name, key) VALUES (?, ?, ?)')
      .run('key-adv', 'adv', testApiKey);
    const app = createApp();

    // 1. Malformed / negative / NaN-equivalent JSON values on new parameters
    const malformedRes = await request(app)
      .post('/search')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        q: 'SQLITE_BUSY_TIMEOUT 7500ms',
        project_id: 'nb-adv',
        record_types: ['observation'],
        snippet_mode: 'invalid_mode_name',
        max_record_chars: -250,
        kind_weights: { prompt: -50, response: 99999, tool_call: 'not-a-number' },
        max_kind_share: { response: -0.5, prompt: 0, tool_call: 'bad' },
      });
    expect(malformedRes.status).toBe(200);
    expect(malformedRes.body.results.length).toBe(2);
    for (const r of malformedRes.body.results) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThan(0);
    }

    // 2. Non-numeric limit or non-array record_types over HTTP must not 500 or silently NaN-zero results
    const badLimitRes = await request(app)
      .post('/search')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        q: 'SQLITE_BUSY_TIMEOUT',
        project_id: 'nb-adv',
        record_types: ['observation'],
        limit: 'not-a-number',
      });
    expect(badLimitRes.status).toBe(200);
    expect(badLimitRes.body.results.length).toBeGreaterThan(0);

    const stringRecordTypesRes = await request(app)
      .post('/search')
      .set('Authorization', `Bearer ${testApiKey}`)
      .send({
        q: 'SQLITE_BUSY_TIMEOUT',
        project_id: 'nb-adv',
        record_types: 'observation',
      });
    expect(stringRecordTypesRes.status).toBeLessThan(500);

    // 3. Adversarial FTS5 syntax + operators + pure stopwords with snippet_mode: 'query_focused'
    const ftsAdversarialQueries = [
      'NEAR("SQLITE_BUSY_TIMEOUT" OR NOT 7500ms) : (pool) -config*',
      '"" () --- ::: ***',
      'the and or not to of',
    ];
    for (const advQ of ftsAdversarialQueries) {
      const ftsRes = await request(app)
        .post('/search')
        .set('Authorization', `Bearer ${testApiKey}`)
        .send({
          q: advQ,
          project_id: 'nb-adv',
          record_types: ['observation'],
          snippet_mode: 'query_focused',
        });
      expect(ftsRes.status).toBe(200);
      expect(Array.isArray(ftsRes.body.results)).toBe(true);
    }

    // 4. Direct hybridSearch with runtime NaN / Infinity values
    const nanDirect = await hybridSearch({
      q: 'SQLITE_BUSY_TIMEOUT',
      project_id: 'nb-adv',
      record_types: ['observation'],
      max_record_chars: Number.NaN,
      kind_weights: { response: Number.NaN, prompt: Number.POSITIVE_INFINITY },
      max_kind_share: { response: Number.NaN },
      limit: Number.NaN,
    });
    expect(nanDirect.results.length).toBe(2);

    // 5. Verify raw SQLite rows remain 100% unmutated after repeated query_focused windowing
    const rawRow = getDb()
      .prepare('SELECT input, output FROM observations WHERE id = ?')
      .get('obs-adv-verbose') as { input: string | null; output: string };
    expect(rawRow.input).toBeNull();
    expect(rawRow.output).toBe(verbatimOutput);

    // 6. Verify storeDiagnostics schema alignment checks condensed_text on observations & observations_archive
    expect(inspectSchemaAlignment(getDb())).toEqual({ aligned: true, issues: [] });
  });
});
