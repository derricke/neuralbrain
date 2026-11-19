import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { logger } from './logger';
import { getDefaultSpoolDir } from './brainHome';

export const MAX_SPOOL_ATTEMPTS = 5;

export interface SpoolEntry {
  id: string;
  endpoint: string;
  payload: unknown;
  timestamp: number; // unix epoch in seconds
  attempts?: number;
}

export interface SpoolStats {
  count: number;
  bytes: number;
  maxBytes: number;
  maxAgeHours: number;
  oldestTimestamp: number | null;
}

function resolveSpoolDir(): string {
  const envPath = process.env.BRAIN_SPOOL_PATH?.trim();
  if (envPath) {
    if (envPath.startsWith('~/')) {
      return path.join(os.homedir(), envPath.slice(2));
    }
    return path.resolve(envPath);
  }
  return getDefaultSpoolDir();
}

function getSpoolFilePath(): string | null {
  const dir = resolveSpoolDir();
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        // ignore chmod failure on platforms that don't support posix permissions
      }
    } catch (err) {
      logger.error({ dir, error: err instanceof Error ? err.message : String(err) }, 'failed to create spool directory');
      return null;
    }
  }
  return path.join(dir, 'spool.jsonl');
}

function getLockFilePath(filePath: string): string {
  return path.join(path.dirname(filePath), 'spool.lock');
}

function tryAcquireLock(lockPath: string, staleMs = 30_000): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.closeSync(fd);
    return true;
  } catch (err: any) {
    if (err?.code !== 'EEXIST') {
      return false;
    }
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > staleMs) {
        fs.rmSync(lockPath, { force: true });
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.closeSync(fd);
        return true;
      }
    } catch {
      // Lock was released or removed concurrently
    }
    return false;
  }
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Fallback if SharedArrayBuffer is unavailable
  }
}

function acquireSpoolLockSync(lockPath: string, timeoutMs = 500): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (tryAcquireLock(lockPath)) return true;
    sleepSync(10);
  }
  return tryAcquireLock(lockPath);
}

async function acquireSpoolLockAsync(lockPath: string, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (tryAcquireLock(lockPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return tryAcquireLock(lockPath);
}

function releaseSpoolLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // ignore
  }
}

function getMaxBytes(): number {
  const val = process.env.BRAIN_SPOOL_MAX_BYTES;
  const parsed = val ? parseInt(val, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5242880; // default 5 MB
}

function getMaxAgeHours(): number {
  const val = process.env.BRAIN_SPOOL_MAX_AGE_HOURS;
  const parsed = val ? parseInt(val, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 168; // default 7 days
}

function computeEntryId(endpoint: string, payload: unknown): string {
  if (payload && typeof payload === 'object' && 'id' in payload && typeof (payload as any).id === 'string') {
    return `${endpoint}:${(payload as any).id}`;
  }
  const payloadStr = JSON.stringify(payload);
  const hash = createHash('sha256').update(`${endpoint}:${payloadStr}`).digest('hex').slice(0, 24);
  return `${endpoint}:${hash}`;
}

interface SpoolCache {
  filePath: string;
  mtimeMs: number;
  size: number;
  ids: Set<string>;
}

let activeSpoolCache: SpoolCache | null = null;

function updateIdCache(filePath: string, entries: SpoolEntry[]): void {
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      activeSpoolCache = {
        filePath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        ids: new Set(entries.map((e) => e.id)),
      };
      return;
    }
  } catch {
    // ignore
  }
  activeSpoolCache = {
    filePath,
    mtimeMs: 0,
    size: 0,
    ids: new Set(entries.map((e) => e.id)),
  };
}

function getActiveIds(filePath: string): Set<string> {
  if (!fs.existsSync(filePath)) {
    activeSpoolCache = { filePath, mtimeMs: 0, size: 0, ids: new Set() };
    return activeSpoolCache.ids;
  }

  try {
    const stat = fs.statSync(filePath);
    if (
      activeSpoolCache &&
      activeSpoolCache.filePath === filePath &&
      activeSpoolCache.mtimeMs === stat.mtimeMs &&
      activeSpoolCache.size === stat.size
    ) {
      return activeSpoolCache.ids;
    }
  } catch {
    // ignore stat error and reload
  }

  const entries = readSpool();
  if (!activeSpoolCache || activeSpoolCache.filePath !== filePath) {
    updateIdCache(filePath, entries);
  }
  return activeSpoolCache?.ids ?? new Set(entries.map((e) => e.id));
}

