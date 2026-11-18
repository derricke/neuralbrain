import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getDb, isDatabaseUnavailableError } from './lib/db';
import { logger } from './lib/logger';
import { getCorrelationId, requestTracing } from './middleware/tracing';
import { createRateLimiter } from './middleware/rateLimiter';
import { apiKeyAuth, hashApiKey, setDashboardSessionCookie } from './middleware/auth';
import { captureObservations, getObservation, listObservations } from './memory/observationStore';
import {
  captureTrajectories,
  getTrajectory,
  listTrajectories,
  runCleanup,
} from './memory/trajectoryStore';
import {
  createNote,
  getNote,
  getNotesByFile,
  listNotes,
  updateNoteScope,
} from './memory/noteStore';
import { sweepIdleSessions } from './memory/rollupSweeper';
import { formatCriticalWarnings, getFailurePatterns } from './memory/failurePatternStore';
import { listDeadLetters } from './memory/deadLetterStore';
import { getPendingEmbedCount } from './memory/embedQueueStore';
import {
  endSession,
  getLatestSessionSummary,
  getSessionDetails,
  getSessionReplay,
  listSessions,
  startSession,
} from './memory/sessionStore';
import { getKnowledgeGraph, parseGraphQuery } from './memory/graphStore';
import { renameProject } from './memory/projectRename';
import {
  createAction,
  getReadyActions,
  listActions,
  updateAction,
} from './memory/actionStore';
import { verifyOrCreateStoreMeta } from './learning/storeMeta';
import { hybridSearch } from './learning/search';
import {
  drainEmbedQueue,
  probeQdrant,
  getReembedStatus,
  startReembed,
} from './learning/embedWorker';
import {
  formatConsolidationWarning,
  getConsolidationCandidates,
  getConsolidationStatus,
} from './consolidation/candidates';
import { verifyAndStoreSummary } from './consolidation/gate';
import { runAiConformanceDiagnostics } from './consolidation/fixtures';
import { runConsolidation } from './consolidation/runner';
import { describeAiConfig } from './ai/config';
import { getBreakerStatus } from './ai/circuitBreaker';
import { memoriesRouter } from './routes/memories';
import { learningRouter } from './routes/learning';
import { dashboardRouter } from './routes/dashboard';
import { mcpRouter } from './routes/mcp';

function parseBoundedLimit(raw: unknown, defaultLimit = 50, maxLimit = 200): number {
  if (raw === undefined || raw === null || raw === '') return defaultLimit;
  const parsed = parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultLimit;
  return Math.min(parsed, maxLimit);
}

