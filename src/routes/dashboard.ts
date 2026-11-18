import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { getSpoolStats } from '../lib/spool';
import { verifyOrCreateStoreMeta } from '../learning/storeMeta';
import { getPendingEmbedCount } from '../memory/embedQueueStore';
import { drainEmbedQueue, getReembedStatus, probeQdrant } from '../learning/embedWorker';
import { listNotes } from '../memory/noteStore';
import { listTrajectories } from '../memory/trajectoryStore';
import { listObservations } from '../memory/observationStore';
import { getKnowledgeGraph, parseGraphQuery } from '../memory/graphStore';
import { migrateAgentMemoryNotes } from '../scripts/migrateAgentMemory';
import {
  hasActiveApiKeys,
  parseDashboardSessionCookie,
  setDashboardSessionCookie,
  clearDashboardSessionCookie,
  hashApiKey,
} from '../middleware/auth';
import { getDashboardHtml } from '../dashboard/html';
import { dashboardCss } from '../dashboard/styles';
import { dashboardJs } from '../dashboard/clientScript';

export const dashboardRouter = Router();

// In-memory idempotency key deduplication cache (prevents double-submit on retried mutations)
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 500;
const idempotencyCache = new Map<string, { status: number; body: unknown; expiresAt: number }>();

function checkIdempotencyKey(req: Request, res: Response, next: NextFunction) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || req.path === '/api/session') {
    return next();
  }

  const rawKey = req.headers['idempotency-key'];
  const idempotencyKey = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!idempotencyKey) {
    return next();
  }

  const now = Date.now();
  const cacheKey = `${req.method}:${req.path}:${idempotencyKey}`;
  const cached = idempotencyCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    res.setHeader('X-Idempotency-Replayed', 'true');
    return res.status(cached.status).json(cached.body);
  }
  if (cached) {
    idempotencyCache.delete(cacheKey);
  }

  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (idempotencyCache.size >= IDEMPOTENCY_MAX_ENTRIES) {
      const oldestKey = idempotencyCache.keys().next().value;
      if (oldestKey) idempotencyCache.delete(oldestKey);
    }
    idempotencyCache.set(cacheKey, {
      status: res.statusCode || 200,
      body,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
    });
    return originalJson(body);
  }) as Response['json'];

  next();
}

// Strict Security Headers Middleware for all /dashboard endpoints
dashboardRouter.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none';"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
dashboardRouter.use(checkIdempotencyKey);

// ---------------------------------------------------------------------------
// HTML & Static Assets (Served directly from compiled TypeScript modules)
// ---------------------------------------------------------------------------
dashboardRouter.get('/', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getDashboardHtml());
});

dashboardRouter.get('/styles.css', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.send(dashboardCss);
});

dashboardRouter.get('/app.js', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.send(dashboardJs);
});

// ---------------------------------------------------------------------------
// Operator BFF API Endpoints
// ---------------------------------------------------------------------------

// GET /dashboard/api/auth-status: Public lightweight status for dashboard bootstrapping
dashboardRouter.get('/api/auth-status', (req: Request, res: Response) => {
  const session = parseDashboardSessionCookie(req.headers.cookie);
  res.json({
    bootstrap_required: !hasActiveApiKeys(),
    auth_required: process.env.BRAIN_REQUIRE_API_KEY !== '0',
    authenticated: Boolean(session),
    session_key_name: session?.apiKeyName,
  });
});

// POST /dashboard/api/session: Authenticate dashboard window via API key and set HttpOnly session cookie
dashboardRouter.post('/api/session', (req: Request, res: Response) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const rawKey = typeof body.key === 'string' ? body.key.trim() : '';
  if (!rawKey) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'API key is required' } });
    return;
  }

  const hashedKey = hashApiKey(rawKey);
  const db = getDb();
  const keyRecord = db
    .prepare(
      `SELECT id, name, key FROM api_keys 
       WHERE (key = ? OR key = ?) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))`
    )
    .get(hashedKey, rawKey) as { id: string; name: string; key: string } | undefined;

  if (!keyRecord) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired API key' } });
    return;
  }

  setDashboardSessionCookie(res, keyRecord.id, keyRecord.name, req.secure, keyRecord.key);
  res.json({ ok: true, name: keyRecord.name, authenticated: true });
});

