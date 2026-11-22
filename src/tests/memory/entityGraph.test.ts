import request from 'supertest';
import { randomUUID } from 'crypto';
import { getDb, resetDb } from '../../lib/db';
import { createApp } from '../../app';
import { verifyOrCreateStoreMeta } from '../../learning/storeMeta';
import { createNote } from '../../memory/noteStore';
import { createAction } from '../../memory/actionStore';
import { startSession } from '../../memory/sessionStore';
import { logTrajectory } from '../../memory/trajectoryStore';
import { captureObservations } from '../../memory/observationStore';
import {
  STANDARD_ENTITY_TYPES,
  STANDARD_EDGE_RELATIONS,
  upsertEntity,
  getEntity,
  listEntities,
  linkEntities,
  unlinkEntities,
  parseGraphQuery,
  getKnowledgeGraph,
} from '../../memory/graphStore';

describe('Entity Graph, Hierarchical Graph Scoping & Multi-Hop BFS', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'none';
    resetDb();
    getDb();
  });

  afterEach(() => {
    resetDb();
    process.env = { ...originalEnv };
  });

  it('exports domain-agnostic standard entity types and edge relations', () => {
    expect(STANDARD_ENTITY_TYPES).toEqual([
      'brand',
      'person',
      'asset',
      'metric',
      'document',
      'tool',
    ]);
    expect(STANDARD_EDGE_RELATIONS).toEqual([
      'part_of',
      'depends_on',
      'references',
      'owns',
      'produced_by',
      'blocks',
      'related_to',
    ]);
  });

  describe('upsertEntity, getEntity, listEntities', () => {
    it('enforces explicit Rule 4 scope and validates required entity_type and name', () => {
      // Missing project_id with scope='project'
      expect(() =>
        upsertEntity({
          scope: 'project',
          entity_type: 'brand',
          name: 'Acme',
        })
      ).toThrow();

      try {
        upsertEntity({ scope: 'project', entity_type: 'brand', name: 'Acme' });
      } catch (err: any) {
        expect(err.code).toBe('SCHEMA_INVALID');
      }

      // project_id supplied with scope='global' or 'unknown' or omitted
      for (const badScope of ['global', 'unknown', undefined] as const) {
        try {
          upsertEntity({
            scope: badScope,
            project_id: 'acme/cogs',
            entity_type: 'asset',
            name: 'Hero Banner',
          });
          throw new Error('Expected SCHEMA_INVALID');
        } catch (err: any) {
          expect(err.code).toBe('SCHEMA_INVALID');
        }
      }

      // Omitted scope with no project_id defaults to 'unknown'
      const unk = upsertEntity({
        entity_type: 'tool',
        name: 'Render CLI',
      });
      expect(unk.scope).toBe('unknown');
      expect(unk.project_id).toBeNull();

      // Empty entity_type or name rejected with SCHEMA_INVALID
      try {
        upsertEntity({ scope: 'global', entity_type: '   ', name: 'Valid' });
        throw new Error('Expected SCHEMA_INVALID');
      } catch (err: any) {
        expect(err.code).toBe('SCHEMA_INVALID');
      }
      try {
        upsertEntity({ scope: 'global', entity_type: 'brand', name: '   ' });
        throw new Error('Expected SCHEMA_INVALID');
      } catch (err: any) {
        expect(err.code).toBe('SCHEMA_INVALID');
      }
    });

    it('redacts secrets, deduplicates case-insensitively, enqueues embeddings, and never returns embedding BLOB', () => {
      const db = getDb();

      const first = upsertEntity({
        scope: 'project',
        project_id: '  Acme / Socials / Generator ',
        entity_type: 'asset',
        name: 'Campaign Key sk-ant-api03-1234567890abcdefghij1234567890',
        description: 'Token ghp_abcdefghijklmnopqrstuvwxyz123456 in summary',
        external_ref: 'postgres://admin:supersecretpw@db.example.com:5432/media',
        metadata: { api_key: 'sk-proj-abcdefghijklmnopqrstuvwxyz123456', format: 'mp4' },
        user_id: 'user-alice',
        agent_id: 'agent-1',
      });

      expect(first.id).toMatch(/^ent_[0-9a-f]{16}$/);
      expect(first.project_id).toBe('acme/socials/generator');
      expect(first.name).toBe('Campaign Key [REDACTED_API_KEY]');
      expect(first.description).toBe('Token [REDACTED_TOKEN] in summary');
      expect(first.external_ref).toBe('postgres://admin:[REDACTED_PASSWORD]@db.example.com:5432/media');
      expect(first.metadata_json).toContain('[REDACTED_API_KEY]');
      expect(first.metadata_json).not.toContain('sk-proj-');
      expect((first as any).embedding).toBeUndefined();

      // Verify embed_queue entry was created atomically
      const qRow = db
        .prepare("SELECT record_id, record_type, status FROM embed_queue WHERE record_id = ? AND record_type = 'entity'")
        .get(first.id) as { record_id: string; record_type: string; status: string } | undefined;
      expect(qRow).toEqual({ record_id: first.id, record_type: 'entity', status: 'pending' });

      // Mark done, then upsert again with different casing to test dedup + re-enqueue + coalescing
      db.prepare("UPDATE embed_queue SET status = 'done' WHERE record_id = ?").run(first.id);

      const second = upsertEntity({
        scope: 'project',
        projectId: 'acme/socials/generator',
        entityType: 'asset',
        name: 'campaign key [REDACTED_API_KEY]',
        externalRef: 's3://acme-assets/socials/launch-v2.mp4',
        agentId: 'agent-2',
      });

      expect(second.id).toBe(first.id);
      expect(second.description).toBe('Token [REDACTED_TOKEN] in summary');
      expect(second.external_ref).toBe('s3://acme-assets/socials/launch-v2.mp4');
      expect(second.user_id).toBe('user-alice');
      expect(second.agent_id).toBe('agent-2');
      expect(second.metadata_json).toContain('"format":"mp4"');

      // Re-enqueued for embedding
      const qRow2 = db
        .prepare("SELECT status FROM embed_queue WHERE record_id = ? AND record_type = 'entity'")
        .get(first.id) as { status: string };
      expect(qRow2.status).toBe('pending');

      // Same name under different scope or entity_type creates distinct entity
      const globalSameName = upsertEntity({
        scope: 'global',
        entity_type: 'asset',
        name: 'campaign key [REDACTED_API_KEY]',
      });
      expect(globalSameName.id).not.toBe(first.id);

      // Even if embedding BLOB exists in DB, getEntity and listEntities never expose it
      db.prepare('UPDATE entities SET embedding = ? WHERE id = ?').run(Buffer.from([1, 2, 3, 4]), first.id);
      const fetched = getEntity(first.id);
      expect(fetched).toBeDefined();
      expect('embedding' in fetched!).toBe(false);

      const listed = listEntities({ projectId: 'acme/socials/generator', includeGlobal: false });
      expect(listed).toHaveLength(1);
      expect('embedding' in listed[0]).toBe(false);
      expect(listed[0].match_tier).toBe('exact');
    });

    it('updates by explicit id when id already exists', () => {
      const created = upsertEntity({
        id: 'ent_custom_01',
        scope: 'project',
        project_id: 'acme/cogs',
        entity_type: 'metric',
        name: 'Unit Cost',
        description: 'Initial',
      });
      expect(created.id).toBe('ent_custom_01');

      const updated = upsertEntity({
        id: 'ent_custom_01',
        scope: 'project',
        project_id: 'acme/cogs',
        entity_type: 'metric',
        name: 'Unit Cost USD',
      });
      expect(updated.id).toBe('ent_custom_01');
      expect(updated.name).toBe('Unit Cost USD');
      expect(updated.description).toBe('Initial');
    });
  });

  describe('linkEntities & unlinkEntities across subprojects', () => {
    it('auto-resolves endpoint types, supports cross-subproject links, upserts metadata, and unlinks cleanly', () => {
      const note = createNote({
        id: 'note-launch-plan',
        scope: 'project',
        projectId: 'acme/marketing/launch',
        type: 'architecture',
        title: 'Launch campaign asset references',
        content: 'Use generated hero reel from socials generator.',
      });

      const asset = upsertEntity({
        scope: 'project',
        project_id: 'acme/socials/generator',
        entity_type: 'asset',
        name: 'Launch Hero Reel',
        external_ref: 's3://acme-media/reels/hero-01.mp4',
      });

      const edge = linkEntities({
        source_id: note.id,
        target_id: asset.id,
        relation: 'references',
        metadata: { weight: 0.9 },
      });

      expect(edge.id).toMatch(/^edge_[0-9a-f]{16}$/);
      expect(edge.source_type).toBe('note');
      expect(edge.source_id).toBe(note.id);
      expect(edge.target_type).toBe('entity');
      expect(edge.target_id).toBe(asset.id);
      expect(edge.relation).toBe('references');
      expect(edge.metadata_json).toBe('{"weight":0.9}');

      // Upserting same edge updates metadata without duplicating row
      const edgeUpdated = linkEntities({
        source_id: note.id,
        target_id: asset.id,
        relation: 'references',
        metadata: { weight: 1.0, slot: 'hero' },
      });
      expect(edgeUpdated.id).toBe(edge.id);
      expect(edgeUpdated.metadata_json).toBe('{"weight":1,"slot":"hero"}');

      // Custom relation & explicit external endpoint type work cleanly
      const extEdge = linkEntities({
        source_id: asset.id,
        target_type: 'external',
        target_id: 'figma://file/launch-board-v3',
        relation: 'exported_from',
      });
      expect(extEdge.source_type).toBe('entity');
      expect(extEdge.target_type).toBe('external');

      // Non-existent endpoint rejects with NOT_FOUND
      try {
        linkEntities({
          source_id: 'missing-node',
          target_id: asset.id,
          relation: 'references',
        });
        throw new Error('Expected NOT_FOUND');
      } catch (err: any) {
        expect(err.code).toBe('NOT_FOUND');
      }

      // Unlink requires at least id, source_id, or target_id
      try {
        unlinkEntities({ relation: 'references' });
        throw new Error('Expected SCHEMA_INVALID');
      } catch (err: any) {
        expect(err.code).toBe('SCHEMA_INVALID');
      }

      expect(unlinkEntities({ source_id: asset.id, relation: 'exported_from' })).toEqual({ deleted: 1 });
      expect(unlinkEntities({ id: edge.id })).toEqual({ deleted: 1 });
      expect(unlinkEntities({ id: edge.id })).toEqual({ deleted: 0 });
    });
  });

  describe('Multi-hop BFS, node_id focal traversal, relation filter & hierarchical scoping', () => {
    it('traverses 1..3 hops across subprojects and hydrates entity, note, action, trajectory, and observation nodes', () => {
      const launchNote = createNote({
        id: 'note-mkt-1',
        scope: 'project',
        projectId: 'acme/marketing/launch',
        type: 'workflow',
        title: 'Launch checklist',
        content: 'Pull social video asset.',
      });

      const genAsset = upsertEntity({
        id: 'ent-gen-asset',
        scope: 'project',
        project_id: 'acme/socials/generator',
        entity_type: 'asset',
        name: 'Promo Reel',
        external_ref: 's3://acme/reels/promo.mp4',
      });

      const renderTool = upsertEntity({
        id: 'ent-render-tool',
        scope: 'project',
        project_id: 'acme/infra/render',
        entity_type: 'tool',
        name: 'FFmpeg Pipeline',
      });

      const trajId = logTrajectory({
        id: 'traj-cogs-1',
        scope: 'project',
        projectId: 'acme/cogs',
        taskType: 'render_cost',
        description: 'Compute GPU minutes per video render',
        success: true,
      });

      const cap = captureObservations([
        {
          id: 'obs-cogs-1',
          scope: 'project',
          project_id: 'acme/cogs',
          kind: 'tool_call',
          tool_name: 'ffmpeg',
          input: 'ffmpeg -i in.mov out.mp4',
          output: 'ok',
        },
      ]);
      expect(cap.accepted).toBe(1);

      const followUp = createAction({
        id: 'act-brand-1',
        scope: 'project',
        project_id: 'acme/marketing/launch',
        title: 'Approve promo cut',
      });

      // Chain: launchNote -> (references) -> genAsset -> (produced_by) -> renderTool -> (measured_by) -> trajId -> (observed_in) -> obs-cogs-1
      // Plus: launchNote -> (depends_on) -> followUp
      linkEntities({ source_id: launchNote.id, target_id: genAsset.id, relation: 'references' });
      linkEntities({ source_id: genAsset.id, target_id: renderTool.id, relation: 'produced_by' });
      linkEntities({ source_id: renderTool.id, target_id: trajId, relation: 'measured_by' });
      linkEntities({ source_id: trajId, target_id: 'obs-cogs-1', relation: 'observed_in' });
      linkEntities({ source_id: launchNote.id, target_id: followUp.id, relation: 'depends_on' });

      // Depth 1 from acme/marketing/launch sees genAsset (cross-subproject!) + followUp, NOT hop 2/3
      const d1 = getKnowledgeGraph({ projectId: 'acme/marketing/launch', depth: 1 });
      const d1Ids = new Set(d1.nodes.map((n) => n.id));
      expect(d1Ids.has('note-mkt-1')).toBe(true);
      expect(d1Ids.has('act-brand-1')).toBe(true);
      expect(d1Ids.has('ent-gen-asset')).toBe(true);
      expect(d1.nodes.find((n) => n.id === 'ent-gen-asset')?.external_ref).toBe('s3://acme/reels/promo.mp4');
      expect(d1Ids.has('ent-render-tool')).toBe(false);
      expect(d1Ids.has(trajId)).toBe(false);

      // Depth 2 reaches ent-render-tool, NOT hop 3 trajId
      const d2 = getKnowledgeGraph({ projectId: 'acme/marketing/launch', depth: 2 });
      const d2Ids = new Set(d2.nodes.map((n) => n.id));
      expect(d2Ids.has('ent-render-tool')).toBe(true);
      expect(d2Ids.has(trajId)).toBe(false);

      // Depth 3 (and clamped depth 10 -> 3) reaches trajId (trajectory node type!), NOT hop 4 obs-cogs-1
      const d3 = getKnowledgeGraph({ projectId: 'acme/marketing/launch', depth: 10 });
      const d3Ids = new Set(d3.nodes.map((n) => n.id));
      expect(d3Ids.has(trajId)).toBe(true);
      expect(d3.nodes.find((n) => n.id === trajId)?.type).toBe('trajectory');
      expect(d3Ids.has('obs-cogs-1')).toBe(false);

      // Focal traversal via nodeId starting from a node outside projectId
      const focal = getKnowledgeGraph({
        projectId: 'acme/unrelated',
        nodeId: 'ent-render-tool',
        depth: 1,
      });
      const focalIds = new Set(focal.nodes.map((n) => n.id));
      expect(focalIds).toEqual(new Set(['ent-render-tool', 'ent-gen-asset', trajId]));

      // Focal traversal from trajectory node reaches obs-cogs-1 (observation) at depth 1
      const trajFocal = getKnowledgeGraph({ nodeId: trajId, depth: 1 });
      expect(trajFocal.nodes.find((n) => n.id === 'obs-cogs-1')?.type).toBe('observation');

      // Focal traversal from external edge endpoint resolves cleanly
      linkEntities({
        source_id: genAsset.id,
        target_type: 'external',
        target_id: 'figma://file/promo-frames',
        relation: 'exported_from',
      });
      const extFocal = getKnowledgeGraph({ nodeId: 'figma://file/promo-frames', depth: 1 });
      expect(extFocal.nodes.map((n) => n.id).sort()).toEqual([
        'ent-gen-asset',
        'figma://file/promo-frames',
      ]);

      // Relation filter restricts traversal strictly to matching relation
      const relFiltered = getKnowledgeGraph({
        nodeId: launchNote.id,
        relation: 'references',
        depth: 3,
      });
      expect(relFiltered.nodes.map((n) => n.id).sort()).toEqual(['ent-gen-asset', 'note-mkt-1']);
      expect(relFiltered.edges).toEqual([
        { source: 'note-mkt-1', target: 'ent-gen-asset', type: 'references' },
      ]);
    });

    it('supports hierarchical ancestor inheritance, sibling isolation, children roll-up, and entityType filter', () => {
      upsertEntity({
        id: 'ent-root-brand',
        scope: 'project',
        project_id: 'acme',
        entity_type: 'brand',
        name: 'Acme Brand Guidelines',
      });
      upsertEntity({
        id: 'ent-mid-channel',
        scope: 'project',
        project_id: 'acme/socials',
        entity_type: 'document',
        name: 'Socials Voice',
      });
      upsertEntity({
        id: 'ent-leaf-cal',
        scope: 'project',
        project_id: 'acme/socials/calendar',
        entity_type: 'metric',
        name: 'Weekly Cadence',
      });
      upsertEntity({
        id: 'ent-sib-cogs',
        scope: 'project',
        project_id: 'acme/cogs',
        entity_type: 'metric',
        name: 'Gross Margin',
      });
      upsertEntity({
        id: 'ent-near-prefix',
        scope: 'project',
        project_id: 'acme-other',
        entity_type: 'brand',
        name: 'Acme Other',
      });
      upsertEntity({
        id: 'ent-global',
        scope: 'global',
        entity_type: 'tool',
        name: 'Global Style Checker',
      });
      createNote({
        id: 'note-root',
        scope: 'project',
        projectId: 'acme',
        type: 'fact',
        title: 'Root brand rule',
        content: 'Always use high contrast.',
      });

      // Default includeAncestors=true, includeChildren=false, includeGlobal=false
      const leafGraph = getKnowledgeGraph({ projectId: 'acme/socials/calendar' });
      const leafById = new Map(leafGraph.nodes.map((n) => [n.id, n]));
      expect(Array.from(leafById.keys()).sort()).toEqual([
        'ent-leaf-cal',
        'ent-mid-channel',
        'ent-root-brand',
        'note-root',
      ]);
      expect(leafById.get('ent-leaf-cal')?.match_tier).toBe('exact');
      expect(leafById.get('ent-mid-channel')?.match_tier).toBe('ancestor');
      expect(leafById.get('ent-root-brand')?.match_tier).toBe('ancestor');
      expect(leafById.has('ent-sib-cogs')).toBe(false);
      expect(leafById.has('ent-global')).toBe(false);

      // includeAncestors=false -> exact only
      const exactOnly = getKnowledgeGraph({
        projectId: 'acme/socials/calendar',
        includeAncestors: false,
      });
      expect(exactOnly.nodes.map((n) => n.id)).toEqual(['ent-leaf-cal']);

      // includeChildren=true on 'acme' rolls up all acme/* while excluding acme-other
      const rollup = getKnowledgeGraph({
        projectId: 'acme',
        includeChildren: true,
        includeGlobal: true,
      });
      const rollupById = new Map(rollup.nodes.map((n) => [n.id, n]));
      expect(Array.from(rollupById.keys()).sort()).toEqual([
        'ent-global',
        'ent-leaf-cal',
        'ent-mid-channel',
        'ent-root-brand',
        'ent-sib-cogs',
        'note-root',
      ]);
      expect(rollupById.get('ent-leaf-cal')?.match_tier).toBe('child');
      expect(rollupById.get('ent-sib-cogs')?.match_tier).toBe('child');
      expect(rollupById.get('ent-global')?.match_tier).toBe('global');
      expect(rollupById.has('ent-near-prefix')).toBe(false);

      // listEntities respects hierarchical flags and entityType/externalRef filters
      const metricsRollup = listEntities({
        projectId: 'acme',
        includeChildren: true,
        includeGlobal: false,
        entityType: 'metric',
      });
      expect(metricsRollup.map((e) => e.id).sort()).toEqual(['ent-leaf-cal', 'ent-sib-cogs']);
      expect(metricsRollup.every((e) => e.match_tier === 'child')).toBe(true);

      // entityType filter on getKnowledgeGraph filters entity seeds
      const brandGraph = getKnowledgeGraph({
        projectId: 'acme',
        includeChildren: true,
        entityType: 'brand',
      });
      const entityTypesInGraph = brandGraph.nodes
        .filter((n) => n.type === 'entity')
        .map((n) => n.entity_type);
      expect(entityTypesInGraph).toEqual(['brand']);
    });
  });

  describe('user_id filtering and agent_id non-filtering + HTTP route integration', () => {
    it('filters strictly on user_id when supplied and NEVER filters on agent_id', () => {
      upsertEntity({
        id: 'ent-alice-1',
        scope: 'project',
        project_id: 'acme/socials/calendar',
        entity_type: 'person',
        name: 'Alice Persona',
        user_id: 'alice',
        agent_id: 'agent-codex',
      });
      upsertEntity({
        id: 'ent-alice-2',
        scope: 'project',
        project_id: 'acme/socials/calendar',
        entity_type: 'asset',
        name: 'Alice Template',
        user_id: 'alice',
        agent_id: 'agent-claude',
      });
      upsertEntity({
        id: 'ent-bob-1',
        scope: 'project',
        project_id: 'acme/socials/calendar',
        entity_type: 'person',
        name: 'Bob Persona',
        user_id: 'bob',
        agent_id: 'agent-codex',
      });
      startSession({
        id: 'sess-alice',
        scope: 'project',
        project_id: 'acme/socials/calendar',
        agent_name: 'agent-claude',
      });

      // listEntities filters by user_id across all agent_ids
      const aliceList = listEntities({
        projectId: 'acme/socials/calendar',
        userId: 'alice',
        includeGlobal: false,
      });
      expect(aliceList.map((e) => e.id).sort()).toEqual(['ent-alice-1', 'ent-alice-2']);
      expect(aliceList.map((e) => e.agent_id).sort()).toEqual(['agent-claude', 'agent-codex']);

      // getKnowledgeGraph filters by user_id across all agent_ids
      const aliceGraph = getKnowledgeGraph({
        projectId: 'acme/socials/calendar',
        userId: 'alice',
      });
      expect(aliceGraph.nodes.map((n) => n.id).sort()).toEqual(['ent-alice-1', 'ent-alice-2']);

      // Without user_id, entities from both users and all agent_ids are returned
      const allEntities = listEntities({
        projectId: 'acme/socials/calendar',
        includeGlobal: false,
      });
      expect(allEntities.map((e) => e.id).sort()).toEqual([
        'ent-alice-1',
        'ent-alice-2',
        'ent-bob-1',
      ]);
    });

    it('parses hierarchical, BFS, and user_id query parameters via parseGraphQuery and GET /graph', async () => {
      const parsed = parseGraphQuery({
        project_id: 'acme/marketing',
        include_ancestors: 'false',
        include_children: 'true',
        include_global: 'true',
        depth: '9',
        node_id: 'ent-x',
        entity_type: 'asset',
        relation: 'references',
        user_id: 'alice',
        limit: '25',
      });
      expect(parsed).toEqual({
        projectId: 'acme/marketing',
        scope: undefined,
        includeAncestors: false,
        includeChildren: true,
        includeGlobal: true,
        depth: 3,
        nodeId: 'ent-x',
        entityType: 'asset',
        relation: 'references',
        userId: 'alice',
        limit: 25,
      });

      const defaults = parseGraphQuery({});
      expect(defaults).toEqual({
        projectId: undefined,
        scope: undefined,
        includeAncestors: true,
        includeChildren: false,
        includeGlobal: false,
        depth: 1,
        nodeId: undefined,
        entityType: undefined,
        relation: undefined,
        userId: undefined,
        limit: 80,
      });

      // End-to-end GET /graph smoke check
      process.env.BRAIN_REQUIRE_API_KEY = '1';
      const db = getDb();
      const apiKey = 'test_entity_graph_key';
      db.prepare("INSERT INTO api_keys (id, name, key, created_at) VALUES (?, 'eg-key', ?, datetime('now'))").run(
        randomUUID(),
        apiKey
      );
      verifyOrCreateStoreMeta();
      const app = createApp();

      const ent1 = upsertEntity({
        id: 'ent-http-1',
        scope: 'project',
        project_id: 'acme/marketing/launch',
        entity_type: 'document',
        name: 'Launch Brief',
        user_id: 'alice',
      });
      const ent2 = upsertEntity({
        id: 'ent-http-2',
        scope: 'project',
        project_id: 'acme/socials/generator',
        entity_type: 'asset',
        name: 'Launch Reel',
        external_ref: 's3://acme/launch.mp4',
      });
      linkEntities({ source_id: ent1.id, target_id: ent2.id, relation: 'references' });

      const res = await request(app)
        .get('/graph?project_id=acme&include_children=true&depth=1&user_id=alice')
        .set({ Authorization: `Bearer ${apiKey}` })
        .expect(200);

      const returnedIds = new Set(res.body.nodes.map((n: any) => n.id));
      expect(returnedIds.has('ent-http-1')).toBe(true);
      expect(returnedIds.has('ent-http-2')).toBe(true);
      expect(res.body.edges).toEqual([
        { source: 'ent-http-1', target: 'ent-http-2', type: 'references' },
      ]);
    });
  });
});
