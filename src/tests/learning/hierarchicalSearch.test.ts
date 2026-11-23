import { getDb, resetDb } from '../../lib/db';
import { setCustomEmbedder, serializeEmbedding } from '../../learning/embedding';
import { verifyOrCreateStoreMeta } from '../../learning/storeMeta';
import { hybridSearch } from '../../learning/search';
import { createNote } from '../../memory/noteStore';
import { captureObservations } from '../../memory/observationStore';

describe('hierarchical multi-memory search', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'local';
    process.env.BRAIN_EMBED_MODEL = 'nomic';
    process.env.BRAIN_EMBED_DIM = '4';
    resetDb();
    verifyOrCreateStoreMeta();
  });

  afterEach(() => {
    resetDb();
    setCustomEmbedder(null);
    process.env = { ...originalEnv };
  });

  it('retrieves matching observations beyond 600 rows via FTS5 BM25 (no LIMIT 500 cliff)', async () => {
    process.env.BRAIN_EMBED = 'none';
    const db = getDb();

    captureObservations([
      {
        scope: 'project',
        project_id: 'acme/cogs',
        kind: 'tool_call',
        tool_name: 'bash',
        input: 'run zephyr_canary_token diagnostic',
        output: 'ok',
        created_at: 100,
      },
    ]);

    const insertObs = db.prepare(`
      INSERT INTO observations (id, scope, project_id, kind, tool_name, input, output, created_at)
      VALUES (?, 'project', 'acme/cogs', 'tool_call', 'bash', 'routine filler check', 'ok', ?)
    `);
    for (let i = 0; i < 650; i++) {
      insertObs.run(`obs_fill_${i}`, 1000 + i);
    }

    const res = await hybridSearch({
      q: 'zephyr_canary_token',
      project_id: 'acme/cogs',
      record_types: ['observation'],
      limit: 10,
    });

    expect(res.mode).toBe('bm25');
    expect(res.results).toHaveLength(1);
    expect(res.results[0].record.input).toContain('zephyr_canary_token');
    expect(res.results[0].match_tier).toBe('exact');
  });

  it('inherits ancestor records and isolates sibling and unrelated subproject branches', async () => {
    process.env.BRAIN_EMBED = 'none';

    const rootNote = createNote({
      scope: 'project',
      projectId: 'acme',
      type: 'architecture',
      title: 'Acme root deployment standard',
      content: 'Deployment standard shared across all Acme products',
    });
    const socialsNote = createNote({
      scope: 'project',
      projectId: 'acme/socials',
      type: 'workflow',
      title: 'Socials deployment approval workflow',
      content: 'Deployment approval checklist for socials subprojects',
    });
    const calendarNote = createNote({
      scope: 'project',
      projectId: 'acme/socials/calendar',
      type: 'pattern',
      title: 'Calendar deployment cron schedule',
      content: 'Calendar deployment runs on UTC cron triggers',
    });
    const generatorNote = createNote({
      scope: 'project',
      projectId: 'acme/socials/generator',
      type: 'fact',
      title: 'Generator deployment GPU quota',
      content: 'Sibling generator deployment details must stay isolated',
    });
    const cogsNote = createNote({
      scope: 'project',
      projectId: 'acme/cogs',
      type: 'fact',
      title: 'COGS deployment warehouse config',
      content: 'COGS branch deployment must stay isolated from socials',
    });
    const globalNote = createNote({
      scope: 'global',
      type: 'preference',
      title: 'Global deployment tagging rule',
      content: 'Global deployment preference for immutable release tags',
    });

    const res = await hybridSearch({
      q: 'deployment',
      project_id: 'acme/socials/calendar',
      record_types: ['note'],
      limit: 20,
    });

    const ids = res.results.map((r) => r.id);
    expect(ids).toContain(calendarNote.id);
    expect(ids).toContain(socialsNote.id);
    expect(ids).toContain(rootNote.id);
    expect(ids).toContain(globalNote.id);
    expect(ids).not.toContain(generatorNote.id);
    expect(ids).not.toContain(cogsNote.id);

    // Disabling include_ancestors restricts to exact project (+ global)
    const exactOnly = await hybridSearch({
      q: 'deployment',
      project_id: 'acme/socials/calendar',
      include_ancestors: false,
      include_global: false,
      record_types: ['note'],
    });
    expect(exactOnly.results.map((r) => r.id)).toEqual([calendarNote.id]);
  });

  it('supports parent roll-up with include_children=true and attributes match_tier=child', async () => {
    process.env.BRAIN_EMBED = 'none';

    const rootNote = createNote({
      scope: 'project',
      projectId: 'acme',
      type: 'fact',
      title: 'Acme quarterly audit policy',
      content: 'Quarterly audit baseline across company',
    });
    const calNote = createNote({
      scope: 'project',
      projectId: 'acme/socials/calendar',
      type: 'fact',
      title: 'Calendar quarterly audit report',
      content: 'Calendar quarterly audit export metrics',
    });
    const cogsNote = createNote({
      scope: 'project',
      projectId: 'acme/cogs',
      type: 'fact',
      title: 'COGS quarterly audit ledger',
      content: 'COGS quarterly audit reconciliation',
    });
    const otherOrgNote = createNote({
      scope: 'project',
      projectId: 'acme2/app',
      type: 'fact',
      title: 'Acme2 quarterly audit unrelated',
      content: 'Prefix lookalike acme2 must never match acme child range',
    });

    const res = await hybridSearch({
      q: 'quarterly audit',
      project_id: 'acme',
      include_children: true,
      include_global: false,
      record_types: ['note'],
    });

    const byId = new Map(res.results.map((r) => [r.id, r]));
    expect(byId.has(rootNote.id)).toBe(true);
    expect(byId.has(calNote.id)).toBe(true);
    expect(byId.has(cogsNote.id)).toBe(true);
    expect(byId.has(otherOrgNote.id)).toBe(false);

    expect(byId.get(rootNote.id)?.match_tier).toBe('exact');
    expect(byId.get(calNote.id)?.match_tier).toBe('child');
    expect(byId.get(cogsNote.id)?.match_tier).toBe('child');
  });

  it('orders tiers strictly as exact > parent > grandparent > global > child and attributes match_tier', async () => {
    const db = getDb();
    setCustomEmbedder(async () => [1, 0, 0, 0]);
    const vec = serializeEmbedding([1, 0, 0, 0]);

    const sharedTitle = 'Release readiness protocol';
    const sharedContent = 'Standardized release readiness protocol for deployments';

    const childNote = createNote({
      scope: 'project',
      projectId: 'acme/socials/calendar/v2',
      type: 'fact',
      title: sharedTitle,
      content: sharedContent,
    });
    const globalNote = createNote({
      scope: 'global',
      type: 'fact',
      title: sharedTitle,
      content: sharedContent,
    });
    const grandparentNote = createNote({
      scope: 'project',
      projectId: 'acme',
      type: 'fact',
      title: sharedTitle,
      content: sharedContent,
    });
    const parentNote = createNote({
      scope: 'project',
      projectId: 'acme/socials',
      type: 'fact',
      title: sharedTitle,
      content: sharedContent,
    });
    const exactNote = createNote({
      scope: 'project',
      projectId: 'acme/socials/calendar',
      type: 'fact',
      title: sharedTitle,
      content: sharedContent,
    });

    for (const id of [childNote.id, globalNote.id, grandparentNote.id, parentNote.id, exactNote.id]) {
      db.prepare('UPDATE notes SET embedding = ? WHERE id = ?').run(vec, id);
    }

    const hybridRes = await hybridSearch({
      q: 'release readiness protocol',
      project_id: 'acme/socials/calendar',
      include_children: true,
      include_global: true,
      record_types: ['note'],
    });

    expect(hybridRes.mode).toBe('hybrid');
    expect(hybridRes.results.map((r) => r.id)).toEqual([
      exactNote.id,
      parentNote.id,
      grandparentNote.id,
      globalNote.id,
      childNote.id,
    ]);
    expect(hybridRes.results.map((r) => r.match_tier)).toEqual([
      'exact',
      'ancestor',
      'ancestor',
      'global',
      'child',
    ]);
    expect(hybridRes.results.map((r) => r.project_id)).toEqual([
      'acme/socials/calendar',
      'acme/socials',
      'acme',
      null,
      'acme/socials/calendar/v2',
    ]);

    // Also verify identical tier ordering in BM25-only mode
    process.env.BRAIN_EMBED = 'none';
    const bm25Res = await hybridSearch({
      q: 'release readiness protocol',
      project_id: 'acme/socials/calendar',
      include_children: true,
      include_global: true,
      record_types: ['note'],
    });
    expect(bm25Res.mode).toBe('bm25');
    expect(bm25Res.results.map((r) => r.id)).toEqual([
      exactNote.id,
      parentNote.id,
      grandparentNote.id,
      globalNote.id,
      childNote.id,
    ]);
  });

  it('uses 3-signal Entity-Graph RRF to surface and boost entity-linked notes with matched_entities', async () => {
    const db = getDb();
    setCustomEmbedder(async () => [1, 0, 0, 0]);
    const matchVec = serializeEmbedding([1, 0, 0, 0]);

    db.prepare(`
      INSERT INTO entities (id, scope, project_id, entity_type, name, description, embedding)
      VALUES ('ent_aurora', 'project', 'acme/socials', 'brand', 'Aurora Campaign', 'Flagship campaign entity', ?)
    `).run(matchVec);

    // Note 1: matches lexical/dense query AND is linked via entity_edges -> gets all 3 signals
    const boostedNote = createNote({
      scope: 'project',
      projectId: 'acme/socials/calendar',
      type: 'workflow',
      title: 'Aurora Campaign slot cadence',
      content: 'Aurora Campaign posts publish every Tuesday morning',
    });
    db.prepare('UPDATE notes SET embedding = ? WHERE id = ?').run(matchVec, boostedNote.id);

    // Note 2: same lexical/dense match, NOT linked to any entity -> ranks below boostedNote
    const unlinkedNote = createNote({
      scope: 'project',
      projectId: 'acme/socials/calendar',
      type: 'workflow',
      title: 'Aurora Campaign slot cadence copy',
      content: 'Aurora Campaign posts publish every Tuesday morning',
    });
    db.prepare('UPDATE notes SET embedding = ? WHERE id = ?').run(matchVec, unlinkedNote.id);

    // Note 3: ZERO lexical overlap with "Aurora Campaign", orthogonal vector, discovered purely via 1-hop entity_edges
    const indirectNote = createNote({
      scope: 'project',
      projectId: 'acme/socials/calendar',
      type: 'fact',
      title: 'Tuesday approval checklist',
      content: 'Ensure legal signoff before queuing social slots',
    });
    db.prepare('UPDATE notes SET embedding = ? WHERE id = ?').run(
      serializeEmbedding([0, 1, 0, 0]),
      indirectNote.id
    );

    // Note 4: in isolated sibling branch acme/cogs linked to same ancestor entity -> must stay hidden
    const siblingNote = createNote({
      scope: 'project',
      projectId: 'acme/cogs',
      type: 'fact',
      title: 'Aurora budget ledger',
      content: 'COGS expense tracking for Aurora',
    });

    db.prepare(`
      INSERT INTO entity_edges (id, source_type, source_id, target_type, target_id, relation)
      VALUES
        ('edge_1', 'note', ?, 'entity', 'ent_aurora', 'references'),
        ('edge_2', 'entity', 'ent_aurora', 'note', ?, 'related_to'),
        ('edge_3', 'note', ?, 'entity', 'ent_aurora', 'references')
    `).run(boostedNote.id, indirectNote.id, siblingNote.id);

    const hybridRes = await hybridSearch({
      q: 'Aurora Campaign',
      project_id: 'acme/socials/calendar',
      record_types: ['note'],
    });

    const resultIds = hybridRes.results.map((r) => r.id);
    expect(resultIds).toContain(indirectNote.id);
    expect(resultIds).not.toContain(siblingNote.id);
    expect(resultIds.indexOf(boostedNote.id)).toBeLessThan(resultIds.indexOf(unlinkedNote.id));

    const boostedItem = hybridRes.results.find((r) => r.id === boostedNote.id)!;
    expect(boostedItem.matched_entities).toEqual(['Aurora Campaign']);
    const indirectItem = hybridRes.results.find((r) => r.id === indirectNote.id)!;
    expect(indirectItem.matched_entities).toEqual(['Aurora Campaign']);
    const unlinkedItem = hybridRes.results.find((r) => r.id === unlinkedNote.id)!;
    expect(unlinkedItem.matched_entities).toBeUndefined();

    // Verify BM25-only mode also discovers indirect entity-linked notes and boosts linked matches
    process.env.BRAIN_EMBED = 'none';
    const bm25Res = await hybridSearch({
      q: 'Aurora Campaign',
      project_id: 'acme/socials/calendar',
      record_types: ['note'],
    });
    const bm25Ids = bm25Res.results.map((r) => r.id);
    expect(bm25Ids).toContain(indirectNote.id);
    expect(bm25Ids).not.toContain(siblingNote.id);
    expect(bm25Ids.indexOf(boostedNote.id)).toBeLessThan(bm25Ids.indexOf(unlinkedNote.id));
  });

  it('enforces temporal filters (after, before, as_of, include_history), expired down-ranking, and temporal_bias', async () => {
    process.env.BRAIN_EMBED = 'none';
    const db = getDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const futureIso = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const pastIso = new Date(Date.now() - 7 * 86_400_000).toISOString();

    // Versioned & valid_until notes
    const v1 = createNote({
      scope: 'project',
      projectId: 'acme/cogs',
      type: 'fact',
      title: 'Billing rate policy',
      content: 'Billing rate was 10 percent in Q1',
    });
    db.prepare(
      `UPDATE notes SET valid_from = '2026-01-01T00:00:00.000Z', valid_until = '2026-03-31T23:59:59.000Z', event_at = '2026-02-01T00:00:00.000Z' WHERE id = ?`
    ).run(v1.id);

    const v2 = createNote({
      scope: 'project',
      projectId: 'acme/cogs',
      type: 'fact',
      title: 'Billing rate policy',
      content: 'Billing rate updated to 12 percent in Q2',
      supersedes: v1.id,
    });
    db.prepare(
      `UPDATE notes SET valid_from = '2026-04-01T00:00:00.000Z', valid_until = '2026-06-30T23:59:59.000Z', event_at = '2026-05-01T00:00:00.000Z' WHERE id = ?`
    ).run(v2.id);

    // Invalid timestamp throws SCHEMA_INVALID
    await expect(
      hybridSearch({
        q: 'billing rate',
        project_id: 'acme/cogs',
        as_of: 'not-a-valid-date',
      })
    ).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });

    // Default excludes superseded v1
    const defaultRes = await hybridSearch({
      q: 'billing rate',
      project_id: 'acme/cogs',
      record_types: ['note'],
    });
    expect(defaultRes.results.map((r) => r.id)).toEqual([v2.id]);

    // include_history + as_of recovers historical v1 cleanly
    const asOfQ1 = await hybridSearch({
      q: 'billing rate',
      project_id: 'acme/cogs',
      record_types: ['note'],
      include_history: true,
      as_of: '2026-02-15T12:00:00Z',
    });
    expect(asOfQ1.results.map((r) => r.id)).toEqual([v1.id]);

    // after / before on note event_at
    const afterRes = await hybridSearch({
      q: 'billing rate',
      project_id: 'acme/cogs',
      record_types: ['note'],
      include_history: true,
      after: '2026-04-15T00:00:00Z',
      before: '2026-05-15T00:00:00Z',
    });
    expect(afterRes.results.map((r) => r.id)).toEqual([v2.id]);

    // Expired note down-ranking (* 0.75) vs active note with identical text
    const expiredNote = createNote({
      scope: 'project',
      projectId: 'acme/socials',
      type: 'fact',
      title: 'Promo banner rotation',
      content: 'Promo banner rotation specification',
      createdAt: nowSec - 10,
    });
    db.prepare(`UPDATE notes SET valid_until = ? WHERE id = ?`).run(pastIso, expiredNote.id);

    const activeNote = createNote({
      scope: 'project',
      projectId: 'acme/socials',
      type: 'fact',
      title: 'Promo banner rotation',
      content: 'Promo banner rotation specification',
      createdAt: nowSec - 10,
    });
    db.prepare(`UPDATE notes SET valid_until = ? WHERE id = ?`).run(futureIso, activeNote.id);

    const expiryRes = await hybridSearch({
      q: 'promo banner rotation',
      project_id: 'acme/socials',
      record_types: ['note'],
    });
    expect(expiryRes.results.map((r) => r.id)).toEqual([activeNote.id, expiredNote.id]);
    expect(expiryRes.results[1].score).toBeCloseTo(expiryRes.results[0].score * 0.75, 5);

    // temporal_bias='recent' ranks today's note above a 1-year-old identical note
    const oldNote = createNote({
      scope: 'project',
      projectId: 'acme/cogs',
      type: 'pattern',
      title: 'Cache invalidation checklist',
      content: 'Flush CDN edge keys after deploy',
      createdAt: nowSec - 365 * 86_400,
    });
    const recentNote = createNote({
      scope: 'project',
      projectId: 'acme/cogs',
      type: 'pattern',
      title: 'Cache invalidation checklist',
      content: 'Flush CDN edge keys after deploy',
      createdAt: nowSec - 60,
    });
    const recentRes = await hybridSearch({
      q: 'cache invalidation checklist',
      project_id: 'acme/cogs',
      record_types: ['note'],
      temporal_bias: 'recent',
    });
    expect(recentRes.results.map((r) => r.id)).toEqual([recentNote.id, oldNote.id]);

    // temporal_bias='upcoming' boosts upcoming actions (due_at >= now) and upcoming notes (event_at >= now)
    db.prepare(`
      INSERT INTO actions (id, scope, project_id, title, description, status, priority, due_at)
      VALUES
        ('act_past', 'project', 'acme/cogs', 'Tax filing deadline', 'Submit quarterly filing', 'ready', 'normal', ?),
        ('act_upcoming', 'project', 'acme/cogs', 'Tax filing deadline', 'Submit quarterly filing', 'ready', 'normal', ?)
    `).run(pastIso, futureIso);

    const upcomingActRes = await hybridSearch({
      q: 'tax filing deadline',
      project_id: 'acme/cogs',
      record_types: ['action'],
      temporal_bias: 'upcoming',
    });
    expect(upcomingActRes.results.map((r) => r.id)).toEqual(['act_upcoming', 'act_past']);
    expect(upcomingActRes.results[0].score).toBeCloseTo(upcomingActRes.results[1].score * 1.12, 5);

    const upcomingNoteAfter = await hybridSearch({
      q: 'tax filing deadline',
      project_id: 'acme/cogs',
      record_types: ['action'],
      after: new Date().toISOString(),
    });
    expect(upcomingNoteAfter.results.map((r) => r.id)).toEqual(['act_upcoming']);
  });

  it('filters by user_id when supplied and NEVER filters on agent_id', async () => {
    process.env.BRAIN_EMBED = 'none';
    const db = getDb();

    const aliceClaude = createNote({
      scope: 'project',
      projectId: 'acme/socials',
      type: 'preference',
      title: 'Publishing tone guideline',
      content: 'Use concise active voice',
    });
    db.prepare(`UPDATE notes SET user_id = 'usr-alice', agent_id = 'agent-claude' WHERE id = ?`).run(
      aliceClaude.id
    );

    const aliceCodex = createNote({
      scope: 'project',
      projectId: 'acme/socials',
      type: 'preference',
      title: 'Publishing tone formatting',
      content: 'Use active voice and short headings',
    });
    db.prepare(`UPDATE notes SET user_id = 'usr-alice', agent_id = 'agent-codex' WHERE id = ?`).run(
      aliceCodex.id
    );

    const bobClaude = createNote({
      scope: 'project',
      projectId: 'acme/socials',
      type: 'preference',
      title: 'Publishing tone override',
      content: 'Use formal active voice',
    });
    db.prepare(`UPDATE notes SET user_id = 'usr-bob', agent_id = 'agent-claude' WHERE id = ?`).run(
      bobClaude.id
    );

    db.prepare(`
      INSERT INTO entities (id, scope, project_id, user_id, agent_id, entity_type, name, description)
      VALUES
        ('ent_alice', 'project', 'acme/socials', 'usr-alice', 'agent-codex', 'person', 'Alice Tone Owner', 'Active voice reviewer'),
        ('ent_bob', 'project', 'acme/socials', 'usr-bob', 'agent-claude', 'person', 'Bob Tone Owner', 'Active voice reviewer')
    `).run();

    const resUserParam = await hybridSearch({
      q: 'active voice',
      project_id: 'acme/socials',
      user_id: 'usr-alice',
      record_types: ['note', 'entity'],
      // Even if an unknown agent_id field is passed, agent_id must NEVER filter
      ...({ agent_id: 'agent-claude', filters: { agent_id: 'agent-claude' } } as any),
    });

    const ids = resUserParam.results.map((r) => r.id).sort();
    expect(ids).toEqual([aliceClaude.id, aliceCodex.id, 'ent_alice'].sort());
    expect(ids).not.toContain(bobClaude.id);
    expect(ids).not.toContain('ent_bob');

    // Also verify filters.user_id + filters.entity_type
    const resFilterUser = await hybridSearch({
      q: 'active voice',
      project_id: 'acme/socials',
      record_types: ['entity'],
      filters: { user_id: 'usr-bob', entity_type: 'person' },
    });
    expect(resFilterUser.results.map((r) => r.id)).toEqual(['ent_bob']);
  });

  it('ignores low-similarity dense entity noise (< 0.55) when seeding entity-graph RRF', async () => {
    const db = getDb();
    // Query vector is [1, 0, 0, 0]
    setCustomEmbedder(async () => [1, 0, 0, 0]);

    // Noise entity has cosine similarity ~0.30 with [1, 0, 0, 0] and no lexical overlap
    const lowSimVec = serializeEmbedding([0.3, 0.9539, 0, 0]);
    db.prepare(`
      INSERT INTO entities (id, scope, project_id, entity_type, name, description, embedding)
      VALUES ('ent_noise', 'project', 'acme/socials', 'brand', 'Unrelated Zebra', 'Completely different topic', ?)
    `).run(lowSimVec);

    const linkedNote = createNote({
      scope: 'project',
      projectId: 'acme/socials',
      type: 'fact',
      title: 'Zebra logistics',
      content: 'Completely unrelated content',
    });
    db.prepare(`
      INSERT INTO entity_edges (id, source_type, source_id, target_type, target_id, relation)
      VALUES ('edge_noise', 'entity', 'ent_noise', 'note', ?, 'references')
    `).run(linkedNote.id);

    const res = await hybridSearch({
      q: 'quarterly billing audit',
      project_id: 'acme/socials',
      record_types: ['note'],
    });

    // Neither lexical nor high-sim dense match -> must NOT be pulled in by noise entity
    expect(res.results.find((r) => r.id === linkedNote.id)).toBeUndefined();
  });

  it('scopes FTS5 AFTER UPDATE triggers to indexed text columns so embedding writes do not re-index', () => {
    const db = getDb();
    const n1 = createNote({
      scope: 'project',
      projectId: 'acme/socials',
      type: 'fact',
      title: 'First indexed note',
      content: 'Original body text',
    });
    createNote({
      scope: 'project',
      projectId: 'acme/socials',
      type: 'fact',
      title: 'Second indexed note',
      content: 'Keeps max rowid ahead of n1',
    });

    const rowidBefore = (
      db.prepare('SELECT rowid FROM fts_notes WHERE record_id = ?').get(n1.id) as { rowid: number }
    ).rowid;

    // Non-text update (embedding BLOB) must NOT fire trg_fts_notes_au
    db.prepare('UPDATE notes SET embedding = ? WHERE id = ?').run(serializeEmbedding([1, 0, 0, 0]), n1.id);
    const rowidAfterEmbed = (
      db.prepare('SELECT rowid FROM fts_notes WHERE record_id = ?').get(n1.id) as { rowid: number }
    ).rowid;
    expect(rowidAfterEmbed).toBe(rowidBefore);

    // Text update (title) MUST fire trg_fts_notes_au and update searchable content
    db.prepare('UPDATE notes SET title = ? WHERE id = ?').run('Renamed phoenix protocol', n1.id);
    const rowidAfterTitle = (
      db.prepare('SELECT rowid FROM fts_notes WHERE record_id = ?').get(n1.id) as { rowid: number }
    ).rowid;
    expect(rowidAfterTitle).toBeGreaterThan(rowidAfterEmbed);

    const ftsHit = db
      .prepare(`SELECT record_id FROM fts_notes WHERE fts_notes MATCH '"phoenix"'`)
      .all() as Array<{ record_id: string }>;
    expect(ftsHit.map((r) => r.record_id)).toEqual([n1.id]);
  });

  it('filters and ranks observations by event_at (after, before, temporal_bias) even when ingested in same-second batch', async () => {
    process.env.BRAIN_EMBED = 'none';
    const sameIngestSec = Math.floor(Date.now() / 1000);
    const futureIso = new Date(Date.now() + 14 * 86_400_000).toISOString();

    // All observations share the exact same created_at (simulating a bulk/spool import),
    // but have distinct historical/future event_at timestamps (ingested out of order).
    const cap = captureObservations([
      {
        id: 'obs-jan',
        scope: 'project',
        project_id: 'acme/ops',
        kind: 'prompt',
        input: 'Deploy canary release pipeline',
        event_at: '2025-01-10T12:00:00Z',
        created_at: sameIngestSec,
      },
      {
        id: 'obs-jun',
        scope: 'project',
        project_id: 'acme/ops',
        kind: 'prompt',
        input: 'Deploy canary release pipeline',
        event_at: '2025-06-20T12:00:00Z',
        created_at: sameIngestSec,
      },
      {
        id: 'obs-mar',
        scope: 'project',
        project_id: 'acme/ops',
        kind: 'prompt',
        input: 'Deploy canary release pipeline',
        event_at: '2025-03-15T12:00:00Z',
        created_at: sameIngestSec,
      },
      {
        id: 'obs-null-event',
        scope: 'project',
        project_id: 'acme/ops',
        kind: 'prompt',
        input: 'Deploy canary release pipeline',
        created_at: Math.floor(Date.parse('2025-04-01T00:00:00Z') / 1000),
      },
    ]);
    expect(cap.accepted).toBe(4);

    // after / before range matches event_at (and falls back to created_at when event_at is NULL)
    const rangeRes = await hybridSearch({
      q: 'Deploy canary release pipeline',
      project_id: 'acme/ops',
      record_types: ['observation'],
      after: '2025-03-01T00:00:00Z',
      before: '2025-05-01T00:00:00Z',
      limit: 10,
    });
    expect(rangeRes.results.map((r) => r.id).sort()).toEqual(['obs-mar', 'obs-null-event']);
    const marHit = rangeRes.results.find((r) => r.id === 'obs-mar')!;
    expect(marHit.record.event_at).toBe('2025-03-15T12:00:00.000Z');

    // temporal_bias: 'recent' ranks obs-jun > obs-null-event (Apr) > obs-mar > obs-jan
    // despite identical text and identical created_at for jan/mar/jun
    const recentRes = await hybridSearch({
      q: 'Deploy canary release pipeline',
      project_id: 'acme/ops',
      record_types: ['observation'],
      temporal_bias: 'recent',
      limit: 10,
    });
    expect(recentRes.results.map((r) => r.id)).toEqual([
      'obs-jun',
      'obs-null-event',
      'obs-mar',
      'obs-jan',
    ]);

    // temporal_bias: 'upcoming' boosts observations with future event_at
    captureObservations([
      {
        id: 'obs-past-launch',
        scope: 'project',
        project_id: 'acme/ops',
        kind: 'prompt',
        input: 'Quarterly summit keynote checklist',
        event_at: '2025-01-01T00:00:00Z',
        created_at: sameIngestSec,
      },
      {
        id: 'obs-future-launch',
        scope: 'project',
        project_id: 'acme/ops',
        kind: 'prompt',
        input: 'Quarterly summit keynote checklist',
        event_at: futureIso,
        created_at: sameIngestSec,
      },
    ]);

    const upcomingRes = await hybridSearch({
      q: 'Quarterly summit keynote checklist',
      project_id: 'acme/ops',
      record_types: ['observation'],
      temporal_bias: 'upcoming',
      limit: 10,
    });
    expect(upcomingRes.results.map((r) => r.id)).toEqual(['obs-future-launch', 'obs-past-launch']);
  });
});