// DELETE /dashboard/api/session: Log out and clear HttpOnly session cookie
dashboardRouter.delete('/api/session', (_req: Request, res: Response) => {
  clearDashboardSessionCookie(res);
  res.json({ ok: true, authenticated: false });
});

// GET /dashboard/api/stats: Single fast query batch returning comprehensive telemetry
dashboardRouter.get('/api/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const db = getDb();

    // 1. Health & Store Meta
    let dbStatus = 'ok';
    try {
      db.prepare('SELECT 1').get();
    } catch {
      dbStatus = 'unavailable';
    }

    const qdrantStatus = await probeQdrant();

    const verification = verifyOrCreateStoreMeta();
    const pendingEmbedCount = getPendingEmbedCount('live');

    let eqStats = { pending: 0, running: 0, done: 0, failed: 0 };
    try {
      const row = db
        .prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
            COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) as running,
            COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) as done,
            COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed
          FROM embed_queue WHERE target = 'live'
        `)
        .get() as any;
      if (row) {
        eqStats = {
          pending: row.pending ?? 0,
          running: row.running ?? 0,
          done: row.done ?? 0,
          failed: row.failed ?? 0,
        };
      }
    } catch (e) {
      logger.warn({ error: e }, 'failed to query embed_queue stats');
    }

    const health = {
      status: dbStatus === 'ok' && verification.match ? 'ok' : 'degraded',
      db: dbStatus,
      qdrant: qdrantStatus,
      embed_queue_pending: pendingEmbedCount,
      embed_queue_stats: eqStats,
      reembed_status: getReembedStatus(),
      store_meta: {
        match: verification.match,
        embed_tier: verification.recipe.embed_tier,
        embed_model: verification.recipe.embed_model,
        embed_model_id: verification.recipe.embed_model_id,
        embed_dim: verification.recipe.embed_dim,
        mismatch_reason: verification.mismatchReason || null,
      },
    };

    // 2. Counts
    // Notes counts
    const notesCounts = db
      .prepare(`
        SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN scope = 'project' THEN 1 ELSE 0 END), 0) as project,
          COALESCE(SUM(CASE WHEN scope = 'global' THEN 1 ELSE 0 END), 0) as global,
          COALESCE(SUM(CASE WHEN scope = 'unknown' THEN 1 ELSE 0 END), 0) as unknown
        FROM notes
      `)
      .get() as any;

    // Trajectories counts
    const trajLive = db
      .prepare(`
        SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) as success,
          COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) as failed,
          COALESCE(SUM(CASE WHEN success IS NULL THEN 1 ELSE 0 END), 0) as unknown
        FROM trajectories
      `)
      .get() as any;

    let trajArchived = 0;
    try {
      const row = db.prepare('SELECT COUNT(*) as count FROM trajectory_archive').get() as any;
      trajArchived = row?.count ?? 0;
    } catch {
      trajArchived = 0;
    }

    // Observations counts
    const obsLive = db
      .prepare(`
        SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN failed = 1 THEN 1 ELSE 0 END), 0) as failed
        FROM observations
      `)
      .get() as any;

    let obsArchived = 0;
    try {
      const row = db.prepare('SELECT COUNT(*) as count FROM observations_archive').get() as any;
      obsArchived = row?.count ?? 0;
    } catch {
      obsArchived = 0;
    }

    // Summaries counts
    const sumCounts = db
      .prepare(`
        SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END), 0) as verified,
          COALESCE(SUM(CASE WHEN sources_expired = 1 THEN 1 ELSE 0 END), 0) as sources_expired
        FROM summaries
      `)
      .get() as any;

    // Failure patterns count
    const fpRow = db.prepare('SELECT COUNT(*) as count FROM failure_patterns').get() as any;
    const fpTotal = fpRow?.count ?? 0;

    // Dead letters count
    const dlRow = db.prepare('SELECT COUNT(*) as count FROM dead_letters').get() as any;
    const dlTotal = dlRow?.count ?? 0;

    const counts = {
      notes: {
        total: notesCounts?.total ?? 0,
        project: notesCounts?.project ?? 0,
        global: notesCounts?.global ?? 0,
        unknown: notesCounts?.unknown ?? 0,
      },
      trajectories: {
        total: trajLive?.total ?? 0,
        success: trajLive?.success ?? 0,
        failed: trajLive?.failed ?? 0,
        unknown: trajLive?.unknown ?? 0,
        archived: trajArchived,
      },
      observations: {
        total: obsLive?.total ?? 0,
        failed: obsLive?.failed ?? 0,
        archived: obsArchived,
      },
      summaries: {
        total: sumCounts?.total ?? 0,
        verified: sumCounts?.verified ?? 0,
        sources_expired: sumCounts?.sources_expired ?? 0,
      },
      failure_patterns: fpTotal,
      dead_letters: dlTotal,
    };

    // 3. Projects Breakdown
    const projects = db
      .prepare(`
        SELECT
          project_id,
          COALESCE(SUM(CASE WHEN source = 'note' THEN 1 ELSE 0 END), 0) as notes_count,
          COALESCE(SUM(CASE WHEN source = 'trajectory' THEN 1 ELSE 0 END), 0) as trajectories_count,
          COALESCE(SUM(CASE WHEN source = 'observation' THEN 1 ELSE 0 END), 0) as observations_count
        FROM (
          SELECT project_id, 'note' as source FROM notes WHERE project_id IS NOT NULL
          UNION ALL
          SELECT project_id, 'trajectory' as source FROM trajectories WHERE project_id IS NOT NULL
          UNION ALL
          SELECT project_id, 'observation' as source FROM observations WHERE project_id IS NOT NULL
        )
        GROUP BY project_id
        ORDER BY (notes_count + trajectories_count + observations_count) DESC
      `)
      .all() as any[];

    // 4. Type Distribution
    const typeDistribution = db
      .prepare(`
        SELECT type, COUNT(*) as count
        FROM notes
        GROUP BY type
        ORDER BY count DESC
      `)
      .all() as any[];

    // 5. Recent notes
    const recentNotes = listNotes({ limit: 15 });

    // 6. Unknown notes (Repair Queue - limit 150)
    const unknownNotes = listNotes({ scope: 'unknown', limit: 150 });

    // 7. Recent Trajectories
    const recentTrajectories = listTrajectories({ limit: 15 });

    // 8. Recent Observations
    const recentObservations = listObservations({ limit: 15 });

    // 9. Extractive Summaries with claims and sources (batched to eliminate N+1 queries)
    const rawSummaries = db
      .prepare('SELECT * FROM summaries ORDER BY created_at DESC LIMIT 15')
      .all() as any[];

    let summaries: any[] = [];
    if (rawSummaries.length > 0) {
      const summaryIds = rawSummaries.map((s) => s.id);
      const placeholders = summaryIds.map(() => '?').join(',');
      const allClaims = db
        .prepare(
          `SELECT id, summary_id, text, ordinal FROM summary_claims WHERE summary_id IN (${placeholders}) ORDER BY ordinal ASC`
        )
        .all(...summaryIds) as any[];
      const allSources = db
        .prepare(
          `SELECT summary_id, claim_id, record_id, grain FROM summary_sources WHERE summary_id IN (${placeholders})`
        )
        .all(...summaryIds) as any[];

      const claimsBySummary = new Map<string, any[]>();
      for (const c of allClaims) {
        const list = claimsBySummary.get(c.summary_id) || [];
        list.push(c);
        claimsBySummary.set(c.summary_id, list);
      }
      const sourcesBySummary = new Map<string, any[]>();
      for (const s of allSources) {
        const list = sourcesBySummary.get(s.summary_id) || [];
        list.push(s);
        sourcesBySummary.set(s.summary_id, list);
      }

      summaries = rawSummaries.map((s) => ({
        ...s,
        claims: claimsBySummary.get(s.id) || [],
        sources: sourcesBySummary.get(s.id) || [],
      }));
    }

    // 10. Failure Patterns
    const failurePatterns = db
      .prepare('SELECT * FROM failure_patterns ORDER BY count DESC, last_seen_at DESC LIMIT 50')
      .all() as any[];

    // 11. Dead Letters
    const dlItems = db
      .prepare('SELECT * FROM dead_letters ORDER BY created_at DESC LIMIT 25')
      .all() as any[];

    const dlByReason = db
      .prepare('SELECT reason, COUNT(*) as count FROM dead_letters GROUP BY reason ORDER BY count DESC')
      .all() as any[];

    const dlByProducer = db
      .prepare("SELECT COALESCE(producer, 'unknown') as producer, COUNT(*) as count FROM dead_letters GROUP BY producer ORDER BY count DESC")
      .all() as any[];

    const deadLetters = {
      items: dlItems,
      by_reason: dlByReason,
      by_producer: dlByProducer,
    };

    // 12. Client Spool Telemetry
    const spool = getSpoolStats();

    // 13. Sessions, Actions, and Lessons telemetry
    const sessRow = db
      .prepare(`
        SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) as active,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
          COALESCE(SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END), 0) as abandoned
        FROM sessions
      `)
      .get() as any;
    const sessions = {
      total: sessRow?.total ?? 0,
      active: sessRow?.active ?? 0,
      completed: sessRow?.completed ?? 0,
      abandoned: sessRow?.abandoned ?? 0,
    };

    const actRow = db
      .prepare(`
        SELECT
          COUNT(*) as total,
          COALESCE(SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END), 0) as ready,
          COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) as blocked,
          COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) as in_progress,
          COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) as done
        FROM actions
      `)
      .get() as any;
    const actions = {
      total: actRow?.total ?? 0,
      ready: actRow?.ready ?? 0,
      blocked: actRow?.blocked ?? 0,
      in_progress: actRow?.in_progress ?? 0,
      done: actRow?.done ?? 0,
    };

    const lessonsRow = db
      .prepare(`SELECT COUNT(*) as count FROM notes WHERE type IN ('lesson', 'bug')`)
      .get() as any;
    const lessonsCount = lessonsRow?.count ?? 0;

    res.json({
      health,
      counts,
      projects,
      type_distribution: typeDistribution,
      recent_notes: recentNotes,
      unknown_notes: unknownNotes,
      recent_trajectories: recentTrajectories,
      recent_observations: recentObservations,
      summaries,
      failure_patterns: failurePatterns,
      dead_letters: deadLetters,
      spool,
      sessions,
      actions,
      lessonsCount,
    });
  } catch (err) {
    next(err);
  }
});

// GET /dashboard/api/graph: Knowledge graph nodes & edges
dashboardRouter.get('/api/graph', (req: Request, res: Response, next: NextFunction) => {
  try {
    const graph = getKnowledgeGraph(parseGraphQuery(req.query as Record<string, unknown>));
    res.json(graph);
  } catch (err) {
    next(err);
  }
});

function checkDashboardCsrf(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (host && originHost !== host) {
        const xRequestedWith = req.headers['x-requested-with'];
        const contentType = req.headers['content-type'];
        if (!xRequestedWith && (!contentType || !contentType.includes('application/json'))) {
          return res.status(403).json({
            error: {
              code: 'CSRF_REJECTED',
              message: 'Cross-origin request rejected',
            },
          });
        }
      }
    } catch {
      return res.status(403).json({
        error: {
          code: 'CSRF_REJECTED',
          message: 'Invalid Origin header',
        },
      });
    }
  }
  next();
}

// POST /dashboard/api/migrate: Imports notes from an existing agentmemory store
dashboardRouter.post('/api/migrate', checkDashboardCsrf, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await migrateAgentMemoryNotes();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /dashboard/api/drain-embed: Drains pending live embeddings
dashboardRouter.post('/api/drain-embed', checkDashboardCsrf, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await drainEmbedQueue({ maxBatches: 10, batchSize: 64 });
    res.json({
      success: true,
      ...result,
    });
  } catch (err) {
    next(err);
  }
});
