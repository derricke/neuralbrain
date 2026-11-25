import { loadBrainEnv } from './lib/brainHome';
loadBrainEnv();

import fs from 'fs';
import https from 'https';
import { app } from './app';
import { initDb, resetDb } from './lib/db';
import { logger } from './lib/logger';
import { ensureLocalTlsCerts } from './lib/tls';
import { getAppVersion } from './lib/version';
import { verifyOrCreateStoreMeta } from './learning/storeMeta';
import { drainEmbedQueue, ensureInitialEmbeddingsSync } from './learning/embedWorker';
import { probeReasoningTokens } from './consolidation/fixtures';
import { sweepIdleSessions } from './memory/rollupSweeper';
import { ensureBootstrapApiKey } from './middleware/auth';

const PORT = parseInt(process.env.PORT || '3737', 10);
const HOST = process.env.HOST || '127.0.0.1';

async function startServer() {
  try {
    initDb();
    logger.info('database initialized');

    // Auto-bootstrap API key (Single-Writer compliant, supports BRAIN_API_KEY and data/api-key.txt)
    ensureBootstrapApiKey();

    const verification = verifyOrCreateStoreMeta();
    if (!verification.match) {
      logger.warn({ reason: verification.mismatchReason }, 'starting with degraded vector search');
    }

    // Auto-sync initial embeddings if Qdrant collection is clean/empty but notes exist in SQLite
    if (process.env.NODE_ENV !== 'test') {
      ensureInitialEmbeddingsSync().catch((err) => {
        logger.warn({ error: err }, 'startup initial embeddings sync failed');
      });
    }

    if (process.env.BRAIN_CHAT_PROBE !== '0') {
      probeReasoningTokens().catch((err) => {
        logger.warn({ error: err }, 'startup reasoning tokens probe failed');
      });
    }

    // Background embed worker loop (chained setTimeout so a new cycle never starts until the previous finishes)
    let workerTimer: NodeJS.Timeout | null = null;
    let isShuttingDown = false;
    if (process.env.BRAIN_DISABLE_WORKER !== '1') {
      const intervalMs = parseInt(process.env.BRAIN_WORKER_INTERVAL_MS || '5000', 10);
      const scheduleNextWorkerTick = () => {
        if (isShuttingDown) return;
        workerTimer = setTimeout(async () => {
          try {
            await drainEmbedQueue({ batchSize: 8 });
          } catch (err) {
            logger.error({ error: err instanceof Error ? err.message : String(err) }, 'background embed worker error');
          } finally {
            scheduleNextWorkerTick();
          }
        }, intervalMs);
        workerTimer.unref();
      };
      scheduleNextWorkerTick();
      logger.info({ intervalMs }, 'background embed queue worker started');
    }

    // Idle rollup sweeper. The safety net behind the explicit rollup path: a
    // client that is killed mid-task never posts its observation ids, and
    // without this its observations are never rolled up at all. Arithmetic
    // only (rule 1) and idempotent, so a missed tick costs nothing.
    let sweepInterval: NodeJS.Timeout | null = null;
    if (process.env.BRAIN_DISABLE_ROLLUP_SWEEP !== '1') {
      const sweepIntervalMs = parseInt(
        process.env.BRAIN_ROLLUP_SWEEP_INTERVAL_MS || '300000',
        10
      );
      sweepInterval = setInterval(() => {
        try {
          sweepIdleSessions();
        } catch (err) {
          logger.error(
            { error: err instanceof Error ? err.message : String(err) },
            'idle rollup sweep error'
          );
        }
      }, sweepIntervalMs);
      sweepInterval.unref();
      logger.info({ intervalMs: sweepIntervalMs }, 'idle rollup sweeper started');
    }

    const useHttps =
      process.env.BRAIN_HTTPS === '1' ||
      process.env.BRAIN_HTTPS === 'true' ||
      Boolean(process.env.BRAIN_TLS_CERT && process.env.BRAIN_TLS_KEY);

    const server = useHttps
      ? (() => {
          const { certPath, keyPath, generated } = ensureLocalTlsCerts();
          const key = fs.readFileSync(keyPath);
          const cert = fs.readFileSync(certPath);
          return https.createServer({ key, cert }, app).listen(PORT, HOST, () => {
            logger.info(
              { version: getAppVersion(), port: PORT, host: HOST, protocol: 'https', certPath, generated },
              'neuralbrain service listening'
            );
          });
        })()
      : app.listen(PORT, HOST, () => {
          logger.info(
            { version: getAppVersion(), port: PORT, host: HOST, protocol: 'http' },
            'neuralbrain service listening'
          );
        });

    const shutdown = () => {
      logger.info('shutting down neuralbrain...');
      isShuttingDown = true;
      if (workerTimer) clearTimeout(workerTimer);
      if (sweepInterval) clearInterval(sweepInterval);
      server.close(() => {
        resetDb();
        logger.info('neuralbrain shutdown complete');
        process.exit(0);
      });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    logger.fatal({ error: err instanceof Error ? err.message : String(err) }, 'fatal server startup error');
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

export { startServer };