export function readSpool(): SpoolEntry[] {
  const filePath = getSpoolFilePath();
  if (!filePath) {
    return [];
  }
  if (!fs.existsSync(filePath)) {
    activeSpoolCache = { filePath, mtimeMs: 0, size: 0, ids: new Set() };
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  if (!content.trim()) {
    activeSpoolCache = { filePath, mtimeMs: 0, size: 0, ids: new Set() };
    return [];
  }

  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const now = Math.floor(Date.now() / 1000);
  const maxAgeHours = getMaxAgeHours();
  const cutoff = now - maxAgeHours * 3600;

  const validEntries: SpoolEntry[] = [];
  let expiredCount = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as SpoolEntry;
      if (entry.timestamp < cutoff || (entry.attempts ?? 0) >= MAX_SPOOL_ATTEMPTS) {
        expiredCount++;
      } else {
        validEntries.push(entry);
      }
    } catch {
      expiredCount++;
    }
  }

  // If expired, exhausted, or corrupted lines were found, prune the file
  if (expiredCount > 0) {
    writeSpoolEntries(validEntries);
  } else {
    updateIdCache(filePath, validEntries);
  }

  return validEntries;
}

function writeSpoolEntries(entries: SpoolEntry[]): void {
  const filePath = getSpoolFilePath();
  if (!filePath) {
    return;
  }
  const dir = path.dirname(filePath);

  if (entries.length === 0) {
    if (fs.existsSync(filePath)) {
      const tmpPath = path.join(
        dir,
        `.spool.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
      );
      fs.writeFileSync(tmpPath, '', { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmpPath, filePath);
    }
    updateIdCache(filePath, entries);
    return;
  }

  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const tmpPath = path.join(
    dir,
    `.spool.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`
  );
  fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  updateIdCache(filePath, entries);
}

export function appendSpool(endpoint: string, payload: unknown): boolean {
  const id = computeEntryId(endpoint, payload);
  const filePath = getSpoolFilePath();
  if (!filePath) {
    return false;
  }

  const lockPath = getLockFilePath(filePath);
  const locked = acquireSpoolLockSync(lockPath);
  try {
    // Fast in-memory deduplication check (CR-14)
    const activeIds = getActiveIds(filePath);
    if (activeIds.has(id)) {
      logger.debug({ id, endpoint }, 'duplicate entry already in spool, skipping append');
      return true;
    }

    const newEntry: SpoolEntry = {
      id,
      endpoint,
      payload,
      timestamp: Math.floor(Date.now() / 1000),
      attempts: 0,
    };

    const line = JSON.stringify(newEntry) + '\n';
    const lineBytes = Buffer.byteLength(line, 'utf-8');

    let currentBytes = 0;
    if (fs.existsSync(filePath)) {
      try {
        currentBytes = fs.statSync(filePath).size;
      } catch {
        currentBytes = 0;
      }
    }

    const maxBytes = getMaxBytes();
    if (currentBytes + lineBytes > maxBytes) {
      logger.warn({ currentBytes, lineBytes, maxBytes }, 'spool file full, rejecting write');
      return false;
    }

    fs.appendFileSync(filePath, line, { encoding: 'utf-8', mode: 0o600 });

    try {
      const stat = fs.statSync(filePath);
      activeIds.add(id);
      activeSpoolCache = {
        filePath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        ids: activeIds,
      };
    } catch {
      activeIds.add(id);
    }

    return true;
  } finally {
    if (locked) releaseSpoolLock(lockPath);
  }
}

let flushMutex: Promise<unknown> = Promise.resolve();

export function flushSpool(
  sendFn: (endpoint: string, payload: unknown) => Promise<boolean>
): Promise<{ flushed: number; remaining: number; droppedExpired: number; droppedMaxAttempts: number }> {
  const next = flushMutex.then(() => doFlushSpool(sendFn));
  flushMutex = next.catch(() => {});
  return next;
}

async function doFlushSpool(
  sendFn: (endpoint: string, payload: unknown) => Promise<boolean>
): Promise<{ flushed: number; remaining: number; droppedExpired: number; droppedMaxAttempts: number }> {
  const filePath = getSpoolFilePath();
  if (!filePath || !fs.existsSync(filePath)) {
    return { flushed: 0, remaining: 0, droppedExpired: 0, droppedMaxAttempts: 0 };
  }

  const rawContent = fs.readFileSync(filePath, 'utf-8');
  const rawLines = rawContent.split('\n').filter((l) => l.trim().length > 0);
  const now = Math.floor(Date.now() / 1000);
  const maxAgeHours = getMaxAgeHours();
  const cutoff = now - maxAgeHours * 3600;

  const validEntries: SpoolEntry[] = [];
  let droppedExpired = 0;
  let droppedMaxAttempts = 0;

  for (const line of rawLines) {
    try {
      const entry = JSON.parse(line) as SpoolEntry;
      if (entry.timestamp < cutoff) {
        droppedExpired++;
      } else if ((entry.attempts ?? 0) >= MAX_SPOOL_ATTEMPTS) {
        droppedMaxAttempts++;
      } else {
        validEntries.push(entry);
      }
    } catch {
      droppedExpired++;
    }
  }

  const snapshotIds = new Set(validEntries.map((e) => e.id));

  let flushed = 0;
  const remainingEntries: SpoolEntry[] = [];

  for (const entry of validEntries) {
    try {
      const success = await sendFn(entry.endpoint, entry.payload);
      if (success) {
        flushed++;
      } else {
        const nextAttempts = (entry.attempts ?? 0) + 1;
        if (nextAttempts < MAX_SPOOL_ATTEMPTS) {
          entry.attempts = nextAttempts;
          remainingEntries.push(entry);
        } else {
          droppedMaxAttempts++;
          logger.warn(
            { id: entry.id, endpoint: entry.endpoint, attempts: nextAttempts },
            'spool entry exceeded max attempts, dropping'
          );
        }
      }
    } catch {
      const nextAttempts = (entry.attempts ?? 0) + 1;
      if (nextAttempts < MAX_SPOOL_ATTEMPTS) {
        entry.attempts = nextAttempts;
        remainingEntries.push(entry);
      } else {
        droppedMaxAttempts++;
        logger.warn(
          { id: entry.id, endpoint: entry.endpoint, attempts: nextAttempts },
          'spool entry exceeded max attempts, dropping'
        );
      }
    }
  }

  // Advisory lock around read-merge-rename window so concurrent hook appends aren't overwritten
  const lockPath = getLockFilePath(filePath);
  const locked = await acquireSpoolLockAsync(lockPath);
  let finalRemaining: SpoolEntry[];
  try {
    // Re-read file to capture entries appended concurrently during network I/O
    const newlyAppended: SpoolEntry[] = [];
    if (fs.existsSync(filePath)) {
      try {
        const currentContent = fs.readFileSync(filePath, 'utf-8');
        const currentLines = currentContent.split('\n').filter((l) => l.trim().length > 0);
        for (const line of currentLines) {
          try {
            const entry = JSON.parse(line) as SpoolEntry;
            if (!snapshotIds.has(entry.id) && entry.timestamp >= cutoff) {
              newlyAppended.push(entry);
            }
          } catch {
            // ignore corrupted lines
          }
        }
      } catch {
        // ignore read error
      }
    }

    finalRemaining = [...remainingEntries, ...newlyAppended];
    writeSpoolEntries(finalRemaining);
  } finally {
    if (locked) releaseSpoolLock(lockPath);
  }

  return {
    flushed,
    remaining: finalRemaining.length,
    droppedExpired,
    droppedMaxAttempts,
  };
}

export function getSpoolStats(): SpoolStats {
  const entries = readSpool();
  const filePath = getSpoolFilePath();

  let bytes = 0;
  if (filePath && fs.existsSync(filePath)) {
    bytes = fs.statSync(filePath).size;
  }

  let oldestTimestamp: number | null = null;
  for (const entry of entries) {
    if (oldestTimestamp === null || entry.timestamp < oldestTimestamp) {
      oldestTimestamp = entry.timestamp;
    }
  }

  return {
    count: entries.length,
    bytes,
    maxBytes: getMaxBytes(),
    maxAgeHours: getMaxAgeHours(),
    oldestTimestamp,
  };
}
