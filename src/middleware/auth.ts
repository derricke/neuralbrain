import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDb, getDbPath, isDatabaseUnavailableError } from '../lib/db';
import { logger } from '../lib/logger';
import { getCorrelationId } from './tracing';

export interface AuthRequest extends Request {
  apiKeyId?: string;
  apiKeyName?: string;
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

let DASHBOARD_SESSION_TOKEN = crypto.randomBytes(32).toString('hex');

export function getDashboardSessionToken(): string {
  return DASHBOARD_SESSION_TOKEN;
}

export function resetDashboardSessionTokenForTesting(): string {
  DASHBOARD_SESSION_TOKEN = crypto.randomBytes(32).toString('hex');
  return DASHBOARD_SESSION_TOKEN;
}

function isAuthExempt(path: string): boolean {
  return (
    path === '/' ||
    path === '/health' ||
    path === '/favicon.ico' ||
    path === '/dashboard' ||
    path === '/dashboard/' ||
    path === '/dashboard/styles.css' ||
    path === '/dashboard/app.js' ||
    path === '/dashboard/api/auth-status' ||
    path === '/dashboard/api/session'
  );
}

let cachedSessionSecret: string | null = null;

export function getSessionSecret(): string {
  if (cachedSessionSecret) return cachedSessionSecret;
  if (process.env.BRAIN_SESSION_SECRET) {
    cachedSessionSecret = process.env.BRAIN_SESSION_SECRET.trim();
    return cachedSessionSecret;
  }
  try {
    const dbPath = getDbPath();
    if (dbPath !== ':memory:' && process.env.NODE_ENV !== 'test') {
      const secretFile = path.join(path.dirname(path.resolve(dbPath)), '.session-secret');
      if (fs.existsSync(secretFile)) {
        cachedSessionSecret = fs.readFileSync(secretFile, 'utf8').trim();
      } else {
        cachedSessionSecret = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(secretFile, cachedSessionSecret, { mode: 0o600 });
      }
      return cachedSessionSecret;
    }
  } catch {
    // fallback
  }
  cachedSessionSecret = crypto.randomBytes(32).toString('hex');
  return cachedSessionSecret;
}

function computeKeyVersion(storedKeyHash: string): string {
  return crypto
    .createHmac('sha256', getSessionSecret())
    .update(storedKeyHash)
    .digest('hex')
    .slice(0, 16);
}

export function createDashboardSessionToken(
  apiKeyId: string,
  apiKeyName: string,
  storedKeyHash?: string
): string {
  let keyHash = storedKeyHash;
  if (!keyHash) {
    try {
      const row = getDb()
        .prepare(`SELECT key FROM api_keys WHERE id = ?`)
        .get(apiKeyId) as { key: string } | undefined;
      keyHash = row?.key || '';
    } catch {
      keyHash = '';
    }
  }
  const keyVersion = keyHash ? computeKeyVersion(keyHash) : '';
  const expiresAt = Date.now() + 7 * 24 * 3600 * 1000; // 7 days
  const payload = `${apiKeyId}:${apiKeyName}:${keyVersion}:${expiresAt}`;
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

export function parseDashboardSessionCookie(cookieHeader?: string): { apiKeyId: string; apiKeyName: string } | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)brain_session=([^;]+)/);
  if (!match) return null;
  const rawToken = match[1];
  try {
    const decoded = Buffer.from(rawToken, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 5) return null;
    const [apiKeyId, apiKeyName, keyVersion, expiresAtStr, sig] = parts;
    const expiresAt = Number(expiresAtStr);
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;

    const payload = `${apiKeyId}:${apiKeyName}:${keyVersion}:${expiresAtStr}`;
    const expectedSig = crypto.createHmac('sha256', getSessionSecret()).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }

    const db = getDb();
    const keyRecord = db.prepare(
      `SELECT id, name, key FROM api_keys WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))`
    ).get(apiKeyId) as { id: string; name: string; key: string } | undefined;

    if (!keyRecord) return null;
    const expectedVersion = computeKeyVersion(keyRecord.key);
    const verBuf = Buffer.from(keyVersion, 'utf8');
    const expectedVerBuf = Buffer.from(expectedVersion, 'utf8');
    if (verBuf.length !== expectedVerBuf.length || !crypto.timingSafeEqual(verBuf, expectedVerBuf)) {
      return null;
    }

    return { apiKeyId: keyRecord.id, apiKeyName: keyRecord.name };
  } catch {
    return null;
  }
}

export function setDashboardSessionCookie(
  res: Response,
  apiKeyId: string,
  apiKeyName: string,
  isSecure = false,
  storedKeyHash?: string
): void {
  const token = createDashboardSessionToken(apiKeyId, apiKeyName, storedKeyHash);
  const secureFlag = isSecure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    [
      `brain_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secureFlag}`,
      `brain_session=; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=0`
    ]
  );
}

