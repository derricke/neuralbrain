import { getDb, resetDb } from '../../lib/db';
import {
  matryoshkaTruncate,
  resolveEmbedderRecipe,
  serializeEmbedding,
  deserializeEmbedding,
  setCustomEmbedder,
  queryRemoteModelId,
  boundLocalEmbedText,
  MAX_LOCAL_EMBED_CHARS,
  resolveLocalGpuEndpoint,
} from '../../learning/embedding';
import {
  verifyOrCreateStoreMeta,
  getStoreMeta,
  commitStoreMeta,
} from '../../learning/storeMeta';
import {
  drainEmbedQueue,
  getReembedStatus,
  startReembed,
  deleteQdrantPoints,
} from '../../learning/embedWorker';
import { enqueueForEmbedding, getPendingEmbedCount } from '../../memory/embedQueueStore';
import { createNote } from '../../memory/noteStore';
import { logTrajectory } from '../../memory/trajectoryStore';

describe('storeMetaAndEmbed', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    resetDb();
  });

  afterEach(() => {
    resetDb();
    setCustomEmbedder(null);
    process.env = { ...originalEnv };
  });

  describe('Matryoshka truncation', () => {
    it('applies layer-norm -> slice -> L2-normalize correctly', () => {
      // 768-dim input vector with arbitrary non-zero values
      const rawVec = Array.from({ length: 768 }, (_, i) => Math.sin(i + 1) * 2 + 0.5);

      const truncated512 = matryoshkaTruncate(rawVec, 512);
      expect(truncated512.length).toBe(512);

      // Verify L2 norm is 1.0 (within floating point precision)
      const l2Norm512 = Math.sqrt(truncated512.reduce((acc, v) => acc + v * v, 0));
      expect(l2Norm512).toBeCloseTo(1.0, 5);

      const truncated256 = matryoshkaTruncate(rawVec, 256);
      expect(truncated256.length).toBe(256);
      const l2Norm256 = Math.sqrt(truncated256.reduce((acc, v) => acc + v * v, 0));
      expect(l2Norm256).toBeCloseTo(1.0, 5);
    });

    it('handles edge cases (empty vector, zero target dim)', () => {
      expect(matryoshkaTruncate([], 512)).toEqual([]);
      expect(matryoshkaTruncate([1, 2, 3], 0)).toEqual([]);
    });

    it('round-trips serializeEmbedding and deserializeEmbedding', () => {
      const vec = [0.123, -0.456, 0.789, 1.0];
      const buf = serializeEmbedding(vec);
      const restored = deserializeEmbedding(buf);
      expect(restored.length).toBe(vec.length);
      for (let i = 0; i < vec.length; i++) {
        expect(restored[i]).toBeCloseTo(vec[i], 5);
      }
    });
  });

  describe('store_meta pinning and mismatch detection', () => {
    it('pins the resolved recipe in store_meta on first use', () => {
      process.env.BRAIN_EMBED = 'local';
      process.env.BRAIN_EMBED_MODEL = 'nomic';
      process.env.BRAIN_EMBED_DIM = '512';

      const res = verifyOrCreateStoreMeta();
      expect(res.match).toBe(true);
      expect(res.meta.embed_tier).toBe('local');
      expect(res.meta.embed_model_id).toBe('nomic-ai/nomic-embed-text-v1.5');
      expect(res.meta.embed_dim).toBe(512);
      expect(res.meta.doc_prefix).toBe('search_document: ');
      expect(res.meta.query_prefix).toBe('search_query: ');

      // Check DB directly
      const row = getStoreMeta();
      expect(row).toBeDefined();
      expect(row?.embed_model_id).toBe('nomic-ai/nomic-embed-text-v1.5');
      expect(row?.embed_dim).toBe(512);
    });

    it('loudly detects mismatch without mutating process.env', () => {
      // 1. Pin as nomic 512
      process.env.BRAIN_EMBED = 'local';
      process.env.BRAIN_EMBED_MODEL = 'nomic';
      process.env.BRAIN_EMBED_DIM = '512';
      verifyOrCreateStoreMeta();

      // 2. Change configuration to minilm 384
      process.env.BRAIN_EMBED = 'local';
      process.env.BRAIN_EMBED_MODEL = 'minilm';
      delete process.env.BRAIN_EMBED_DIM;

      const envBefore = { ...process.env };
      const checkRes = verifyOrCreateStoreMeta();

      // Verify loud mismatch
      expect(checkRes.match).toBe(false);
      expect(checkRes.mismatchReason).toContain('vector search unavailable');
      expect(checkRes.mismatchReason).toContain('store_meta expects embed_model_id=nomic-ai/nomic-embed-text-v1.5');
      expect(checkRes.mismatchReason).toContain('config resolved embed_model_id=Xenova/all-MiniLM-L6-v2');
      expect(checkRes.mismatchReason).toContain('Run POST /maintenance/reembed');

      // Crucial requirement: DO NOT mutate process.env!
      expect(process.env.BRAIN_DISABLE_QDRANT).toBeUndefined();
      expect(process.env.LEARNING_DISABLE_QDRANT).toBeUndefined();
      expect(process.env).toEqual(envBefore);
    });

    it('operates cleanly in BRAIN_EMBED=none mode', () => {
      process.env.BRAIN_EMBED = 'none';
      const recipe = resolveEmbedderRecipe();
      expect(recipe.embed_tier).toBe('none');
      expect(recipe.embed_dim).toBe(0);

      const res = verifyOrCreateStoreMeta();
      expect(res.match).toBe(true);
    });
  });

  describe('embed_queue draining worker', () => {
    it('drains queued items and saves embedding blob to SQLite', async () => {
      process.env.BRAIN_EMBED = 'local';
      process.env.BRAIN_EMBED_MODEL = 'nomic';
      process.env.BRAIN_EMBED_DIM = '512';

      verifyOrCreateStoreMeta();

      // Mock embedder to avoid downloading huge ONNX model in test
      setCustomEmbedder(async () => {
        return Array.from({ length: 512 }, () => 0.05);
      });

      // Create a note (which automatically enqueues to embed_queue)
      const note = createNote({
        scope: 'project',
        projectId: 'test-proj',
        type: 'fact',
        title: 'Worker Test Note',
        content: 'This note should be embedded by the worker',
      });

      // Create a trajectory
      const trajId = logTrajectory({
        scope: 'project',
        projectId: 'test-proj',
        description: 'Test trajectory for embed worker',
        success: true,
      });

      expect(getPendingEmbedCount('live')).toBeGreaterThanOrEqual(2);

      const drainResult = await drainEmbedQueue({ target: 'live', batchSize: 10 });
      expect(drainResult.processed).toBeGreaterThanOrEqual(2);
      expect(drainResult.failed).toBe(0);
      expect(drainResult.remaining).toBe(0);

      // Verify embedding blob was written to SQLite
      const db = getDb();
      const updatedNote = db.prepare('SELECT embedding FROM notes WHERE id = ?').get(note.id) as { embedding: Buffer };
      expect(updatedNote.embedding).not.toBeNull();
      const noteVec = deserializeEmbedding(updatedNote.embedding);
      expect(noteVec.length).toBe(512);

      const updatedTraj = db.prepare('SELECT embedding FROM trajectories WHERE id = ?').get(trajId) as { embedding: Buffer };
      expect(updatedTraj.embedding).not.toBeNull();
      const trajVec = deserializeEmbedding(updatedTraj.embedding);
      expect(trajVec.length).toBe(512);
    });

    it('handles worker error gracefully without throwing or crashing', async () => {
      // Mock embedder to throw
      setCustomEmbedder(async () => {
        throw new Error('Simulated embedder outage');
      });

      const db = getDb();
      enqueueForEmbedding('non-existent-rec', 'note', 'live');

      const drainResult = await drainEmbedQueue({ target: 'live', batchSize: 10 });
      // Should mark done for non-existent record without crashing
      expect(drainResult.processed).toBe(1);
    });
  });

  describe('deleteQdrantPoints (Q25)', () => {
    it('does nothing when ids array is empty', async () => {
      const mockClient = { delete: jest.fn() };
      await deleteQdrantPoints([], mockClient as any);
      expect(mockClient.delete).not.toHaveBeenCalled();
    });

    it('skips Qdrant deletion when BRAIN_EMBED is none', async () => {
      process.env.BRAIN_EMBED = 'none';
      const mockClient = { delete: jest.fn() };
      await deleteQdrantPoints(['point-1', 'point-2'], mockClient as any);
      expect(mockClient.delete).not.toHaveBeenCalled();
    });

    it('invokes Qdrant delete with point ids when embed tier is active', async () => {
      process.env.BRAIN_EMBED = 'local';
      verifyOrCreateStoreMeta();
      const mockClient = { delete: jest.fn().mockResolvedValue({}) };
      await deleteQdrantPoints(['p-1', 'p-2'], mockClient as any);
      expect(mockClient.delete).toHaveBeenCalledWith('brain', {
        points: ['p-1', 'p-2'],
      });
    });

    it('catches and ignores Qdrant deletion errors safely', async () => {
      process.env.BRAIN_EMBED = 'local';
      verifyOrCreateStoreMeta();
      const mockClient = {
        delete: jest.fn().mockRejectedValue(new Error('Qdrant unreachable')),
      };
      // Must not throw
      await expect(deleteQdrantPoints(['p-1'], mockClient as any)).resolves.toBeUndefined();
    });
  });

  describe('queryRemoteModelId (BRAIN_EMBED_ENDPOINT override)', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('prefers BRAIN_EMBED_ENDPOINT and BRAIN_EMBED_API_KEY over BRAIN_ENDPOINT', async () => {
      process.env.BRAIN_ENDPOINT = 'http://chat.lan:8000/v1';
      process.env.BRAIN_ENDPOINT_API_KEY = 'chat-key';
      process.env.BRAIN_EMBED_ENDPOINT = 'http://embed.lan:11434/v1';
      process.env.BRAIN_EMBED_API_KEY = 'embed-key';

      let calledUrl = '';
      global.fetch = jest.fn().mockImplementation(async (url: any) => {
        calledUrl = url.toString();
        return new Response(JSON.stringify({ data: [{ id: 'nomic-remote-v1' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as any;

      const modelId = await queryRemoteModelId();
      expect(modelId).toBe('nomic-remote-v1');
      expect(calledUrl).toBe('http://embed.lan:11434/v1/models');
    });

    it('falls back to BRAIN_ENDPOINT if BRAIN_EMBED_ENDPOINT is not set', async () => {
      delete process.env.BRAIN_EMBED_ENDPOINT;
      process.env.BRAIN_ENDPOINT = 'http://chat.lan:8000/v1';

      let calledUrl = '';
      global.fetch = jest.fn().mockImplementation(async (url: any) => {
        calledUrl = url.toString();
        return new Response(JSON.stringify({ data: [{ id: 'chat-remote-v1' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as any;

      const modelId = await queryRemoteModelId();
      expect(modelId).toBe('chat-remote-v1');
      expect(calledUrl).toBe('http://chat.lan:8000/v1/models');
    });
  });

  it('bounds local embedding input to ~2k tokens so long observations cannot OOM the ONNX model', () => {
    expect(MAX_LOCAL_EMBED_CHARS).toBeLessThanOrEqual(8000);
    const long = 'x'.repeat(40000);
    expect(boundLocalEmbedText(long)).toHaveLength(MAX_LOCAL_EMBED_CHARS);
    expect(boundLocalEmbedText('short text')).toBe('short text');
  });

  describe('local-gpu embedder tier', () => {
    it('resolves nomic 512d recipe and pins embed_tier=local-gpu in store_meta', () => {
      process.env.BRAIN_EMBED = 'local-gpu';
      process.env.BRAIN_EMBED_MODEL = 'nomic';
      process.env.BRAIN_EMBED_DIM = '512';

      const recipe = resolveEmbedderRecipe();
      expect(recipe.embed_tier).toBe('local-gpu');
      expect(recipe.embed_model_id).toBe('nomic-ai/nomic-embed-text-v1.5');
      expect(recipe.embed_dim).toBe(512);
      expect(recipe.doc_prefix).toBe('search_document: ');
      expect(recipe.query_prefix).toBe('search_query: ');

      const res = verifyOrCreateStoreMeta();
      expect(res.match).toBe(true);
      expect(res.meta.embed_tier).toBe('local-gpu');
    });

    it('detects tier mismatch when switching between local and local-gpu', () => {
      process.env.BRAIN_EMBED = 'local';
      process.env.BRAIN_EMBED_MODEL = 'nomic';
      process.env.BRAIN_EMBED_DIM = '512';
      verifyOrCreateStoreMeta();

      process.env.BRAIN_EMBED = 'local-gpu';
      const checkRes = verifyOrCreateStoreMeta();
      expect(checkRes.match).toBe(false);
      expect(checkRes.mismatchReason).toContain('Run POST /maintenance/reembed');
    });

    it('resolves local-gpu endpoint from BRAIN_GPU_ENDPOINT, BRAIN_EMBED_ENDPOINT, or BRAIN_GPU_PORT', () => {
      delete process.env.BRAIN_GPU_ENDPOINT;
      delete process.env.BRAIN_EMBED_ENDPOINT;
      delete process.env.BRAIN_GPU_PORT;
      expect(resolveLocalGpuEndpoint()).toBe('http://127.0.0.1:7997');

      process.env.BRAIN_GPU_PORT = '8999';
      expect(resolveLocalGpuEndpoint()).toBe('http://127.0.0.1:8999');

      process.env.BRAIN_EMBED_ENDPOINT = 'http://localhost:8111/';
      expect(resolveLocalGpuEndpoint()).toBe('http://localhost:8111');

      process.env.BRAIN_GPU_ENDPOINT = 'http://embedder-gpu:7997/';
      expect(resolveLocalGpuEndpoint()).toBe('http://embedder-gpu:7997');
    });
  });
});
