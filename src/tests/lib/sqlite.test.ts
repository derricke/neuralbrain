import fs from 'fs';
import os from 'os';
import path from 'path';
import { BUSY_TIMEOUT_MS, openDatabase, pragma, transaction, Database } from '../../lib/sqlite';

describe('node:sqlite layer', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  });

  afterEach(() => {
    if (db.isOpen) db.close();
  });

  const count = () => (db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n;

  test('commits on success and passes arguments and return value through', () => {
    const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
    const addAll = transaction(db, (values: string[]) => {
      for (const v of values) insert.run(v);
      return values.length;
    });

    expect(addAll(['a', 'b', 'c'])).toBe(3);
    expect(count()).toBe(3);
    expect(db.isTransaction).toBe(false);
  });

  test('rolls back everything when the function throws', () => {
    const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
    const failing = transaction(db, () => {
      insert.run('a');
      throw new Error('boom');
    });

    expect(() => failing()).toThrow('boom');
    expect(count()).toBe(0);
    expect(db.isTransaction).toBe(false);
  });

  test('a failing nested call rolls back only itself; the outer transaction commits', () => {
    // The observationStore pattern: one bad row is dead-lettered, the batch survives.
    const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
    const insertOne = transaction(db, (v: string | null) => {
      insert.run(v); // NOT NULL constraint fails for null
    });
    const batch = transaction(db, (values: Array<string | null>) => {
      const rejected: number[] = [];
      values.forEach((v, i) => {
        try {
          insertOne(v);
        } catch {
          rejected.push(i);
        }
      });
      return rejected;
    });

    expect(batch(['a', null, 'c'])).toEqual([1]);
    expect((db.prepare('SELECT v FROM t ORDER BY id').all() as Array<{ v: string }>).map((r) => r.v)).toEqual([
      'a',
      'c',
    ]);
  });

  test('a nested failure that is not caught rolls back the outer transaction too', () => {
    const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
    const inner = transaction(db, () => {
      insert.run('inner');
      throw new Error('inner failed');
    });
    const outer = transaction(db, () => {
      insert.run('outer');
      inner();
    });

    expect(() => outer()).toThrow('inner failed');
    expect(count()).toBe(0);
    expect(db.isTransaction).toBe(false);
  });

  test('rejects an async function instead of committing half a transaction', () => {
    const insert = db.prepare('INSERT INTO t (v) VALUES (?)');
    const asyncTx = transaction(db, async () => {
      insert.run('a');
    });

    expect(() => asyncTx()).toThrow('Transaction function cannot return a promise');
    expect(count()).toBe(0);
    expect(db.isTransaction).toBe(false);
  });

  test('pragma() runs PRAGMA statements', () => {
    pragma(db, 'foreign_keys = OFF');
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(0);
    pragma(db, 'foreign_keys = ON');
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
  });

  test('opens files with a busy timeout and supports WAL and read-only connections', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-sqlite-'));
    try {
      const file = path.join(dir, 'brain.db');
      const writer = openDatabase(file);
      pragma(writer, 'journal_mode = WAL');
      expect((writer.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(BUSY_TIMEOUT_MS);
      expect((writer.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
      writer.exec("CREATE TABLE x (v TEXT); INSERT INTO x VALUES ('hi')");

      const reader = openDatabase(file, { readOnly: true });
      expect(reader.prepare('SELECT v FROM x').get()).toEqual({ v: 'hi' });
      expect(() => reader.exec("INSERT INTO x VALUES ('no')")).toThrow();
      reader.close();
      writer.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('BLOBs round-trip as bytes that decode back into a Float32Array', () => {
    db.exec('CREATE TABLE e (v BLOB)');
    const vector = new Float32Array([0.25, -1.5, 3]);
    db.prepare('INSERT INTO e VALUES (?)').run(Buffer.from(vector.buffer));
    const blob = (db.prepare('SELECT v FROM e').get() as { v: Buffer }).v;
    // Same type better-sqlite3 returned, so API responses serialise the same way.
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(Buffer.isBuffer((db.prepare('SELECT v FROM e').all() as Array<{ v: Buffer }>)[0].v)).toBe(true);
    expect(Buffer.isBuffer([...db.prepare('SELECT v FROM e').iterate()].map((r) => (r as { v: Buffer }).v)[0])).toBe(true);
    const decoded = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / Float32Array.BYTES_PER_ELEMENT);
    expect(Array.from(decoded)).toEqual([0.25, -1.5, 3]);
  });
});