export function clearDashboardSessionCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    [
      `brain_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      `brain_session=; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=0`
    ]
  );
}

export function hasActiveApiKeys(): boolean {
  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT 1 FROM api_keys
         WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))
         LIMIT 1`
      )
      .get();
    return Boolean(row);
  } catch {
    return false;
  }
}

export function apiKeyAuth(req: AuthRequest, res: Response, next: NextFunction) {
  // Skip auth for explicitly public endpoints
  if (isAuthExempt(req.path)) {
    return next();
  }

  // Bypass auth if BRAIN_REQUIRE_API_KEY is explicitly '0'
  if (process.env.BRAIN_REQUIRE_API_KEY === '0') {
    return next();
  }

  const activeKeysExist = hasActiveApiKeys();

  // First-time bootstrap claim:
  // If 0 active keys exist in the database, allow an initial unauthenticated
  // POST /maintenance/api-keys with X-Requested-With: XMLHttpRequest to claim the first key.
  if (!activeKeysExist && req.method === 'POST' && req.path === '/maintenance/api-keys') {
    const xRequestedWith = req.headers['x-requested-with'];
    const isXhr = typeof xRequestedWith === 'string' && xRequestedWith.toLowerCase() === 'xmlhttprequest';
    if (isXhr) {
      req.apiKeyId = 'bootstrap-claim';
      req.apiKeyName = 'initial-bootstrap-claim';
      return next();
    } else {
      logger.warn({ path: req.path, traceId: getCorrelationId(req) }, 'bootstrap key creation requires X-Requested-With header');
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Bootstrap key creation requires X-Requested-With header',
          trace_id: getCorrelationId(req),
        },
      });
    }
  }

  const authHeader = req.headers.authorization;
  const traceId = getCorrelationId(req);

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const apiKey = authHeader.slice(7).trim();
    if (!apiKey) {
      logger.warn({ path: req.path, traceId }, 'empty api key provided');
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired API key',
          trace_id: traceId,
        },
      });
    }

    // Dashboard session token check (requires X-Requested-With: XMLHttpRequest to prevent CSRF)
    // ONLY accepted when no active keys exist yet! Once hasActiveApiKeys() === true,
    // all windows must authenticate with a real API key.
    if (!activeKeysExist) {
      const sessionToken = getDashboardSessionToken();
      const sessionTokenBuf = Buffer.from(sessionToken, 'utf8');
      const tokenBuf = Buffer.from(apiKey, 'utf8');

      if (tokenBuf.length === sessionTokenBuf.length && crypto.timingSafeEqual(tokenBuf, sessionTokenBuf)) {
        const xRequestedWith = req.headers['x-requested-with'];
        const isXhr = typeof xRequestedWith === 'string' && xRequestedWith.toLowerCase() === 'xmlhttprequest';
        if (isXhr) {
          req.apiKeyId = 'dashboard-session';
          req.apiKeyName = 'dashboard-operator';
          return next();
        } else {
          logger.warn({ path: req.path, traceId }, 'dashboard session token used without X-Requested-With header');
          return res.status(401).json({
            error: {
              code: 'UNAUTHORIZED',
              message: 'Dashboard session token requires X-Requested-With header',
              trace_id: traceId,
            },
          });
        }
      }
    }

    const hashedKey = hashApiKey(apiKey);

    try {
      const db = getDb();
      // Query matching either hashedKey or rawKey to maintain 100% backward compatibility
      // with unit tests inserting raw keys directly into api_keys table
      const keyRecords = db
        .prepare(
          `SELECT id, name, key, last_used_at FROM api_keys 
           WHERE (key = ? OR key = ?) AND revoked_at IS NULL AND 
                 (expires_at IS NULL OR expires_at > datetime('now'))`
        )
        .all(hashedKey, apiKey) as Array<{ id: string; name: string; key: string; last_used_at: string }>;

      const matched = keyRecords.find((rec) => {
        const candidateBuf = Buffer.from(rec.key, 'utf8');
        const hashedBuf = Buffer.from(hashedKey, 'utf8');
        const rawBuf = Buffer.from(apiKey, 'utf8');

        if (candidateBuf.length === hashedBuf.length && crypto.timingSafeEqual(candidateBuf, hashedBuf)) {
          return true;
        }
        if (candidateBuf.length === rawBuf.length && crypto.timingSafeEqual(candidateBuf, rawBuf)) {
          return true;
        }
        return false;
      });

      if (!matched) {
        logger.warn({ path: req.path, traceId }, 'invalid api key');
        return res.status(401).json({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired API key',
            trace_id: traceId,
          },
        });
      }

      // Update last_used_at
      db.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`).run(matched.id);

      req.apiKeyId = matched.id;
      req.apiKeyName = matched.name;

      return next();
    } catch (error) {
      if (isDatabaseUnavailableError(error)) {
        logger.error({ error: error.message, path: req.path, traceId }, 'database unavailable during auth check');
        return res.status(503).json({
          error: {
            code: 'DATABASE_UNAVAILABLE',
            message: 'Database is unavailable',
            trace_id: traceId,
          },
        });
      }

      logger.error(
        { error: error instanceof Error ? error.message : String(error), path: req.path, traceId },
        'error verifying api key'
      );
      return res.status(500).json({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Error verifying api key',
          trace_id: traceId,
        },
      });
    }
  }

  // 2. Check HttpOnly dashboard session cookie (for /dashboard requests)
  const session = parseDashboardSessionCookie(req.headers.cookie);
  if (session) {
    req.apiKeyId = session.apiKeyId;
    req.apiKeyName = session.apiKeyName;
    return next();
  }

  logger.warn({ path: req.path, traceId }, 'missing or invalid authorization header');
  return res.status(401).json({
    error: {
      code: 'UNAUTHORIZED',
      message: 'Missing or invalid Authorization header. Use: Authorization: Bearer YOUR_API_KEY',
      trace_id: traceId,
    },
  });
}

export interface BootstrapApiKeyOptions {
  dbPath?: string;
  forceBootstrap?: boolean;
}

export interface BootstrapApiKeyResult {
  envKeyConfigured: boolean;
  bootstrapKeyGenerated: boolean;
  rawKey?: string;
  keyFilePath?: string;
}

export function ensureBootstrapApiKey(options?: BootstrapApiKeyOptions): BootstrapApiKeyResult {
  const db = getDb();
  let envKeyConfigured = false;
  let bootstrapKeyGenerated = false;
  let rawKey: string | undefined;
  let keyFilePath: string | undefined;

  // 1. If BRAIN_API_KEY is set (non-empty), compute SHA-256 and insert/update
  const envApiKey = process.env.BRAIN_API_KEY?.trim();
  if (envApiKey) {
    const hashed = hashApiKey(envApiKey);
    const existing = db
      .prepare(`SELECT id, key FROM api_keys WHERE id = 'env-configured-key'`)
      .get() as { id: string; key: string } | undefined;
    if (!existing) {
      db.prepare(`INSERT OR IGNORE INTO api_keys (id, name, key) VALUES ('env-configured-key', 'env-brain-api-key', ?)`).run(hashed);
    } else if (existing.key !== hashed) {
      db.prepare(`UPDATE api_keys SET key = ?, revoked_at = NULL WHERE id = 'env-configured-key'`).run(hashed);
    }
    envKeyConfigured = true;
    logger.info('configured BRAIN_API_KEY from environment registered');
  }

  // 2. Only auto-generate default-bootstrap-key if explicitly forced or requested via BRAIN_AUTO_BOOTSTRAP_KEY === '1'
  const shouldForceBootstrap = options?.forceBootstrap === true || process.env.BRAIN_AUTO_BOOTSTRAP_KEY === '1';

  const countRow = db.prepare(`
    SELECT count(*) as count FROM api_keys
    WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get() as { count: number };

  if (shouldForceBootstrap && countRow.count === 0) {
    rawKey = crypto.randomBytes(32).toString('hex');
    const hashed = hashApiKey(rawKey);

    const existingBootstrap = db
      .prepare(`SELECT id FROM api_keys WHERE id = 'default-bootstrap-key'`)
      .get() as { id: string } | undefined;

    if (!existingBootstrap) {
      db.prepare(`
        INSERT INTO api_keys (id, name, key)
        VALUES ('default-bootstrap-key', 'default-bootstrap-key', ?)
      `).run(hashed);
    } else {
      db.prepare(`
        UPDATE api_keys SET key = ?, revoked_at = NULL WHERE id = 'default-bootstrap-key'
      `).run(hashed);
    }

    bootstrapKeyGenerated = true;

    const dbPath = options?.dbPath || getDbPath();
    const dir = path.dirname(path.resolve(dbPath));
    const candidateKeyFile = path.join(dir, 'api-key.txt');

    if (dbPath !== ':memory:' && process.env.NODE_ENV !== 'test') {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(candidateKeyFile, rawKey + '\n', { mode: 0o600 });
        keyFilePath = candidateKeyFile;
        logger.info(
          { path: candidateKeyFile },
          'bootstrap API key automatically generated and saved to ' + candidateKeyFile
        );
      } catch (err) {
        logger.error(
          { error: err instanceof Error ? err.message : String(err), path: candidateKeyFile },
          'failed to write bootstrap API key to file'
        );
      }
    } else {
      logger.info('bootstrap API key generated in-memory');
    }
  }

  return {
    envKeyConfigured,
    bootstrapKeyGenerated,
    rawKey,
    keyFilePath,
  };
}
