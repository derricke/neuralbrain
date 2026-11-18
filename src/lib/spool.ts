import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { logger } from './logger';
import { getDefaultSpoolDir } from './brainHome';

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

function getSpoolFilePath(): string {
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
    }
  }
  return path.join(dir, 'spool.jsonl');
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
      if (entry.timestamp < cutoff) {
        expiredCount++;
      } else {
        validEntries.push(entry);
      }
    } catch {
      expiredCount++;
    }
  }

  // If expired or corrupted lines were found, prune the file
  if (expiredCount > 0) {
    writeSpoolEntries(validEntries);
  } else {
    updateIdCache(filePath, validEntries);
  }

  return validEntries;
}

function writeSpoolEntries(entries: SpoolEntry[]): void {
  const filePath = getSpoolFilePath();
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
}

let flushMutex: Promise<unknown> = Promise.resolve();

export function flushSpool(
  sendFn: (endpoint: string, payload: unknown) => Promise<boolean>
): Promise<{ flushed: number; remaining: number; droppedExpired: number }> {
  const next = flushMutex.then(() => doFlushSpool(sendFn));
  flushMutex = next.catch(() => {});
  return next;
}

async function doFlushSpool(
  sendFn: (endpoint: string, payload: unknown) => Promise<boolean>
): Promise<{ flushed: number; remaining: number; droppedExpired: number }> {
  const filePath = getSpoolFilePath();
  if (!fs.existsSync(filePath)) {
    return { flushed: 0, remaining: 0, droppedExpired: 0 };
  }

  const rawContent = fs.readFileSync(filePath, 'utf-8');
  const rawLines = rawContent.split('\n').filter((l) => l.trim().length > 0);
  const now = Math.floor(Date.now() / 1000);
  const maxAgeHours = getMaxAgeHours();
  const cutoff = now - maxAgeHours * 3600;

  const validEntries: SpoolEntry[] = [];
  let droppedExpired = 0;

  for (const line of rawLines) {
    try {
      const entry = JSON.parse(line) as SpoolEntry;
      if (entry.timestamp < cutoff) {
        droppedExpired++;
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
        entry.attempts = (entry.attempts ?? 0) + 1;
        remainingEntries.push(entry);
      }
    } catch {
      entry.attempts = (entry.attempts ?? 0) + 1;
      remainingEntries.push(entry);
    }
  }

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

  const finalRemaining = [...remainingEntries, ...newlyAppended];
  writeSpoolEntries(finalRemaining);

  return {
    flushed,
    remaining: finalRemaining.length,
    droppedExpired,
  };
}

export function getSpoolStats(): SpoolStats {
  const entries = readSpool();
  const filePath = getSpoolFilePath();

  let bytes = 0;
  if (fs.existsSync(filePath)) {
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
