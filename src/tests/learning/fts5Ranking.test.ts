import { getDb, resetDb } from '../../lib/db';
import { inspectSchemaAlignment } from '../../lib/storeDiagnostics';
import {
  buildSafeFtsQuery,
  buildStrictFtsQuery,
  detectQueryKindIntent,
  hybridSearch,
} from '../../learning/search';
import { verifyOrCreateStoreMeta } from '../../learning/storeMeta';
import { createAction } from '../../memory/actionStore';
import { linkEntities, upsertEntity } from '../../memory/graphStore';
import { createNote } from '../../memory/noteStore';
import { captureObservations } from '../../memory/observationStore';
import { captureTrajectories } from '../../memory/trajectoryStore';

describe('Task 3: FTS5 Stopword Filtering, Two-Tier Strict+Relaxed Querying, Explicit BM25 Weights, and condensed_text Indexing', () => {
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

  it('filters English stopwords, falls back on pure-stopword queries, preserves code symbols, and caps 500+ word / 50KB queries in <5ms', async () => {
    // 1. Stopword filtering on natural-language questions
    const booksSafe = buildSafeFtsQuery('how many books did I read in the library');
    expect(booksSafe).toBe('"books" OR "read" OR "library"');
    expect(buildStrictFtsQuery('how many books did I read in the library')).toBe(
      '"books" AND "read" AND "library"'
    );

    // 2. Pure-stopword fallback (never returns null when valid stopword tokens exist)
    expect(buildSafeFtsQuery('to be or not to be')).toBe('"to" OR "be" OR "or" OR "not"');
    expect(buildStrictFtsQuery('to be or not to be')).toBeNull();
    expect(buildSafeFtsQuery('who am i')).toBe('"who" OR "am" OR "i"');
    expect(buildStrictFtsQuery('who am i')).toBeNull();

    // 3. Code identifiers, underscores, digits, and versions preserved
    expect(buildSafeFtsQuery('fix user_id oauth2 404 h264')).toBe(
      '"fix" OR "user_id" OR "oauth2" OR "404" OR "h264"'
    );
    const codeStrict = buildStrictFtsQuery('fix user_id oauth2 404');
    expect(codeStrict).toBe('"fix" AND "user_id" AND "oauth2" AND "404"');

    // 4. Quoted multi-word phrase emits NEAR(..., 6) without tripping on contractions
    const quotedStrict = buildStrictFtsQuery(
      `I didn't see "The Glass Menagerie" in Chicago yet`
    );
    expect(quotedStrict).toContain('NEAR("glass" "menagerie", 6)');
    expect(quotedStrict).toContain('"chicago"');
    expect(quotedStrict).not.toContain('"didn"');
    expect(quotedStrict).not.toContain('"t"');

    const singleQuotedStrict = buildStrictFtsQuery(
      `What was 'The Glass Menagerie' play in Chicago?`
    );
    expect(singleQuotedStrict).toContain('NEAR("glass" "menagerie", 6)');

    // 5. Empty, pure-punctuation, and pure-underscore inputs return null cleanly
    expect(buildSafeFtsQuery('')).toBeNull();
    expect(buildSafeFtsQuery('   ___ --- ::: *** "" () [] ')).toBeNull();
    expect(buildStrictFtsQuery('singleword')).toBeNull();

    // 6. 600-unique-word + 55KB query capped to <= 48 tokens, <5ms build, zero SQLITE_MAX_EXPR_DEPTH error
    const sixHundredTokens: string[] = [];
    for (let i = 0; i < 600; i++) {
      sixHundredTokens.push(`symbol_tok_${i}`);
    }
    const hugeQuery = `${sixHundredTokens.join(' ')} ${'padding_stack_frame '.repeat(2600)}`;
    expect(hugeQuery.length).toBeGreaterThan(50_000);

    // Warm V8 JIT on the >48-token sort path, then take min of 3 runs to filter OS scheduling slices
    buildSafeFtsQuery(hugeQuery);
    buildStrictFtsQuery(hugeQuery);
    let cappedSafe: string | null = null;
    let cappedStrict: string | null = null;
    let minElapsedMs = Number.POSITIVE_INFINITY;
    for (let iter = 0; iter < 3; iter++) {
      const t0 = performance.now();
      cappedSafe = buildSafeFtsQuery(hugeQuery);
      cappedStrict = buildStrictFtsQuery(hugeQuery);
      const dt = performance.now() - t0;
      if (dt < minElapsedMs) minElapsedMs = dt;
    }

    expect(minElapsedMs).toBeLessThan(5);
    expect(cappedSafe).not.toBeNull();
    const orParts = cappedSafe!.split(' OR ');
    expect(orParts.length).toBe(48);
    expect(cappedStrict).not.toBeNull();

    createNote({
      id: 'note-stopword-fallback',
      scope: 'project',
      projectId: 'nb-fts',
      type: 'fact',
      title: 'To be or not to be',
      content: 'Pure stopword quote and symbol_tok_100 reference 東京 🚀',
    });

    // Execute pure-stopword query, 55KB capped query, and nasty operator/CJK/emoji query against SQLite
    const pureStopRes = await hybridSearch({
      q: 'to be or not to be',
      project_id: 'nb-fts',
      record_types: ['note'],
    });
    expect(pureStopRes.results.map((r) => r.id)).toContain('note-stopword-fallback');

    const hugeSearchRes = await hybridSearch({
      q: hugeQuery,
      project_id: 'nb-fts',
      record_types: ['note'],
    });
    expect(hugeSearchRes.results.map((r) => r.id)).toContain('note-stopword-fallback');

    const nastyRes = await hybridSearch({
      q: `NEAR( "unclosed 'quote' AND OR NOT (foo:bar*) -baz^2 東京 🚀 symbol_tok_100`,
      project_id: 'nb-fts',
      record_types: ['note'],
    });
    expect(nastyRes.results.map((r) => r.id)).toContain('note-stopword-fallback');
  });

  it('ranks concise two-tier strict AND/NEAR matches above verbose single-term + stopword-stuffed records', async () => {
    // Verbose distractor repeats "bridge" 8 times and saturates query stopwords ("how", "did", "my", "the")
    createNote({
      id: 'note-verbose-distractor',
      scope: 'project',
      projectId: 'nb-guitar',
      type: 'fact',
      title: 'How did my bridge setup go on the acoustic bridge',
      content: [
        'How did my bridge hold up when the bridge pins shifted on the bridge plate?',
        'My bridge saddle and the bridge bone needed sanding on the bridge slot.',
        'How did the bridge intonation sound on my bridge test?',
      ].join(' '),
    });

    // Concise exact target contains BOTH rare entities ("Stratocaster" AND "bridge") once
    createNote({
      id: 'note-concise-both',
      scope: 'project',
      projectId: 'nb-guitar',
      type: 'fact',
      title: 'Guitar maintenance log',
      content: 'Levelled the Stratocaster tremolo bridge height to 2.4mm.',
    });

    const res = await hybridSearch({
      q: 'how did I set my Stratocaster bridge',
      project_id: 'nb-guitar',
      record_types: ['note'],
      limit: 5,
    });

    expect(res.results.length).toBeGreaterThanOrEqual(2);
    expect(res.results[0].id).toBe('note-concise-both');
    expect(res.results[0].score).toBeGreaterThan(res.results[1].score);

    // Quoted multi-word title NEAR(..., 6) outranks distant token co-occurrence
    createNote({
      id: 'note-distant-words',
      scope: 'project',
      projectId: 'nb-theatre',
      type: 'fact',
      title: 'Chicago trip notes',
      content:
        'Bought a stained glass lamp at an antique market in the morning and visited a small menagerie exhibit at the park in the evening.',
    });
    createNote({
      id: 'note-exact-play',
      scope: 'project',
      projectId: 'nb-theatre',
      type: 'fact',
      title: 'Chicago theatre evening',
      content: 'Watched a revival of The Glass Menagerie downtown in Chicago.',
    });

    const playRes = await hybridSearch({
      q: 'When did I watch "The Glass Menagerie" in Chicago?',
      project_id: 'nb-theatre',
      record_types: ['note'],
      limit: 5,
    });
    expect(playRes.results[0].id).toBe('note-exact-play');
  });

  it('executes explicit BM25 column weights across all 6 record_types and all 3 query intents, and indexes condensed_text', async () => {
    const db = getDb();
    expect(inspectSchemaAlignment(db)).toEqual({ aligned: true, issues: [] });

    // 1. Notes (4 cols: record_id, title=2.2, content=1.0, extra=1.6): title match outranks body match
    createNote({
      id: 'note-body-match',
      scope: 'project',
      projectId: 'nb-all-types',
      type: 'architecture',
      title: 'General storage notes',
      content: 'Discussesmerkletree synchronization internals in detail for distributed state.',
    });
    // Ensure exact token 'merkletree' is in body vs title
    createNote({
      id: 'note-body-only',
      scope: 'project',
      projectId: 'nb-all-types',
      type: 'architecture',
      title: 'General sync overview',
      content: 'Uses merkletree verification during snapshot replication.',
    });
    createNote({
      id: 'note-title-hit',
      scope: 'project',
      projectId: 'nb-all-types',
      type: 'architecture',
      title: 'Merkletree verification',
      content: 'Uses snapshot replication during startup.',
    });

    const noteTitleRes = await hybridSearch({
      q: 'merkletree',
      project_id: 'nb-all-types',
      record_types: ['note'],
    });
    expect(noteTitleRes.results[0].id).toBe('note-title-hit');

    // 2. Trajectories (4 cols)
    captureTrajectories([
      {
        id: 'traj-bm25-1',
        scope: 'project',
        project_id: 'nb-all-types',
        task_type: 'migration',
        description: 'Backfilled merkletree index shards',
        result: 'Completed in 40ms',
        success: true,
      },
    ]);

    // 3. Observations (6 cols including condensed_text) with relative date anchored only in condensed_text
    captureObservations([
      {
        id: 'obs-condensed-hit',
        scope: 'project',
        project_id: 'nb-all-types',
        kind: 'prompt',
        tool_name: 'Read',
        file_path: 'src/sync/merkletree.ts',
        input: 'Rotated the merkletree signing key yesterday.',
        output: 'Key rotation verified.',
        event_at: '2026-05-15T12:00:00.000Z',
      },
    ]);

    // Raw input only has "yesterday", while condensed_text has inline "[2026-05-14]"
    const obsDateFtsRes = await hybridSearch({
      q: '2026-05-14 signing',
      project_id: 'nb-all-types',
      record_types: ['observation'],
    });
    expect(obsDateFtsRes.results.map((r) => r.id)).toContain('obs-condensed-hit');

    // 4. Summaries (2 cols)
    db.prepare(
      `INSERT INTO summaries (id, scope, project_id, kind, producer_tier, prompt_version, is_latest)
       VALUES ('sum-bm25-1', 'project', 'nb-all-types', 'session', 'agent', 'v1', 1)`
    ).run();
    db.prepare(
      `INSERT INTO summary_claims (id, summary_id, text, ordinal)
       VALUES ('cl-bm25-1', 'sum-bm25-1', 'Verified merkletree snapshot consistency', 0)`
    ).run();

    // 5. Entities (5 cols: name=2.5 > description=1.0) + 1-hop edge
    const entDesc = upsertEntity({
      id: 'ent-desc-only',
      scope: 'project',
      projectId: 'nb-all-types',
      entityType: 'service',
      name: 'State Worker',
      description: 'Manages merkletree repair jobs',
    });
    const entName = upsertEntity({
      id: 'ent-name-hit',
      scope: 'project',
      projectId: 'nb-all-types',
      entityType: 'service',
      name: 'Merkletree Engine',
      description: 'Core state verification component',
      externalRef: 'svc://merkletree',
    });
    linkEntities({
      sourceType: 'entity',
      sourceId: entName.id,
      targetType: 'note',
      targetId: 'note-title-hit',
      relation: 'references',
    });

    const entRes = await hybridSearch({
      q: 'merkletree',
      project_id: 'nb-all-types',
      record_types: ['entity'],
    });
    expect(entRes.results[0].id).toBe(entName.id);
    expect(entRes.results.map((r) => r.id)).toContain(entDesc.id);

    // 6. Actions (4 cols: title=2.0 > description=1.0)
    createAction({
      id: 'act-desc-only',
      scope: 'project',
      projectId: 'nb-all-types',
      title: 'Audit storage queue',
      description: 'Benchmark merkletree throughput under load',
    });
    createAction({
      id: 'act-title-hit',
      scope: 'project',
      projectId: 'nb-all-types',
      title: 'Benchmark merkletree',
      description: 'Run throughput suite under load',
    });

    const actRes = await hybridSearch({
      q: 'merkletree',
      project_id: 'nb-all-types',
      record_types: ['action'],
    });
    expect(actRes.results[0].id).toBe('act-title-hit');

    // 7. Execute all 6 record_types simultaneously across all 3 query intents ('general', 'assistant', 'tool')
    const allRecordTypes = [
      'note',
      'trajectory',
      'observation',
      'summary',
      'entity',
      'action',
    ] as const;

    const generalQuery = 'merkletree verification';
    expect(detectQueryKindIntent(generalQuery)).toBe('general');
    const generalAll = await hybridSearch({
      q: generalQuery,
      project_id: 'nb-all-types',
      record_types: [...allRecordTypes],
      limit: 20,
    });
    expect(new Set(generalAll.results.map((r) => r.record_type))).toEqual(new Set(allRecordTypes));

    const assistantQuery = 'what did you recommend for merkletree verification';
    expect(detectQueryKindIntent(assistantQuery)).toBe('assistant');
    const assistantAll = await hybridSearch({
      q: assistantQuery,
      project_id: 'nb-all-types',
      record_types: [...allRecordTypes],
      limit: 20,
    });
    expect(assistantAll.results.length).toBeGreaterThanOrEqual(6);

    const toolQuery = 'src/sync/merkletree.ts error verification';
    expect(detectQueryKindIntent(toolQuery)).toBe('tool');
    const toolAll = await hybridSearch({
      q: toolQuery,
      project_id: 'nb-all-types',
      record_types: [...allRecordTypes],
      limit: 20,
    });
    expect(toolAll.results.some((r) => r.record_type === 'observation')).toBe(true);

    // 8. storeDiagnostics detects missing condensed_text on fts_observations
    db.exec(`
      DROP TABLE fts_observations;
      CREATE VIRTUAL TABLE fts_observations USING fts5(
        record_id UNINDEXED, tool_name, file_path, input, output, tokenize='porter unicode61'
      );
    `);
    const misaligned = inspectSchemaAlignment(db);
    expect(misaligned.aligned).toBe(false);
    expect(misaligned.issues).toContain('fts_observations.condensed_text missing');
  });

  it('fuzz-tests adversarial FTS5 operators, quote-pairing boundaries, contractions, NEAR invariants, CJK, and 60KB single-line inputs', async () => {
    const db = getDb();

    // 1. Short/empty quoted spans (<3 chars) must NEVER pair their closing quote with the next opening quote
    expect(
      buildStrictFtsQuery('rename column "id" in observations table to "record_id"')
    ).not.toContain('NEAR(');
    expect(
      buildStrictFtsQuery('why did flag "a" break server migration "b"')
    ).not.toContain('NEAR(');
    expect(buildStrictFtsQuery('compare "" in alpha beta to ""')).not.toContain('NEAR(');
    expect(buildStrictFtsQuery("compare '' in alpha beta to ''")).not.toContain('NEAR(');

    // 2. Single-token / duplicate-token / stopword-reduced quotes never emit 1-token or empty NEAR(...)
    expect(buildStrictFtsQuery('"a" "b"')).toBeNull();
    expect(buildSafeFtsQuery('"a" "b"')).toBe('"b"');
    for (const q of [
      '"foo foo" bar',
      '"the only" thing',
      '"to be or not" question',
      '"AND OR NOT NEAR" check',
    ]) {
      const s = buildStrictFtsQuery(q);
      if (s !== null) {
        expect(s).not.toContain('NEAR(');
      }
    }

    // 3. Contractions, possessives, and curly apostrophes never pollute strict AND or evict tech tokens
    expect(buildStrictFtsQuery("what's my favorite coffee")).toBe('"favorite" AND "coffee"');
    expect(buildStrictFtsQuery('What\u2019s my favorite coffee?')).toBe('"favorite" AND "coffee"');
    const jwtStrict = buildStrictFtsQuery("why didn't jwt key work in auth service");
    expect(jwtStrict).not.toContain('"didn"');
    expect(jwtStrict).not.toContain('"t"');
    expect(buildStrictFtsQuery(`read "User's Guide" today`)).toContain(
      'NEAR("user" "guide", 6)'
    );
    expect(buildStrictFtsQuery('Tesla Model S battery')).toContain('"s"');
    expect(buildSafeFtsQuery("what's")).toBe('"what"');
    expect(buildSafeFtsQuery("she wasn't there")).toBe('"she" OR "wasn" OR "there"');

    // End-to-end ranking: contraction query "What's my favorite coffee?" still hits Tier-1 Strict
    createNote({
      id: 'note-coffee-distractor',
      scope: 'project',
      projectId: 'nb-coffee-qa',
      type: 'fact',
      title: 'Coffee gear maintenance',
      content: 'Cleaned the coffee grinder burrs, coffee filter basket, coffee scale, and coffee carafe.',
    });
    createNote({
      id: 'note-coffee-answer',
      scope: 'project',
      projectId: 'nb-coffee-qa',
      type: 'preference',
      title: 'Morning beverage preference',
      content: 'My favorite coffee is washed Ethiopian Yirgacheffe.',
    });
    const coffeeRes = await hybridSearch({
      q: "What's my favorite coffee?",
      project_id: 'nb-coffee-qa',
      record_types: ['note'],
      limit: 5,
    });
    expect(coffeeRes.results[0].id).toBe('note-coffee-answer');

    // 4. CJK quoted multi-token title emits valid NEAR("東京" "タワー", 6) and CJK prefix recall matches unspaced compounds
    expect(buildStrictFtsQuery('"東京 タワー"')).toBe('NEAR("東京" "タワー", 6)');
    expect(buildSafeFtsQuery('東京')).toBe('"東京"*');
    createNote({
      id: 'note-cjk-tower',
      scope: 'project',
      projectId: 'nb-cjk-qa',
      type: 'fact',
      title: '日本旅行メモ',
      content: '夜に 東京 タワー の展望台へ登った。',
    });
    createNote({
      id: 'note-cjk-unspaced',
      scope: 'project',
      projectId: 'nb-cjk-qa',
      type: 'fact',
      title: '夜景スポット',
      content: '東京タワーに行きました。',
    });
    const cjkRes = await hybridSearch({
      q: '"東京 タワー"',
      project_id: 'nb-cjk-qa',
      record_types: ['note'],
    });
    expect(cjkRes.results[0].id).toBe('note-cjk-tower');

    const cjkPrefixRes = await hybridSearch({
      q: '東京',
      project_id: 'nb-cjk-qa',
      record_types: ['note'],
    });
    expect(cjkPrefixRes.results.map((r) => r.id)).toEqual(
      expect.arrayContaining(['note-cjk-tower', 'note-cjk-unspaced'])
    );

    // 5. Adversarial FTS5 syntax & 60KB single-line ReDoS fuzz matrix against real SQLite MATCH
    const adversarialInputs = [
      '"foo',
      "'bar",
      '""',
      "'''",
      '"foo \'bar\' baz"',
      '\'foo "bar baz" qux\'',
      `"didn't"`,
      `"user's 'project'"`,
      '"AND OR NOT NEAR"',
      '"NEAR/5"',
      'NEAR("onlyone", 6)',
      '"input:foo"',
      '"record_id:123"',
      'record_id:123 condensed_text:foo',
      '"^foo*"',
      '"***"',
      '"((a) OR (b"',
      '")((("',
      '"a" "b"',
      '"東京 タワー"',
      '"東京" の "タワー"',
      '🚀 🔥 💻',
      `${'x'.repeat(3999)}🚀 alpha beta`,
      '"'.repeat(60_000),
      "'".repeat(60_000),
      'word '.repeat(15_000),
      '"a '.repeat(20_000),
      "'a ".repeat(20_000),
      '"abc" '.repeat(10_000),
      'ーー 々々 𠮷野家 한글',
    ];

    // Warm JIT before timing 60KB strings
    buildSafeFtsQuery('"'.repeat(60_000));
    buildStrictFtsQuery("'a ".repeat(20_000));

    for (const raw of adversarialInputs) {
      let safe: string | null = null;
      let strict: string | null = null;
      let bestMs = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        safe = buildSafeFtsQuery(raw);
        strict = buildStrictFtsQuery(raw);
        const dt = performance.now() - t0;
        if (dt < bestMs) bestMs = dt;
      }
      expect(bestMs).toBeLessThan(10);

      for (const expr of [safe, strict]) {
        if (expr !== null) {
          expect(expr).not.toMatch(/NEAR\("[^"]+"\s*,\s*6\)/);
          expect(expr).not.toMatch(/(?:^|\s)AND\s*$|^\s*AND(?:\s|$)|AND\s+AND/);
          expect(() =>
            db
              .prepare(
                'SELECT record_id, -bm25(fts_notes, 0.0, 2.2, 1.0, 1.6) FROM fts_notes WHERE fts_notes MATCH ?'
              )
              .all(expr)
          ).not.toThrow();
          expect(() =>
            db
              .prepare(
                'SELECT record_id, -bm25(fts_observations, 0.0, 1.5, 1.6, 1.6, 0.75, 1.8) FROM fts_observations WHERE fts_observations MATCH ?'
              )
              .all(expr)
          ).not.toThrow();
        }
      }
    }
  });
});