export function createApp(): express.Application {
  const app = express();

  // Basic middleware
  app.use(express.json({ limit: '10mb', strict: false }));

  // Global security headers
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Middleware pipeline order: tracing -> auth -> rate limiter -> routes
  app.use(requestTracing);
  app.use(apiKeyAuth);
  app.use(createRateLimiter());

  // -------------------------------------------------------------------------
  // Health (unauthenticated, rate-limit exempt)
  // -------------------------------------------------------------------------
  app.get('/health', async (_req: Request, res: Response) => {
    let dbStatus = 'ok';
    try {
      getDb().prepare('SELECT 1').get();
    } catch {
      dbStatus = 'unavailable';
    }

    const qdrantStatus = await probeQdrant();

    let verification: any = {
      match: false,
      recipe: {
        embed_tier: 'none',
        embed_model: 'none',
        embed_model_id: 'none',
        embed_dim: 0,
      },
      mismatchReason: null,
    };
    let pendingEmbedCount = 0;

    if (dbStatus === 'ok') {
      try {
        verification = verifyOrCreateStoreMeta();
        pendingEmbedCount = getPendingEmbedCount('live');
      } catch {
        dbStatus = 'unavailable';
      }
    }

    const status =
      dbStatus === 'ok' && verification.match ? 'ok' : 'degraded';

    res.json({
      status,
      db: dbStatus,
      qdrant: qdrantStatus,
      embed_queue_pending: pendingEmbedCount,
      store_meta: {
        match: Boolean(verification.match),
        embed_tier: verification.recipe?.embed_tier ?? 'none',
        embed_model: verification.recipe?.embed_model ?? 'none',
        embed_model_id: verification.recipe?.embed_model_id ?? 'none',
        embed_dim: verification.recipe?.embed_dim ?? 0,
        mismatch_reason: verification.mismatchReason || null,
      },
    });
  });

  // -------------------------------------------------------------------------
  // Capture Hot-Paths (rate-limit exempt)
  // -------------------------------------------------------------------------
  app.post('/capture/observations', (req: Request, res: Response) => {
    if (!req.body || typeof req.body !== 'object') {
      res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Request body must be a valid JSON object or array',
          trace_id: getCorrelationId(req),
        },
      });
      return;
    }
    const raw = req.body;
    const items = Array.isArray(raw) ? raw : (raw.observations ?? [raw]);
    const result = captureObservations(items);
    res.status(201).json(result);
  });

  app.post('/capture/trajectories', (req: Request, res: Response) => {
    if (!req.body || typeof req.body !== 'object') {
      res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Request body must be a valid JSON object or array',
          trace_id: getCorrelationId(req),
        },
      });
      return;
    }
    const raw = req.body;
    const items = Array.isArray(raw) ? raw : (raw.trajectories ?? [raw]);
    const result = captureTrajectories(items);
    res.status(201).json(result);
  });

  // -------------------------------------------------------------------------
  // Retrieval & Search
  // -------------------------------------------------------------------------
  app.post('/search', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.body || typeof req.body.q !== 'string') {
        res.status(400).json({
          error: {
            code: 'INVALID_QUERY',
            message: "Missing or invalid query parameter 'q'",
            trace_id: getCorrelationId(req),
          },
        });
        return;
      }
      const response = await hybridSearch(req.body);
      res.json(response);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------
  app.post('/notes', (req: Request, res: Response, next: NextFunction) => {
    try {
      const created = createNote({
        ...req.body,
        projectId: req.body.projectId ?? req.body.project_id,
        session_id: req.body.session_id ?? req.body.sessionId,
      });
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  app.get('/notes/:id', (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const note = getNote(id);
    if (!note) {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Note '${id}' not found`,
          trace_id: getCorrelationId(req),
        },
      });
      return;
    }
    res.json(note);
  });

  app.patch('/notes/:id/scope', (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const updated = updateNoteScope(
        id,
        req.body.scope,
        req.body.projectId ?? req.body.project_id
      );
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.get('/notes', (req: Request, res: Response) => {
    const scope = req.query.scope as string | undefined;
    const projectId = (req.query.project_id || req.query.projectId) as string | undefined;
    const includeGlobal = req.query.include_global !== 'false';
    const concept = req.query.concept as string | undefined;
    const filePath = (req.query.file_path || req.query.filePath) as string | undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : undefined;

    let type: string[] | undefined;
    if (req.query.type) {
      type = Array.isArray(req.query.type)
        ? (req.query.type as string[])
        : [String(req.query.type)];
    }

    const notes = listNotes({
      scope,
      projectId,
      includeGlobal,
      type,
      concept,
      filePath,
      limit,
      offset,
    });
    res.json(notes);
  });

  // Files -> Notes associations (support URL-encoded and wildcard paths)
  app.get(/^\/files\/(.+)\/notes$/, (req: Request, res: Response) => {
    const rawPath = Array.isArray(req.params[0]) ? req.params[0][0] : req.params[0];
    const decodedPath = decodeURIComponent(String(rawPath));
    const projectId = (req.query.project_id || req.query.projectId) as string | undefined;
    const notes = getNotesByFile(decodedPath, projectId);
    res.json(notes);
  });

  app.get('/files/:path/notes', (req: Request, res: Response) => {
    const rawPath = Array.isArray(req.params.path) ? req.params.path[0] : req.params.path;
    const decodedPath = decodeURIComponent(String(rawPath));
    const projectId = (req.query.project_id || req.query.projectId) as string | undefined;
    const notes = getNotesByFile(decodedPath, projectId);
    res.json(notes);
  });

  // -------------------------------------------------------------------------
  // Trajectories
  // -------------------------------------------------------------------------
  app.get('/trajectories/:id', (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const traj = getTrajectory(id);
    if (!traj) {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Trajectory '${id}' not found`,
          trace_id: getCorrelationId(req),
        },
      });
      return;
    }
    res.json(traj);
  });

  app.get('/trajectories', (req: Request, res: Response) => {
    const projectId = (req.query.project_id || req.query.projectId) as string | undefined;
    const scope = req.query.scope as string | undefined;
    const taskType = (req.query.task_type || req.query.taskType) as string | undefined;
    // 'unknown' is a third answer here, not a missing one: a swept rollup has
    // no outcome, and folding it into either branch would invent one.
    const rawSuccess = req.query.success;
    const successUnknown = rawSuccess === 'unknown' || rawSuccess === 'null';
    const success =
      rawSuccess !== undefined && !successUnknown
        ? rawSuccess === 'true' || rawSuccess === '1'
        : undefined;
    const rollupSourceParam = (req.query.rollup_source || req.query.rollupSource) as
      | string
      | undefined;
    const rollupSource =
      rollupSourceParam === 'signalled' || rollupSourceParam === 'swept'
        ? rollupSourceParam
        : undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : undefined;

    const list = listTrajectories({
      projectId,
      scope,
      taskType,
      success,
      successUnknown,
      rollupSource,
      limit,
      offset,
    });
    res.json(list);
  });

  // -------------------------------------------------------------------------
  // Observations
  // -------------------------------------------------------------------------
  app.get('/observations/:id', (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const obs = getObservation(id);
    if (!obs) {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Observation '${id}' not found`,
          trace_id: getCorrelationId(req),
        },
      });
      return;
    }
    res.json(obs);
  });

  app.get('/observations', (req: Request, res: Response) => {
    const projectId = (req.query.project_id || req.query.projectId) as string | undefined;
    const scope = req.query.scope as string | undefined;
    const sessionId = (req.query.session_id || req.query.sessionId) as string | undefined;
    const failed =
      req.query.failed !== undefined ? parseInt(String(req.query.failed), 10) : undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : undefined;

    const list = listObservations({
      projectId,
      scope,
      sessionId,
      failed,
      limit,
      offset,
    });
    res.json(list);
  });

  // -------------------------------------------------------------------------
  // Summaries
  // -------------------------------------------------------------------------
  app.get('/summaries/:id', (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const db = getDb();
    const summary = db
      .prepare('SELECT * FROM summaries WHERE id = ?')
      .get(id) as any;

    if (!summary) {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Summary '${id}' not found`,
          trace_id: getCorrelationId(req),
        },
      });
      return;
    }

    const claims = db
      .prepare('SELECT id, summary_id, text, ordinal FROM summary_claims WHERE summary_id = ? ORDER BY ordinal ASC')
      .all(summary.id);
    const sources = db
      .prepare('SELECT summary_id, claim_id, record_id, grain FROM summary_sources WHERE summary_id = ?')
      .all(summary.id);

    res.json({
      ...summary,
      claims,
      sources,
    });
  });

  app.get('/summaries', (req: Request, res: Response) => {
    const db = getDb();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (req.query.project_id || req.query.projectId) {
      conditions.push('project_id = ?');
      params.push((req.query.project_id || req.query.projectId) as string);
    }
    if (req.query.scope) {
      conditions.push('scope = ?');
      params.push(req.query.scope as string);
    }
    if (req.query.kind) {
      conditions.push('kind = ?');
      params.push(req.query.kind as string);
    }
    if (req.query.only_latest !== 'false') {
      conditions.push('is_latest = 1');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
    const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
    params.push(limit, offset);

    const summaries = db
      .prepare(`SELECT * FROM summaries ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params) as any[];

    if (summaries.length === 0) {
      res.json([]);
      return;
    }

    const summaryIds = summaries.map((s) => s.id);
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

    const results = summaries.map((s) => ({
      ...s,
      claims: claimsBySummary.get(s.id) || [],
      sources: sourcesBySummary.get(s.id) || [],
    }));

    res.json(results);
  });

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------
  app.post('/sessions/start', (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = startSession(req.body ?? {});
      res.status(201).json({ session });
    } catch (err) {
      next(err);
    }
  });

  app.post('/sessions/:id/end', (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const session = endSession(id, req.body ?? {});
      if (!session) {
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: `Session '${id}' not found`,
            trace_id: getCorrelationId(req),
          },
        });
        return;
      }
      res.json({ session });
    } catch (err) {
      next(err);
    }
  });

  app.get('/sessions', (req: Request, res: Response) => {
    const projectId = (req.query.project_id || req.query.projectId) as string | undefined;
    const status = req.query.status as string | undefined;
    const agentName = (req.query.agent_name || req.query.agentName) as string | undefined;
    const limit = parseBoundedLimit(req.query.limit, 50, 200);

    const sessions = listSessions({ projectId, status, agentName, limit });
    res.json({ sessions });
  });

  app.get('/sessions/:id', (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const details = getSessionDetails(id);
    if (!details) {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Session '${id}' not found`,
          trace_id: getCorrelationId(req),
        },
      });
      return;
    }
    res.json(details);
  });

  app.get('/sessions/:id/replay', (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const replay = getSessionReplay(id);
    if (!replay) {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Session '${id}' not found`,
          trace_id: getCorrelationId(req),
        },
      });
      return;
    }
    res.json(replay);
  });

  // -------------------------------------------------------------------------
  // Knowledge Graph
  // -------------------------------------------------------------------------
  app.get('/graph', (req: Request, res: Response) => {
    const graph = getKnowledgeGraph(parseGraphQuery(req.query as Record<string, unknown>));
    res.json(graph);
  });

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  app.post('/actions', (req: Request, res: Response, next: NextFunction) => {
    try {
      const action = createAction(req.body ?? {});
      res.status(201).json({ action });
    } catch (err) {
      next(err);
    }
  });

  app.get('/actions', (req: Request, res: Response) => {
    const projectId = (req.query.project_id || req.query.projectId) as string | undefined;
    const includeGlobal = req.query.include_global !== 'false';
    const sessionId = (req.query.session_id || req.query.sessionId) as string | undefined;
    const limit = parseBoundedLimit(req.query.limit, 50, 200);

    let status: string | string[] | undefined;
    if (req.query.status) {
      status = Array.isArray(req.query.status)
        ? (req.query.status as string[])
        : String(req.query.status);
    }

    const actions = listActions({
      projectId,
      includeGlobal,
      status,
      sessionId,
      limit,
    });
    res.json({ actions });
  });

  app.patch('/actions/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const action = updateAction(id, req.body ?? {});
      if (!action) {
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: `Action '${id}' not found`,
            trace_id: getCorrelationId(req),
          },
        });
        return;
      }
      res.json({ action });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // Push Injection
  // -------------------------------------------------------------------------
  app.get('/inject', (req: Request, res: Response) => {
    const projectId = (req.query.project_id || req.query.projectId) as string | undefined;
    const taskType = (req.query.task_type || req.query.taskType) as string | undefined;
    const limit = parseBoundedLimit(req.query.limit, 5, 200);

    const failure_patterns = getFailurePatterns({
      projectId,
      taskType,
      includeGlobal: true,
      limit,
    });

    const prior_outcomes = listTrajectories({
      projectId,
      taskType,
      limit,
    });

    const ready_actions = getReadyActions({
      projectId,
      limit,
    });

    const latest_session_summary = getLatestSessionSummary(projectId);

    const lessons = listNotes({
      projectId,
      includeGlobal: true,
      type: ['lesson', 'bug', 'pattern'],
      limit,
    });

    const notes = listNotes({
      projectId,
      includeGlobal: true,
      type: ['architecture', 'workflow', 'preference', 'fact'],
      limit,
    });

    const formatted_warnings = formatCriticalWarnings(failure_patterns);
    const consolidation_warning = formatConsolidationWarning(
      getConsolidationStatus(projectId),
      projectId
    );

    res.json({
      failure_patterns,
      prior_outcomes,
      ready_actions,
      latest_session_summary,
      lessons,
      notes,
      formatted_warnings,
      consolidation_warning,
    });
  });

  // -------------------------------------------------------------------------
  // Consolidation
  // -------------------------------------------------------------------------
  app.get('/consolidate/candidates', (req: Request, res: Response) => {
    const projectId = (req.query.project_id || req.query.projectId) as string | undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const leaseDurationSec = req.query.lease_duration_sec
      ? parseInt(String(req.query.lease_duration_sec), 10)
      : undefined;

    const result = getConsolidationCandidates({
      projectId,
      limit,
      leaseDurationSec,
    });
    res.json(result);
  });

  app.post('/consolidate/summaries', (req: Request, res: Response) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Request body must be a valid JSON object',
          trace_id: getCorrelationId(req),
        },
      });
      return;
    }
    const result = verifyAndStoreSummary(req.body);
    if (!result.ok) {
      res.status(result.status).json({
        error: {
          code: result.reason,
          message: result.message,
          details: result.details,
          trace_id: getCorrelationId(req),
        },
      });
      return;
    }
    res.status(result.status).json(result);
  });

  // Runs the configured server-side producer (`remote` or `vendor`). With the
  // default tier `agent` it does nothing but say so: the host agent pulls
  // candidates above and posts summaries back, holding no key at all.
  app.post('/consolidate/run', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body ?? {};
      const report = await runConsolidation({
        projectId: body.project_id ?? body.projectId,
        limit: body.limit ? parseInt(String(body.limit), 10) : undefined,
        leaseDurationSec: body.lease_duration_sec
          ? parseInt(String(body.lease_duration_sec), 10)
          : undefined,
      });
      res.status(report.status === 'misconfigured' ? 400 : 200).json(report);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // Operations & Maintenance
  // -------------------------------------------------------------------------
  app.post('/maintenance/cleanup', (_req: Request, res: Response) => {
    const result = runCleanup();
    res.json(result);
  });

  /**
   * Roll up sessions nobody closed. Arithmetic only, idempotent, and the
   * safety net behind the explicit `observation_ids` path — see
   * src/memory/rollupSweeper.ts.
   */
  app.post('/maintenance/rollup-sweep', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawIdle = body.idle_minutes ?? body.idleMinutes ?? req.query.idle_minutes;
    const rawLimit = body.limit ?? req.query.limit;

    const idleMinutes = rawIdle !== undefined ? Number(rawIdle) : undefined;
    if (idleMinutes !== undefined && (!Number.isFinite(idleMinutes) || idleMinutes < 0)) {
      res.status(400).json({
        error: {
          code: 'SCHEMA_INVALID',
          message: 'idle_minutes must be a non-negative number',
          trace_id: getCorrelationId(req),
        },
      });
      return;
    }

    const limit = rawLimit !== undefined ? Number(rawLimit) : undefined;
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      res.status(400).json({
        error: {
          code: 'SCHEMA_INVALID',
          message: 'limit must be a positive number',
          trace_id: getCorrelationId(req),
        },
      });
      return;
    }

    const result = sweepIdleSessions({ idleMinutes, limit });
    res.json(result);
  });

  app.post('/maintenance/reembed', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const currentStatus = getReembedStatus();
      if (currentStatus.status === 'running') {
        res.status(409).json({
          error: {
            code: 'REEMBED_IN_PROGRESS',
            message: 'A re-embedding process is already running',
            status: currentStatus,
            trace_id: getCorrelationId(_req),
          },
        });
        return;
      }
      const result = await startReembed();
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get('/maintenance/reembed', (_req: Request, res: Response) => {
    res.json(getReembedStatus());
  });

  app.post('/maintenance/rename-project', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const fromId = body.from_project_id ?? body.fromProjectId;
      const toId = body.to_project_id ?? body.toProjectId;

      if (typeof fromId !== 'string' || typeof toId !== 'string') {
        res.status(400).json({
          error: {
            code: 'SCHEMA_INVALID',
            message: 'from_project_id and to_project_id strings are required',
            trace_id: getCorrelationId(req),
          },
        });
        return;
      }

      const result = await renameProject(fromId, toId);
      res.json(result);
    } catch (err: any) {
      if (err instanceof Error && (err.message.startsWith('Invalid ') || err.message.includes('must be different'))) {
        res.status(400).json({
          error: {
            code: 'SCHEMA_INVALID',
            message: err.message,
            trace_id: getCorrelationId(req),
          },
        });
        return;
      }
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // In-Service API Key Management (Single-Writer Compliant)
  // -------------------------------------------------------------------------
  app.get('/maintenance/api-keys', (_req: Request, res: Response) => {
    const traceId = getCorrelationId(_req);
    try {
      const db = getDb();
      const keys = db
        .prepare(
          `SELECT id, name, created_at, last_used_at, expires_at
           FROM api_keys
           WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))
           ORDER BY created_at DESC`
        )
        .all();
      res.json(keys);
    } catch (err) {
      logger.error({ error: err, traceId }, 'failed to list api keys');
      res.status(500).json({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to list API keys',
          trace_id: traceId,
        },
      });
    }
  });

  app.post('/maintenance/api-keys', (req: Request, res: Response) => {
    const traceId = getCorrelationId(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    let name = typeof body.name === 'string' ? body.name.trim() : 'agent-key';
    if (!name) name = 'agent-key';
    if (name.length > 100) {
      res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'name must be at most 100 characters',
          trace_id: traceId,
        },
      });
      return;
    }

    let expiresIn: number | null = null;
    const rawExpires = body.expires_in_seconds ?? body.expiresInSeconds ?? body.expires_in;
    if (rawExpires !== undefined && rawExpires !== null) {
      const val = Number(rawExpires);
      if (!Number.isFinite(val) || val <= 0) {
        res.status(400).json({
          error: {
            code: 'BAD_REQUEST',
            message: 'expires_in_seconds must be a positive number',
            trace_id: traceId,
          },
        });
        return;
      }
      expiresIn = val;
    }

    try {
      const id = crypto.randomUUID();
      const rawKey = crypto.randomBytes(32).toString('hex');
      const hashedKey = hashApiKey(rawKey);
      const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
      const createdAt = new Date().toISOString();

      const db = getDb();
      db.prepare(`
        INSERT INTO api_keys (id, name, key, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, name, hashedKey, expiresAt, createdAt);

      logger.info({ keyId: id, name }, 'api key created via maintenance endpoint');

      if (req.headers['x-requested-with']) {
        setDashboardSessionCookie(res, id, name, req.secure);
      }

      res.status(201).json({
        id,
        name,
        key: rawKey,
        created_at: createdAt,
        expires_at: expiresAt,
      });
    } catch (err) {
      logger.error({ error: err, traceId }, 'failed to create api key');
      res.status(500).json({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create API key',
          trace_id: traceId,
        },
      });
    }
  });

  app.delete('/maintenance/api-keys/:id', (req: Request, res: Response) => {
    const traceId = getCorrelationId(req);
    const keyId = req.params.id;
    if (!keyId) {
      res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'API key ID is required',
          trace_id: traceId,
        },
      });
      return;
    }

    try {
      const db = getDb();
      const result = db.prepare(`DELETE FROM api_keys WHERE id = ?`).run(keyId);
      if (result.changes === 0) {
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: `API key '${keyId}' not found`,
            trace_id: traceId,
          },
        });
        return;
      }

      logger.info({ keyId }, 'api key deleted via maintenance endpoint');
      res.json({ success: true, id: keyId });
    } catch (err) {
      logger.error({ error: err, traceId }, 'failed to delete api key');
      res.status(500).json({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete API key',
          trace_id: traceId,
        },
      });
    }
  });

  app.get('/diagnostics/ai', (_req: Request, res: Response) => {
    const diagnostics = runAiConformanceDiagnostics();
    res.json(diagnostics);
  });

  // Resolved generative configuration. Never includes an API key or any part
  // of one — it reports only which env var a tier needs.
  app.get('/diagnostics/ai-config', (_req: Request, res: Response) => {
    res.json({
      ...describeAiConfig(),
      circuit_breakers: getBreakerStatus(),
    });
  });

  app.get('/failure-patterns', (req: Request, res: Response) => {
    const projectId = (req.query.project_id || req.query.projectId) as string | undefined;
    const taskType = (req.query.task_type || req.query.taskType) as string | undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;

    const patterns = getFailurePatterns({
      projectId,
      taskType,
      includeGlobal: true,
      limit,
    });
    res.json(patterns);
  });

  app.get('/dead-letters', (req: Request, res: Response) => {
    const source = req.query.source as string | undefined;
    const reason = req.query.reason as string | undefined;
    const producer = req.query.producer as string | undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : undefined;

    const deadLetters = listDeadLetters({
      source,
      reason,
      producer,
      limit,
      offset,
    });
    res.json(deadLetters);
  });

  // -------------------------------------------------------------------------
  // Dashboard & Operator Console
  // -------------------------------------------------------------------------
  app.get('/', (_req: Request, res: Response) => {
    res.redirect(302, '/dashboard');
  });
  app.use('/dashboard', dashboardRouter);

  // -------------------------------------------------------------------------
  // Legacy mounted routes
  // -------------------------------------------------------------------------
  app.use('/memories', memoriesRouter);
  app.use('/learning', learningRouter);
  app.use('/mcp', mcpRouter);

  // -------------------------------------------------------------------------
  // Standard Error Handler
  // -------------------------------------------------------------------------
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const traceId = getCorrelationId(req);
    logger.error(
      {
        path: req.path,
        method: req.method,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        traceId,
      },
      'unhandled error during request processing'
    );

    if (isDatabaseUnavailableError(err)) {
      res.status(503).json({
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message: err.message,
          trace_id: traceId,
        },
      });
      return;
    }

    if (err.code === 'SCOPE_REQUIRED') {
      res.status(400).json({
        error: {
          code: 'SCOPE_REQUIRED',
          message: err.message,
          trace_id: traceId,
        },
      });
      return;
    }

    if (
      err.status === 400 ||
      err.statusCode === 400 ||
      err instanceof SyntaxError ||
      err.type === 'entity.parse.failed'
    ) {
      res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: err.message,
          trace_id: traceId,
        },
      });
      return;
    }

    if (err.code === 'SCHEMA_INVALID' || err.code === 'PARENT_NOT_FOUND') {
      res.status(400).json({
        error: {
          code: err.code,
          message: err.message,
          trace_id: traceId,
        },
      });
      return;
    }

    if (err.code === 'NOT_FOUND') {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: err.message,
          trace_id: traceId,
        },
      });
      return;
    }

    res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: err instanceof Error ? err.message : 'Internal Server Error',
        trace_id: traceId,
      },
    });
  });

  return app;
}

export const app = createApp();
