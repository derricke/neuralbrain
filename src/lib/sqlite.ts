/**
 * Thin layer over Node's built-in `node:sqlite`.
 *
 * The brain used to depend on better-sqlite3, a native addon that needs an
 * install script to fetch or compile its binary. npm 11 blocks dependency
 * install scripts by default, so that made a plain `npm install` produce a
 * service that could not open its own database. `node:sqlite` ships with Node,
 * so there is nothing to build.
 *
 * `node:sqlite` has no `transaction()` or `pragma()` helpers, so the two that
 * the stores relied on are reproduced here with better-sqlite3's semantics.
 */
import { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';

/**
 * The slice of the API the stores use, typed the way better-sqlite3 typed it:
 * bind values are `unknown` and rows come back as `unknown`, so each store
 * keeps casting rows to its own record type. node:sqlite's own typings are
 * stricter (SQLInputValue / Record<string, SQLOutputValue>) and would need a
 * cast at every call site for no runtime difference.
 */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

export interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
  readonly isOpen: boolean;
  readonly isTransaction: boolean;
}

/**
 * better-sqlite3 waits up to 5 s for a lock by default; node:sqlite fails at
 * once. Keep the old behaviour so WAL contention (a read-only diagnosis
 * connection, a checkpoint) waits instead of surfacing as an error.
 */
export const BUSY_TIMEOUT_MS = 5000;

export interface OpenOptions {
  readOnly?: boolean;
}

export function openDatabase(filename: string, options: OpenOptions = {}): Database {
  const raw = new DatabaseSync(filename, {
    readOnly: options.readOnly ?? false,
    timeout: BUSY_TIMEOUT_MS,
  });
  return {
    prepare: (sql: string) => wrapStatement(raw.prepare(sql)),
    exec: (sql: string) => raw.exec(sql),
    close: () => raw.close(),
    get isOpen() {
      return raw.isOpen;
    },
    get isTransaction() {
      return raw.isTransaction;
    },
  };
}

/**
 * node:sqlite returns BLOB columns as Uint8Array; better-sqlite3 returned
 * Buffer. Rows (note embeddings included) reach API responses, where the two
 * serialise differently, and the stores type those columns as Buffer. Convert
 * on the way out: Buffer.from(arrayBuffer, offset, length) is a view over the
 * same memory, not a copy.
 */
function toBuffer(value: unknown): unknown {
  return value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : value;
}

function normalizeRow(row: unknown): unknown {
  if (!row || typeof row !== 'object') return row;
  const obj = row as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value instanceof Uint8Array) obj[key] = toBuffer(value);
  }
  return obj;
}

function wrapStatement(stmt: StatementSync): Statement {
  const params = (args: unknown[]) => args as SQLInputValue[];
  return {
    run: (...args: unknown[]) => stmt.run(...params(args)) as RunResult,
    get: (...args: unknown[]) => normalizeRow(stmt.get(...params(args))),
    all: (...args: unknown[]) => stmt.all(...params(args)).map(normalizeRow),
    iterate: function* (...args: unknown[]) {
      for (const row of stmt.iterate(...params(args))) yield normalizeRow(row);
    },
  };
}

/** Runs `PRAGMA <statement>` (e.g. `pragma(db, 'foreign_keys = ON')`). */
export function pragma(db: Database, statement: string): void {
  db.exec(`PRAGMA ${statement}`);
}

let savepointSeq = 0;

/**
 * Wraps `fn` so each call runs in a transaction, matching better-sqlite3's
 * `db.transaction(fn)`:
 *
 * - At top level the call runs inside BEGIN ... COMMIT and rolls back if `fn`
 *   throws.
 * - Called while a transaction is already open, it runs inside a SAVEPOINT, so
 *   a failure rolls back only this call and the outer transaction carries on.
 *   observationStore relies on this: one malformed observation is
 *   dead-lettered without discarding the rest of its batch (rule 3).
 * - `fn` must be synchronous; a transaction cannot span an await.
 */
export function transaction<A extends unknown[], R>(db: Database, fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    if (db.isTransaction) {
      const name = `nb_sp_${++savepointSeq}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = assertSync(fn(...args));
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (err) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw err;
      }
    }

    db.exec('BEGIN');
    try {
      const result = assertSync(fn(...args));
      db.exec('COMMIT');
      return result;
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  };
}

function assertSync<R>(result: R): R {
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    throw new TypeError('Transaction function cannot return a promise');
  }
  return result;
}
