import { Request, Response, NextFunction } from 'express';
import { logger } from '../lib/logger';
import { getCorrelationId } from './tracing';

export interface RateLimitConfig {
  windowMs?: number;
  maxRequests?: number;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const MAX_STORE_ENTRIES = 10_000;

export function normalizePathForRateLimit(path: string): string {
  // Normalize /files/<path>/notes -> /files/:path/notes
  if (path.startsWith('/files/') && path.endsWith('/notes')) {
    return '/files/:path/notes';
  }
  // Normalize /notes/<id>/scope -> /notes/:id/scope
  if (/^\/notes\/[^/]+\/scope$/.test(path)) {
    return '/notes/:id/scope';
  }
  // Normalize /notes/<id> -> /notes/:id
  if (/^\/notes\/[^/]+$/.test(path)) {
    return '/notes/:id';
  }
  // Normalize /observations/<id> -> /observations/:id
  if (/^\/observations\/[^/]+$/.test(path)) {
    return '/observations/:id';
  }
  // Normalize /trajectories/<id> -> /trajectories/:id
  if (/^\/trajectories\/[^/]+$/.test(path)) {
    return '/trajectories/:id';
  }
  // Normalize /summaries/<id> -> /summaries/:id
  if (/^\/summaries\/[^/]+$/.test(path)) {
    return '/summaries/:id';
  }
  return path;
}

function getExemptPrefixes(): string[] {
  const envVal = process.env.BRAIN_RATE_LIMIT_EXEMPT || '/health,/capture';
  return envVal
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isPathExempt(path: string): boolean {
  if (
    path === '/' ||
    path === '/health' ||
    path === '/favicon.ico' ||
    path === '/dashboard' ||
    path.startsWith('/dashboard/') ||
    path.startsWith('/capture')
  ) {
    return true;
  }
  const exemptPrefixes = getExemptPrefixes();
  return exemptPrefixes.some((prefix) => path === prefix || path.startsWith(prefix));
}

export function createRateLimiter(config?: RateLimitConfig) {
  const defaultWindow = parseInt(process.env.BRAIN_RATE_LIMIT_WINDOW_MS || '60000', 10);
  const defaultMax = parseInt(process.env.BRAIN_RATE_LIMIT_MAX || '100', 10);

  const windowMs = config?.windowMs ?? (Number.isFinite(defaultWindow) ? defaultWindow : 60000);
  const maxRequests = config?.maxRequests ?? (Number.isFinite(defaultMax) ? defaultMax : 100);
  const skipSuccessfulRequests = config?.skipSuccessfulRequests ?? false;
  const skipFailedRequests = config?.skipFailedRequests ?? false;

  // Clean up old entries periodically and unref so Jest tests do not hang
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore.entries()) {
      if (entry.resetTime < now) {
        rateLimitStore.delete(key);
      }
    }
  }, windowMs);
  interval.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    // Skip rate limiting for exempt paths (health checks and capture hot-paths)
    if (isPathExempt(req.path)) {
      return next();
    }

    const clientId = (req as any).apiKeyId || req.ip || 'unknown';
    const normalizedPath = normalizePathForRateLimit(req.path);
    const key = `${req.method}:${normalizedPath}:${clientId}`;
    const now = Date.now();

    let entry = rateLimitStore.get(key);

    // Reset if window expired
    if (!entry || entry.resetTime < now) {
      if (rateLimitStore.size >= MAX_STORE_ENTRIES && !rateLimitStore.has(key)) {
        // Evict expired entries
        for (const [k, v] of rateLimitStore.entries()) {
          if (v.resetTime < now) {
            rateLimitStore.delete(k);
          }
        }
        // If still at or above cap, evict oldest
        while (rateLimitStore.size >= MAX_STORE_ENTRIES) {
          const oldestKey = rateLimitStore.keys().next().value;
          if (oldestKey !== undefined) {
            rateLimitStore.delete(oldestKey);
          } else {
            break;
          }
        }
      }

      entry = {
        count: 0,
        resetTime: now + windowMs,
      };
      rateLimitStore.set(key, entry);
    }

    // Increment counter
    entry.count++;

    // Set rate limit headers
    const remaining = Math.max(0, maxRequests - entry.count);
    const resetTime = new Date(entry.resetTime);

    res.setHeader('X-RateLimit-Limit', maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', remaining.toString());
    res.setHeader('X-RateLimit-Reset', resetTime.toISOString());

    // Check if limit exceeded
    if (entry.count > maxRequests) {
      const traceId = getCorrelationId(req);
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);

      logger.warn(
        { clientId, key, count: entry.count, limit: maxRequests, traceId },
        'rate limit exceeded'
      );

      return res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please try again later.',
          trace_id: traceId,
        },
        retryAfter,
      });
    }

    // Add a callback to potentially skip based on response
    const originalJson = res.json.bind(res);
    (res as any).json = function (body: any) {
      if (skipSuccessfulRequests && res.statusCode >= 200 && res.statusCode < 300) {
        entry!.count--;
      } else if (skipFailedRequests && res.statusCode >= 400) {
        entry!.count--;
      }
      return originalJson.call(this, body);
    };

    next();
  };
}

// Default API rate limiter using environment configuration
export const apiRateLimiter = createRateLimiter();

export const createApiRateLimiter = (maxRequests = 100) =>
  createRateLimiter({ windowMs: 60000, maxRequests });

export function resetRateLimitStore(): void {
  rateLimitStore.clear();
}

