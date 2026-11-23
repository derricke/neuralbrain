import { getDb, resetDb } from '../../lib/db';
import { setCustomEmbedder } from '../../learning/embedding';
import { verifyOrCreateStoreMeta } from '../../learning/storeMeta';
import {
  createQdrantCollectionWithIndexes,
  drainEmbedQueue,
  getReembedStatus,
  startReembed,
} from '../../learning/embedWorker';
import {
  enqueueForEmbedding,
  getPendingEmbedCount,
  markEmbedFailed,
  recoverStaleRunningEmbeds,
} from '../../memory/embedQueueStore';
import { createNote } from '../../memory/noteStore';
import { captureObservations } from '../../memory/observationStore';
import { logTrajectory } from '../../memory/trajectoryStore';

describe('embedWorker single-flight and re-embed yield', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'local';
    process.env.BRAIN_EMBED_MODEL = 'nomic';
    process.env.BRAIN_EMBED_DIM = '512';
    resetDb();
    verifyOrCreateStoreMeta();
  });

  afterEach(() => {
    resetDb();
    setCustomEmbedder(null);
    process.env = { ...originalEnv };
  });

  it('prevents concurrent drainEmbedQueue execution via single-flight lock and releases in finally', async () => {
    createNote({
      scope: 'project',
      projectId: 'test-proj',
      type: 'fact',
      title: 'Note One',
      content: 'First note for single-flight lock test',
    });
    createNote({
      scope: 'project',
      projectId: 'test-proj',
      type: 'fact',
      title: 'Note Two',
      content: 'Second note for single-flight lock test',
    });

    let inFlight = 0;
    let maxInFlight = 0;
    let callCount = 0;

    setCustomEmbedder(async () => {
      callCount++;
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((resolve) => setTimeout(resolve, 60));
      inFlight--;
      return Array.from({ length: 512 }, () => 0.01);
    });

    const [res1, res2, res3] = await Promise.all([
      drainEmbedQueue({ target: 'live', batchSize: 1 }),
      drainEmbedQueue({ target: 'live', batchSize: 1 }),
      drainEmbedQueue({ target: 'live', batchSize: 1 }),
    ]);

    expect(maxInFlight).toBe(1);
    expect(callCount).toBe(1);
    expect(res1).toEqual({ processed: 1, failed: 0, remaining: 1 });
    expect(res2).toEqual({ processed: 0, failed: 0, remaining: 0 });
    expect(res3).toEqual({ processed: 0, failed: 0, remaining: 0 });

    // Lock must be released in finally so the next call processes the remaining item
    const res4 = await drainEmbedQueue({ target: 'live', batchSize: 1 });
    expect(res4).toEqual({ processed: 1, failed: 0, remaining: 0 });
    expect(callCount).toBe(2);
  });

  it('releases single-flight lock in finally even when embedder throws', async () => {
    createNote({
      scope: 'project',
      projectId: 'test-proj',
      type: 'fact',
      title: 'Failing Note',
      content: 'Triggers embedder error',
    });

    setCustomEmbedder(async () => {
      throw new Error('Simulated embedder failure');
    });

    const first = await drainEmbedQueue({ target: 'live', batchSize: 1 });
    expect(first.failed).toBe(1);

    // Subsequent call must still acquire the lock and run
    setCustomEmbedder(async () => Array.from({ length: 512 }, () => 0.02));
    const second = await drainEmbedQueue({ target: 'live', batchSize: 1 });
    expect(second.remaining).toBe(0);
  });

  it('yields/skips live drains while activeReembedStatus.status is running without breaking startReembed', async () => {
    createNote({
      scope: 'project',
      projectId: 'test-proj',
      type: 'fact',
      title: 'Reembed Yield Note',
      content: 'Should not be drained on live target while reembed is running',
    });

    expect(getPendingEmbedCount('live')).toBe(1);

    const mockQdrantClient = {
      getCollections: jest.fn().mockResolvedValue({ collections: [] }),
      createCollection: jest.fn().mockResolvedValue(true),
      createPayloadIndex: jest.fn().mockResolvedValue(true),
      upsert: jest.fn().mockResolvedValue(true),
      updateCollectionAliases: jest.fn().mockResolvedValue(true),
    } as any;

    let liveSkipResult: { processed: number; failed: number; remaining: number } | null = null;
    let checkedDuringReembed = false;

    setCustomEmbedder(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (!checkedDuringReembed && getReembedStatus().status === 'running') {
        checkedDuringReembed = true;
        // Concurrent live drain while reembed is running must yield/skip
        liveSkipResult = await drainEmbedQueue({
          target: 'live',
          batchSize: 10,
          client: mockQdrantClient,
        });
      }
      return Array.from({ length: 512 }, () => 0.03);
    });

    const reembedRes = await startReembed({
      newCollectionName: 'brain_v_test_reembed',
      client: mockQdrantClient,
    });

    expect(checkedDuringReembed).toBe(true);
    expect(liveSkipResult).toEqual({ processed: 0, failed: 0, remaining: 0 });
    expect(reembedRes.processed).toBe(1);
    expect(reembedRes.failed).toBe(0);
    expect(getReembedStatus().status).toBe('completed');

    // Live queue item should still be pending because live drain yielded during reembed
    expect(getPendingEmbedCount('live')).toBe(1);

    // Once reembed is completed, live drain proceeds normally
    const afterRes = await drainEmbedQueue({
      target: 'live',
      batchSize: 10,
      client: mockQdrantClient,
    });
    expect(afterRes).toEqual({ processed: 1, failed: 0, remaining: 0 });
  });

  it('does not markEmbedDone when configured Qdrant upsert fails', async () => {
    createNote({
      scope: 'project',
      projectId: 'test-proj',
      type: 'fact',
      title: 'Qdrant Fail Note',
      content: 'Should stay pending if Qdrant upsert fails',
    });

    setCustomEmbedder(async () => Array.from({ length: 512 }, () => 0.04));

    const failingQdrant = {
      upsert: jest.fn().mockRejectedValue(new Error('Qdrant 500')),
    } as any;

    const res = await drainEmbedQueue({
      target: 'live',
      batchSize: 10,
      client: failingQdrant,
    });

    expect(res.processed).toBe(0);
    expect(res.remaining).toBe(1);
    expect(getPendingEmbedCount('live')).toBe(1);
  });

  it('deletes regular brain collection on reembed alias switch and cleans up on failure', async () => {
    const db = getDb();
    const note = createNote({
      scope: 'project',
      projectId: 'test-proj',
      type: 'fact',
      title: 'Reembed Alias Note',
      content: 'Tests regular collection cleanup and deferred SQLite BLOB update',
    });

    setCustomEmbedder(async () => Array.from({ length: 512 }, () => 0.05));

    const mockQdrant = {
      getCollections: jest.fn().mockResolvedValue({ collections: [{ name: 'brain' }] }),
      createCollection: jest.fn().mockResolvedValue(true),
      deleteCollection: jest.fn().mockResolvedValue(true),
      createPayloadIndex: jest.fn().mockResolvedValue(true),
      upsert: jest.fn().mockResolvedValue(true),
      updateCollectionAliases: jest.fn().mockResolvedValue(true),
    } as any;

    const okRes = await startReembed({
      newCollectionName: 'brain_v_alias_test',
      client: mockQdrant,
    });
    expect(okRes.processed).toBe(1);
    expect(mockQdrant.deleteCollection).toHaveBeenCalledWith('brain');
    expect(mockQdrant.updateCollectionAliases).toHaveBeenCalledWith({
      actions: [
        { create_alias: { collection_name: 'brain_v_alias_test', alias_name: 'brain' } },
      ],
    });
    const noteRow = db.prepare('SELECT embedding FROM notes WHERE id = ?').get(note.id) as { embedding: Buffer | null };
    expect(noteRow.embedding).not.toBeNull();

    // Failure during alias switch cleans up embed_queue for target
    const failingAliasQdrant = {
      getCollections: jest.fn().mockResolvedValue({ collections: [] }),
      createCollection: jest.fn().mockResolvedValue(true),
      createPayloadIndex: jest.fn().mockResolvedValue(true),
      upsert: jest.fn().mockResolvedValue(true),
      updateCollectionAliases: jest.fn().mockRejectedValue(new Error('alias switch failed')),
    } as any;

    await expect(
      startReembed({
        newCollectionName: 'brain_v_fail_cleanup',
        client: failingAliasQdrant,
      })
    ).rejects.toThrow('alias switch failed');

    const leftover = db
      .prepare('SELECT COUNT(*) as c FROM embed_queue WHERE target = ?')
      .get('brain_v_fail_cleanup') as { c: number };
    expect(leftover.c).toBe(0);
  });

  it('recovers stale running embeds and retries transient failures up to MAX_EMBED_ATTEMPTS', () => {
    const db = getDb();
    enqueueForEmbedding('rec_stale_1', 'note', 'live');
    db.prepare(
      `UPDATE embed_queue SET status = 'running', attempts = 1, queued_at = unixepoch() - 600 WHERE record_id = 'rec_stale_1'`
    ).run();

    const recovered = recoverStaleRunningEmbeds('live', 300);
    expect(recovered).toBe(1);
    expect(getPendingEmbedCount('live')).toBe(1);

    // Retry transient failures up to MAX_EMBED_ATTEMPTS (3)
    markEmbedFailed('rec_stale_1', 'note', 'live', 'err 1');
    let row = db.prepare(`SELECT status FROM embed_queue WHERE record_id = 'rec_stale_1'`).get() as { status: string };
    expect(row.status).toBe('pending');

    db.prepare(`UPDATE embed_queue SET attempts = 3 WHERE record_id = 'rec_stale_1'`).run();
    markEmbedFailed('rec_stale_1', 'note', 'live', 'err 3');
    row = db.prepare(`SELECT status FROM embed_queue WHERE record_id = 'rec_stale_1'`).get() as { status: string };
    expect(row.status).toBe('failed');
  });

  it('maps non-UUID record IDs to valid UUIDs for Qdrant and stops retrying upsert failures after MAX_EMBED_ATTEMPTS', async () => {
    const note = createNote({
      scope: 'project',
      projectId: 'test-proj',
      type: 'fact',
      title: 'UUID point mapping',
      content: 'Ensures Qdrant receives UUID point IDs with payload.record_id',
    });

    setCustomEmbedder(async () => Array.from({ length: 512 }, () => 0.02));
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const upsertedPoints: any[] = [];
    const okQdrant = {
      upsert: jest.fn(async (_col: string, body: { points: any[] }) => {
        upsertedPoints.push(...body.points);
        return true;
      }),
    } as any;

    const okRes = await drainEmbedQueue({ target: 'live', batchSize: 10, client: okQdrant });
    expect(okRes.processed).toBe(1);
    expect(upsertedPoints).toHaveLength(1);
    expect(upsertedPoints[0].id).toMatch(uuidRe);
    expect(upsertedPoints[0].payload.record_id).toBe(note.id);

    // Repeated Qdrant upsert failures should stop at failed after MAX_EMBED_ATTEMPTS
    createNote({
      scope: 'project',
      projectId: 'test-proj',
      type: 'fact',
      title: 'Failing upsert note',
      content: 'Should not loop forever on 400 Bad Request',
    });
    const badQdrant = {
      upsert: jest.fn().mockRejectedValue(new Error('Bad Request')),
    } as any;

    for (let i = 0; i < 4; i++) {
      await drainEmbedQueue({ target: 'live', batchSize: 10, client: badQdrant });
    }
    expect(getPendingEmbedCount('live')).toBe(0);
    expect(badQdrant.upsert).toHaveBeenCalledTimes(3);
  });

  it('embeds entity and action records, writes BLOBs, and includes project_ancestors and user_id on all Qdrant payloads', async () => {
    const db = getDb();

    db.prepare(`
      INSERT INTO entities (id, scope, project_id, user_id, agent_id, entity_type, name, description, external_ref, created_at)
      VALUES ('ent_1', 'project', 'acme/socials/calendar', 'user-42', 'agent-1', 'asset', 'Q4 Brand Kit', 'Visual guidelines', 'drive://brand-kit', 1700000100)
    `).run();
    enqueueForEmbedding('ent_1', 'entity', 'live');

    db.prepare(`
      INSERT INTO actions (id, scope, project_id, user_id, agent_id, title, description, status, priority, blocked_reason, created_at)
      VALUES ('act_1', 'project', 'acme/cogs', 'user-7', 'agent-2', 'Publish ledger', 'Monthly cost report', 'blocked', 'high', 'Waiting on finance CSV', '2026-11-22 08:30:00')
    `).run();
    enqueueForEmbedding('act_1', 'action', 'live');

    const note = createNote({
      scope: 'project',
      projectId: 'acme/socials',
      type: 'fact',
      title: 'Socials Note',
      content: 'Scheduling notes',
    });
    db.prepare(`UPDATE notes SET user_id = 'user-99' WHERE id = ?`).run(note.id);

    captureObservations([
      {
        scope: 'project',
        project_id: 'acme/socials/calendar',
        user_id: 'user-obs',
        kind: 'tool_call',
        tool_name: 'read_file',
        input: 'README.md',
      },
    ]);

    const trajId = logTrajectory({
      scope: 'project',
      projectId: 'acme/cogs',
      userId: 'user-traj',
      taskType: 'build',
      description: 'Compile ledger',
      success: true,
    });

    db.prepare(`
      INSERT INTO summaries (id, scope, project_id, user_id, kind, outcome, producer_tier, prompt_version, is_latest, created_at)
      VALUES ('sum_1', 'global', NULL, 'user-sum', 'session', 'success', 'agent', 'v1', 1, 1700000200)
    `).run();
    db.prepare(`
      INSERT INTO summary_claims (id, summary_id, text, ordinal)
      VALUES ('clm_1', 'sum_1', 'Summary claim text', 0)
    `).run();
    enqueueForEmbedding('sum_1', 'summary', 'live');

    setCustomEmbedder(async () => Array.from({ length: 512 }, () => 0.1));

    const upsertedPoints: any[] = [];
    const mockQdrant = {
      upsert: jest.fn(async (_col: string, body: { points: any[] }) => {
        upsertedPoints.push(...body.points);
        return true;
      }),
    } as any;

    const drainRes = await drainEmbedQueue({ target: 'live', batchSize: 50, client: mockQdrant });
    expect(drainRes.failed).toBe(0);
    expect(drainRes.remaining).toBe(0);
    expect(upsertedPoints).toHaveLength(6);

    const byRecordId = new Map(upsertedPoints.map((p) => [p.payload.record_id, p.payload]));

    const entPayload = byRecordId.get('ent_1');
    expect(entPayload).toMatchObject({
      record_type: 'entity',
      scope: 'project',
      project_id: 'acme/socials/calendar',
      project_ancestors: ['acme', 'acme/socials', 'acme/socials/calendar'],
      user_id: 'user-42',
      entity_type: 'asset',
      created_at: 1700000100,
    });
    expect(entPayload.text).toContain('asset\nQ4 Brand Kit\nVisual guidelines\ndrive://brand-kit');

    const actPayload = byRecordId.get('act_1');
    expect(actPayload).toMatchObject({
      record_type: 'action',
      scope: 'project',
      project_id: 'acme/cogs',
      project_ancestors: ['acme', 'acme/cogs'],
      user_id: 'user-7',
      kind: 'blocked',
      type: 'high',
      created_at: Math.floor(Date.parse('2026-11-22T08:30:00Z') / 1000),
    });
    expect(actPayload.text).toContain('Publish ledger\nMonthly cost report\nWaiting on finance CSV');

    expect(byRecordId.get(note.id)).toMatchObject({
      record_type: 'note',
      project_ancestors: ['acme', 'acme/socials'],
      user_id: 'user-99',
    });
    expect(byRecordId.get(trajId)).toMatchObject({
      record_type: 'trajectory',
      project_ancestors: ['acme', 'acme/cogs'],
      user_id: 'user-traj',
    });
    const obsPayload = upsertedPoints.find((p) => p.payload.record_type === 'observation')?.payload;
    expect(obsPayload).toMatchObject({
      project_ancestors: ['acme', 'acme/socials', 'acme/socials/calendar'],
      user_id: 'user-obs',
      event_at: null,
    });
    expect(byRecordId.get('sum_1')).toMatchObject({
      record_type: 'summary',
      project_ancestors: [],
      user_id: 'user-sum',
    });

    const entRow = db.prepare('SELECT embedding FROM entities WHERE id = ?').get('ent_1') as { embedding: Buffer | null };
    expect(entRow.embedding).not.toBeNull();
    const actRow = db.prepare('SELECT embedding FROM actions WHERE id = ?').get('act_1') as { embedding: Buffer | null };
    expect(actRow.embedding).not.toBeNull();
  });

  it('indexes project_ancestors, user_id, and entity_type and includes entities/actions in startReembed', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO entities (id, scope, project_id, entity_type, name)
      VALUES ('ent_reembed', 'project', 'acme/socials', 'brand', 'Acme Brand')
    `).run();
    db.prepare(`
      INSERT INTO actions (id, scope, project_id, title, status, priority)
      VALUES ('act_reembed', 'project', 'acme/socials', 'Review post', 'ready', 'normal')
    `).run();

    setCustomEmbedder(async () => Array.from({ length: 512 }, () => 0.07));

    const indexedFields: string[] = [];
    const upsertedIds: string[] = [];
    const mockQdrant = {
      getCollections: jest.fn().mockResolvedValue({ collections: [] }),
      createCollection: jest.fn().mockResolvedValue(true),
      createPayloadIndex: jest.fn(async (_col: string, opts: { field_name: string }) => {
        indexedFields.push(opts.field_name);
        return true;
      }),
      upsert: jest.fn(async (_col: string, body: { points: any[] }) => {
        for (const p of body.points) upsertedIds.push(p.payload.record_id);
        return true;
      }),
      updateCollectionAliases: jest.fn().mockResolvedValue(true),
    } as any;

    await createQdrantCollectionWithIndexes(mockQdrant, 'brain_idx_check', 512);
    expect(indexedFields).toEqual(
      expect.arrayContaining(['project_ancestors', 'user_id', 'entity_type', 'project_id', 'scope'])
    );

    const reembedRes = await startReembed({
      newCollectionName: 'brain_v_ent_act',
      client: mockQdrant,
    });
    expect(reembedRes.processed).toBe(2);
    expect(reembedRes.failed).toBe(0);
    expect(upsertedIds).toEqual(expect.arrayContaining(['ent_reembed', 'act_reembed']));

    const entBlob = db.prepare('SELECT embedding FROM entities WHERE id = ?').get('ent_reembed') as { embedding: Buffer | null };
    const actBlob = db.prepare('SELECT embedding FROM actions WHERE id = ?').get('act_reembed') as { embedding: Buffer | null };
    expect(entBlob.embedding).not.toBeNull();
    expect(actBlob.embedding).not.toBeNull();
  });

  it('includes event_at in Qdrant payloads for observations and notes while preserving created_at', async () => {
    const note = createNote({
      scope: 'project',
      projectId: 'acme/ops',
      type: 'fact',
      title: 'Release date',
      content: 'Scheduled release window',
      eventAt: '2025-07-01T08:00:00Z',
    });
    const cap = captureObservations([
      {
        scope: 'project',
        project_id: 'acme/ops',
        kind: 'prompt',
        input: 'Run deploy verification',
        event_at: '2025-07-01T08:15:00Z',
        created_at: 1751357700,
      },
    ]);
    expect(cap.accepted).toBe(1);

    setCustomEmbedder(async () => Array.from({ length: 512 }, () => 0.05));

    const upsertedPoints: any[] = [];
    const mockQdrant = {
      upsert: jest.fn(async (_col: string, body: { points: any[] }) => {
        upsertedPoints.push(...body.points);
        return true;
      }),
    } as any;

    const drainRes = await drainEmbedQueue({ target: 'live', batchSize: 10, client: mockQdrant });
    expect(drainRes.failed).toBe(0);
    expect(drainRes.remaining).toBe(0);

    const byRecordId = new Map(upsertedPoints.map((p) => [p.payload.record_id, p.payload]));
    expect(byRecordId.get(note.id)).toMatchObject({
      record_type: 'note',
      event_at: '2025-07-01T08:00:00.000Z',
    });
    expect(typeof byRecordId.get(note.id).created_at).toBe('number');

    expect(byRecordId.get(cap.ids[0])).toMatchObject({
      record_type: 'observation',
      event_at: '2025-07-01T08:15:00.000Z',
      created_at: 1751357700,
    });
  });
});
