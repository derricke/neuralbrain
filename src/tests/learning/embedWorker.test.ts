import { resetDb } from '../../lib/db';
import { setCustomEmbedder } from '../../learning/embedding';
import { verifyOrCreateStoreMeta } from '../../learning/storeMeta';
import {
  drainEmbedQueue,
  getReembedStatus,
  startReembed,
} from '../../learning/embedWorker';
import { getPendingEmbedCount } from '../../memory/embedQueueStore';
import { createNote } from '../../memory/noteStore';

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
});
