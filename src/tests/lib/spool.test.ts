import fs from 'fs';
import path from 'path';
import { appendSpool, readSpool, flushSpool, getSpoolStats, MAX_SPOOL_ATTEMPTS } from '../../lib/spool';

const TEST_SPOOL_DIR = path.join(process.cwd(), 'data', 'test-spool');

beforeEach(() => {
  process.env.BRAIN_SPOOL_PATH = TEST_SPOOL_DIR;
  process.env.BRAIN_SPOOL_MAX_BYTES = '10000';
  process.env.BRAIN_SPOOL_MAX_AGE_HOURS = '24';
  if (fs.existsSync(TEST_SPOOL_DIR)) {
    fs.rmSync(TEST_SPOOL_DIR, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (fs.existsSync(TEST_SPOOL_DIR)) {
    fs.rmSync(TEST_SPOOL_DIR, { recursive: true, force: true });
  }
});

describe('spool', () => {
  it('appends and reads spool entries with deduplication', () => {
    const payload = { id: 'obs-1', text: 'hello' };

    const appended1 = appendSpool('/capture/observations', payload);
    expect(appended1).toBe(true);

    // Duplicate append should not duplicate entry in spool
    const appended2 = appendSpool('/capture/observations', payload);
    expect(appended2).toBe(true);

    const entries = readSpool();
    expect(entries).toHaveLength(1);
    expect(entries[0].endpoint).toBe('/capture/observations');
    expect(entries[0].payload).toEqual(payload);
  });

  it('reports spool stats accurately', () => {
    appendSpool('/capture/observations', { id: 'obs-1', val: 1 });
    appendSpool('/capture/observations', { id: 'obs-2', val: 2 });

    const stats = getSpoolStats();
    expect(stats.count).toBe(2);
    expect(stats.bytes).toBeGreaterThan(0);
    expect(stats.maxBytes).toBe(10000);
    expect(stats.maxAgeHours).toBe(24);
    expect(stats.oldestTimestamp).toBeGreaterThan(0);
  });

  it('flushes spool successfully calling sendFn', async () => {
    appendSpool('/capture/observations', { id: 'obs-1', val: 'success' });
    appendSpool('/capture/observations', { id: 'obs-2', val: 'fail' });

    const sentEndpoints: string[] = [];
    const result = await flushSpool(async (endpoint, payload: any) => {
      sentEndpoints.push(endpoint);
      return payload.val === 'success';
    });

    expect(result.flushed).toBe(1);
    expect(result.remaining).toBe(1);
    expect(sentEndpoints).toHaveLength(2);

    const remaining = readSpool();
    expect(remaining).toHaveLength(1);
    expect((remaining[0].payload as any).id).toBe('obs-2');
  });

  it('rejects append when max bytes would be exceeded', () => {
    process.env.BRAIN_SPOOL_MAX_BYTES = '200'; // small limit

    const ok = appendSpool('/endpoint', { msg: 'short' });
    expect(ok).toBe(true);

    const tooBig = appendSpool('/endpoint', { msg: 'A'.repeat(500) });
    expect(tooBig).toBe(false);
  });

  it('drops entries after MAX_SPOOL_ATTEMPTS failures', async () => {
    appendSpool('/capture/observations', { id: 'obs-perm-fail', val: 'bad' });

    for (let i = 1; i < MAX_SPOOL_ATTEMPTS; i++) {
      const res = await flushSpool(async () => false);
      expect(res.flushed).toBe(0);
      expect(res.remaining).toBe(1);
      expect(res.droppedMaxAttempts).toBe(0);
    }

    const finalRes = await flushSpool(async () => false);
    expect(finalRes.flushed).toBe(0);
    expect(finalRes.remaining).toBe(0);
    expect(finalRes.droppedMaxAttempts).toBe(1);
    expect(readSpool()).toHaveLength(0);
  });

  it('preserves entries appended concurrently during flushSpool', async () => {
    appendSpool('/capture/observations', { id: 'obs-initial', val: 1 });

    const res = await flushSpool(async () => {
      // Simulate concurrent hook append while network I/O is in flight
      appendSpool('/capture/observations', { id: 'obs-concurrent', val: 2 });
      return true;
    });

    expect(res.flushed).toBe(1);
    expect(res.remaining).toBe(1);
    const remaining = readSpool();
    expect(remaining).toHaveLength(1);
    expect((remaining[0].payload as any).id).toBe('obs-concurrent');
  });

  it('handles mkdirSync failure cleanly without throwing', () => {
    // Point BRAIN_SPOOL_PATH inside a regular file so mkdirSync fails with ENOTDIR
    const blockingFile = path.join(TEST_SPOOL_DIR, 'not-a-dir');
    fs.mkdirSync(TEST_SPOOL_DIR, { recursive: true });
    fs.writeFileSync(blockingFile, 'file', 'utf8');
    process.env.BRAIN_SPOOL_PATH = path.join(blockingFile, 'spool');

    expect(appendSpool('/capture/observations', { id: 'obs-fail-dir' })).toBe(false);
    expect(readSpool()).toEqual([]);
    expect(getSpoolStats().count).toBe(0);
  });
});
