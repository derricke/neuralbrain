import fs from 'fs';
import os from 'os';
import path from 'path';
import { resetDb } from '../../lib/db';
import { EmbeddingConfigurationError, setCustomEmbedder } from '../../learning/embedding';
import { drainEmbedQueue } from '../../learning/embedWorker';
import { getPendingEmbedCount } from '../../memory/embedQueueStore';
import { createNote } from '../../memory/noteStore';
import { getDb } from '../../lib/db';
import { ensureLocalEmbedder, hostNeedsLocalEmbedder } from '../../cli';

/**
 * @huggingface/transformers is optional: npm drops it during `npm install -g`
 * on Linux x64 (onnxruntime-node@1.20.1's install script 404s on a CUDA 11
 * download). These tests pin down the three behaviours that make that safe.
 */
describe('optional local embedder', () => {
  describe('hostNeedsLocalEmbedder: only host modes with BRAIN_EMBED=local', () => {
    test.each([
      ['docker', { BRAIN_EMBED: 'local' }, false],
      ['qdrant-docker', { BRAIN_EMBED: 'local' }, true],
      ['qdrant-docker', {}, true], // BRAIN_EMBED defaults to local
      ['qdrant-docker', { BRAIN_EMBED: 'local-gpu' }, false],
      ['local-only', { BRAIN_EMBED: 'none' }, false],
      ['local-only', { BRAIN_EMBED: 'LOCAL ' }, true],
      ['local-only', { BRAIN_EMBED: 'remote' }, false],
      ['local-only', { BRAIN_EMBED: 'vendor' }, false],
    ] as const)('%s %j -> %s', (mode, env, expected) => {
      expect(hostNeedsLocalEmbedder(mode, env as Record<string, string>)).toBe(expected);
    });
  });

  describe('ensureLocalEmbedder', () => {
    let root: string;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-embedder-'));
      fs.writeFileSync(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'neuralbrain', optionalDependencies: { '@huggingface/transformers': '3.3.3' } })
      );
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    test('does nothing when it is already installed', () => {
      const run = jest.fn();
      expect(ensureLocalEmbedder(root, run as any, () => true)).toEqual({ ok: true, installed: false });
      expect(run).not.toHaveBeenCalled();
    });

    test('installs the pinned version in the package folder with the CUDA download skipped', () => {
      let installed = false;
      const run = jest.fn(() => {
        installed = true;
        return { status: 0 };
      });
      const res = ensureLocalEmbedder(root, run as any, () => installed);

      expect(res).toEqual({ ok: true, installed: true });
      const [cmd, args, opts] = run.mock.calls[0] as unknown as [string, string[], any];
      expect(cmd).toBe('npm');
      expect(args).toEqual(['install', '@huggingface/transformers@3.3.3', '--no-save', '--no-audit', '--no-fund']);
      expect(opts.cwd).toBe(root);
      expect(opts.env.ONNXRUNTIME_NODE_INSTALL_CUDA).toBe('skip');
    });

    test('reports failure without throwing', () => {
      const failing = jest.fn(() => ({ status: 1 }));
      expect(ensureLocalEmbedder(root, failing as any, () => false)).toMatchObject({ ok: false, installed: false });

      const noEffect = jest.fn(() => ({ status: 0 }));
      expect(ensureLocalEmbedder(root, noEffect as any, () => false)).toMatchObject({
        ok: false,
        error: expect.stringContaining('still not resolvable'),
      });
    });
  });

  describe('embed queue when the embedder is unavailable', () => {
    const originalEnv = { ...process.env };
    beforeEach(() => {
      process.env = { ...originalEnv, DATABASE_URL: ':memory:', BRAIN_EMBED: 'local', BRAIN_EMBED_MODEL: 'nomic', BRAIN_EMBED_DIM: '512' };
      resetDb();
    });
    afterEach(() => {
      setCustomEmbedder(null);
      resetDb();
      process.env = { ...originalEnv };
    });

    test('records stay pending (never failed) and are embedded once the embedder is back', async () => {
      for (let i = 0; i < 3; i++) {
        createNote({ scope: 'project', projectId: 'p', type: 'fact', title: `N${i}`, content: `note ${i}` });
      }
      expect(getPendingEmbedCount('live')).toBe(3);

      setCustomEmbedder(async () => {
        throw new EmbeddingConfigurationError('local embedder not installed');
      });
      const blocked = await drainEmbedQueue({ target: 'live', batchSize: 2 });
      expect(blocked.processed).toBe(0);
      expect(blocked.failed).toBe(0);
      expect(getPendingEmbedCount('live')).toBe(3);
      const statuses = getDb().prepare("SELECT status FROM embed_queue WHERE target = 'live'").all() as Array<{ status: string }>;
      expect(statuses.map((r) => r.status)).toEqual(['pending', 'pending', 'pending']);

      setCustomEmbedder(async () => Array.from({ length: 512 }, () => 0.01));
      const recovered = await drainEmbedQueue({ target: 'live', batchSize: 10 });
      expect(recovered.processed).toBe(3);
      expect(getPendingEmbedCount('live')).toBe(0);
    });

    test('an ordinary embedding error still marks only that record failed', async () => {
      createNote({ scope: 'project', projectId: 'p', type: 'fact', title: 'bad', content: 'bad note' });
      setCustomEmbedder(async () => {
        throw new Error('model returned garbage');
      });
      const res = await drainEmbedQueue({ target: 'live', batchSize: 5 });
      expect(res.failed).toBe(1);
    });
  });

  test('without the package, the local embedder fails with a clear configuration error (not a crash)', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.doMock('@huggingface/transformers', () => {
        throw new Error("Cannot find module '@huggingface/transformers'");
      });
      process.env.BRAIN_EMBED = 'local';
      const embedding = await import('../../learning/embedding');
      embedding.setCustomEmbedder(null);
      embedding.resetLocalPipeline();
      await expect(embedding.embedDocument('hello')).rejects.toThrow(embedding.LOCAL_EMBEDDER_MISSING_MESSAGE);
      jest.dontMock('@huggingface/transformers');
    });
  });
});
