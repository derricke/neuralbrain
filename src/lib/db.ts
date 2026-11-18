import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger';
import { getDefaultDbPath } from './brainHome';
import { Database, openDatabase, pragma, transaction } from './sqlite';

let _db: Database | null = null;

export class DatabaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

export function isDatabaseUnavailableError(error: unknown): error is DatabaseUnavailableError {
  return error instanceof DatabaseUnavailableError;
}

/**
 * The database file is opened by the brain service and by nothing else.
 *
 * A direct writer bypasses scope validation, the failure-pattern UPSERT,
 * dead-letter routing and — worst of all — the embed queue, so a hand-inserted
 * row exists in SQLite and never in Qdrant. That is silent partial state, which
 * is precisely what rule 2 exists to prevent. Repair goes through the service
 * (see docs/API.md, POST /maintenance/*), never through `sqlite3`.
 *
 * Under test, opening the real file would mutate live data, so it is refused
 * outright rather than warned about. Tests use ':memory:' or a path under a
 * temp directory.
 */
function assertPathAllowed(dbPath: string): void {
  if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) return;
  if (dbPath === ':memory:' || dbPath.startsWith('file::memory:')) return;

  const resolved = path.resolve(dbPath);
  const tmp = path.resolve(os.tmpdir());
  if (resolved.startsWith(tmp + path.sep)) return;

  throw new Error(
    `Refusing to open '${resolved}' from a test run. Tests must not touch a real database: ` +
      `set DATABASE_URL=':memory:' or a path under ${tmp}. ` +
      `(Set BRAIN_ALLOW_TEST_DB_PATH=1 only if you genuinely mean to write to this file.)`
  );
}

export function getDbPath(): string {
  const configuredPath = process.env.DATABASE_URL?.trim();
  return configuredPath ? configuredPath : getDefaultDbPath();
}

export function getDb(): Database {
  if (_db) return _db;

  const dbPath = getDbPath();

  if (process.env.BRAIN_ALLOW_TEST_DB_PATH !== '1') {
    assertPathAllowed(dbPath);
  }

  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        logger.error({ dir, error: err instanceof Error ? err.message : String(err) }, 'failed to create db directory');
      }
    }
  }

  try {
    _db = openDatabase(dbPath);
  } catch (error) {
    logger.error(
      {
        path: dbPath,
        error: error instanceof Error ? error.message : String(error),
      },
      'database open failed'
    );

    throw new DatabaseUnavailableError(
      'Database is unavailable. Check DATABASE_URL and ensure the database directory exists.'
    );
  }

  pragma(_db, 'journal_mode = WAL');
  pragma(_db, 'foreign_keys = ON');

  logger.info({ path: dbPath }, 'database opened');

  runMigrations(_db);

  return _db;
}

export function resetDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      // ignore close errors during reset
    }
    _db = null;
  }
}

export function initDb(): void {
  getDb();
  logger.info('database initialized');
}

/**
 * Trajectory DDL lives in constants because two things need it: the normal
 * `CREATE TABLE IF NOT EXISTS` pass, and `alignTrajectorySchema` below, which
 * rebuilds an already-created table whose `success` column is still
 * `NOT NULL`. SQLite cannot relax a column constraint in place.
 *
 * `success` is nullable, and NULL means *unknown*. A rollup produced by the
 * idle sweeper has no outcome signal: 0 would assert the task failed and 1
 * would assert it succeeded, and neither is a thing anybody observed. The
 * CHECK still rejects any value other than 0, 1 or NULL (a CHECK is satisfied
 * by NULL, which is exactly the behaviour wanted here).
 *
 * `rollup_source` records *how* the row came to exist — 'signalled' when a
 * client closed the task explicitly, 'swept' when the sweeper found the
 * session abandoned. Those mean different things when injecting prior
 * outcomes, so they must be distinguishable in SQL.
 */
const TRAJECTORIES_DDL = `
  CREATE TABLE IF NOT EXISTS trajectories (
    id            TEXT PRIMARY KEY,
    scope         TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
    project_id    TEXT,
    note_ref      TEXT,
    task_ref      TEXT,
    session_id    TEXT,
    task_type     TEXT,
    agent         TEXT,
    description   TEXT NOT NULL,
    result        TEXT,
    success       INTEGER CHECK (success IN (0,1)),   -- NULL = unknown outcome
    rollup_source TEXT CHECK (rollup_source IN ('signalled','swept')),
    tool_calls    INTEGER NOT NULL DEFAULT 0,
    retries       INTEGER NOT NULL DEFAULT 0,
    duration_ms   INTEGER NOT NULL DEFAULT 0,
    embedding     BLOB,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    archived_at   INTEGER,
    CHECK ((scope = 'project') = (project_id IS NOT NULL))
  );
`;

const TRAJECTORIES_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_traj_project  ON trajectories(project_id);
  CREATE INDEX IF NOT EXISTS idx_traj_scope    ON trajectories(scope);
  CREATE INDEX IF NOT EXISTS idx_traj_type     ON trajectories(task_type);
  CREATE INDEX IF NOT EXISTS idx_traj_created  ON trajectories(created_at);
  CREATE INDEX IF NOT EXISTS idx_traj_success  ON trajectories(success, created_at);
  CREATE INDEX IF NOT EXISTS idx_traj_note     ON trajectories(note_ref);
  CREATE INDEX IF NOT EXISTS idx_traj_session  ON trajectories(session_id);
  CREATE INDEX IF NOT EXISTS idx_traj_rollup   ON trajectories(rollup_source);
`;

/**
 * The archive mirrors the live table, including the nullability. A
 * non-nullable archive column next to a nullable live one is a bug this
 * project has already been bitten by: `trajectory_archive.swarm_id NOT NULL`
 * meant exactly the records the scope rule tells us to allow were the ones
 * that failed to archive at 30 days.
 */
const TRAJECTORY_ARCHIVE_DDL = `
  CREATE TABLE IF NOT EXISTS trajectory_archive (
    id                     TEXT PRIMARY KEY,
    original_trajectory_id TEXT NOT NULL UNIQUE,
    scope                  TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
    project_id             TEXT,
    note_ref               TEXT,
    task_ref               TEXT,
    session_id             TEXT,
    task_type              TEXT,
    agent                  TEXT,
    description            TEXT NOT NULL,
    result                 TEXT,
    success                INTEGER CHECK (success IN (0,1)),   -- NULL = unknown
    rollup_source          TEXT CHECK (rollup_source IN ('signalled','swept')),
    tool_calls             INTEGER NOT NULL DEFAULT 0,
    retries                INTEGER NOT NULL DEFAULT 0,
    duration_ms            INTEGER NOT NULL DEFAULT 0,
    embedding              BLOB,
    created_at             INTEGER NOT NULL,
    archived_at            INTEGER NOT NULL,
    CHECK ((scope = 'project') = (project_id IS NOT NULL))
  );
`;

const TRAJECTORY_ARCHIVE_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_traj_arc_project   ON trajectory_archive(project_id);
  CREATE INDEX IF NOT EXISTS idx_traj_arc_scope     ON trajectory_archive(scope);
  CREATE INDEX IF NOT EXISTS idx_traj_arc_archived  ON trajectory_archive(archived_at);
  CREATE INDEX IF NOT EXISTS idx_traj_arc_session   ON trajectory_archive(session_id);
`;

interface ColumnInfo {
  name: string;
  notnull: number;
}

function tableColumns(db: Database, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

/**
 * Bring an already-created trajectory table up to the DDL above.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
 * table, so a schema change that only edits those statements reaches fresh
 * checkouts and silently misses every existing store — the connection would
 * then insert rows the service believes cannot exist. Both steps are
 * idempotent and safe to run on every open.
 */
function alignTrajectorySchema(
  db: Database,
  table: 'trajectories' | 'trajectory_archive',
  createDdl: string,
  indexDdl: string
): void {
  // 1. Additive columns. Backfill only when the column has just appeared:
  //    every pre-existing row is, by definition, an explicit rollup.
  const addColumns: Array<{ name: string; ddl: string; backfill?: string }> = [
    { name: 'session_id', ddl: 'TEXT' },
    {
      name: 'rollup_source',
      ddl: "TEXT CHECK (rollup_source IN ('signalled','swept'))",
      backfill: `UPDATE ${table} SET rollup_source = 'signalled' WHERE rollup_source IS NULL`,
    },
    { name: 'tool_calls', ddl: 'INTEGER NOT NULL DEFAULT 0' },
  ];

  const existing = new Set(tableColumns(db, table).map((c) => c.name));
  for (const col of addColumns) {
    if (existing.has(col.name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.ddl}`);
    if (col.backfill) db.exec(col.backfill);
    logger.info({ table, column: col.name }, 'trajectory schema: column added');
  }

  // 2. Relax success to nullable. SQLite has no "ALTER COLUMN", so this is the
  //    documented rebuild: rename, recreate, copy, drop, re-index.
  const success = tableColumns(db, table).find((c) => c.name === 'success');
  if (!success || success.notnull === 0) {
    db.exec(indexDdl);
    return;
  }

  const legacy = `${table}_legacy_notnull`;
  db.exec(`DROP TABLE IF EXISTS ${legacy}`);
  pragma(db, 'foreign_keys = OFF');
  try {
    transaction(db, () => {
      db.exec(`ALTER TABLE ${table} RENAME TO ${legacy}`);
      db.exec(createDdl);
      const oldCols = new Set(tableColumns(db, legacy).map((c) => c.name));
      const shared = tableColumns(db, table)
        .map((c) => c.name)
        .filter((name) => oldCols.has(name));
      const list = shared.join(', ');
      db.exec(`INSERT INTO ${table} (${list}) SELECT ${list} FROM ${legacy}`);
      db.exec(`DROP TABLE ${legacy}`);
      db.exec(indexDdl);
    })();
    logger.info({ table }, 'trajectory schema: success relaxed to nullable (NULL = unknown)');
  } finally {
    pragma(db, 'foreign_keys = ON');
  }
}

const NOTES_DDL = `
  CREATE TABLE IF NOT EXISTS notes (
    id           TEXT PRIMARY KEY,
    scope        TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
    project_id   TEXT,
    session_id   TEXT,
    type         TEXT NOT NULL CHECK (type IN
                   ('fact','architecture','pattern','workflow','bug','preference','lesson')),
    title        TEXT NOT NULL,
    content      TEXT NOT NULL,
    author       TEXT,
    author_kind  TEXT CHECK (author_kind IN ('human','agent')),
    version      INTEGER NOT NULL DEFAULT 1,
    supersedes   TEXT REFERENCES notes(id),
    is_latest    INTEGER NOT NULL DEFAULT 1,
    embedding    BLOB,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    CHECK ((scope = 'project') = (project_id IS NOT NULL))
  );
`;

const NOTES_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_notes_project   ON notes(project_id);
  CREATE INDEX IF NOT EXISTS idx_notes_scope     ON notes(scope);
  CREATE INDEX IF NOT EXISTS idx_notes_type      ON notes(type);
  CREATE INDEX IF NOT EXISTS idx_notes_latest    ON notes(is_latest, updated_at);
  CREATE INDEX IF NOT EXISTS idx_notes_session   ON notes(session_id);
`;

function alignNotesSchema(db: Database): void {
  const existing = new Set(tableColumns(db, 'notes').map((c) => c.name));
  if (!existing.has('session_id')) {
    db.exec('ALTER TABLE notes ADD COLUMN session_id TEXT');
    logger.info({ table: 'notes', column: 'session_id' }, 'notes schema: column added');
  }

  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes'")
    .get() as { sql?: string } | undefined;

  if (row?.sql && !row.sql.includes("'lesson'")) {
    const legacy = 'notes_legacy_type';
    db.exec(`DROP TABLE IF EXISTS ${legacy}`);
    pragma(db, 'foreign_keys = OFF');
    try {
      transaction(db, () => {
        db.exec(`ALTER TABLE notes RENAME TO ${legacy}`);
        db.exec(NOTES_DDL);
        const oldCols = new Set(tableColumns(db, legacy).map((c) => c.name));
        const shared = tableColumns(db, 'notes')
          .map((c) => c.name)
          .filter((name) => oldCols.has(name));
        const list = shared.join(', ');
        db.exec(`INSERT INTO notes (${list}) SELECT ${list} FROM ${legacy}`);
        db.exec(`DROP TABLE ${legacy}`);
      })();
      logger.info({ table: 'notes' }, "notes schema: type CHECK updated to include 'lesson'");
    } finally {
      pragma(db, 'foreign_keys = ON');
    }
  }

  db.exec(NOTES_INDEX_DDL);
}

function alignFailurePatternsSchema(db: Database): void {
  const existing = new Set(tableColumns(db, 'failure_patterns').map((c) => c.name));
  if (!existing.has('session_id')) {
    db.exec('ALTER TABLE failure_patterns ADD COLUMN session_id TEXT');
    logger.info(
      { table: 'failure_patterns', column: 'session_id' },
      'failure_patterns schema: column added'
    );
  }
}

function runMigrations(db: Database): void {
  db.exec(`
    -- store_meta (single row id = 1)
    CREATE TABLE IF NOT EXISTS store_meta (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version  INTEGER NOT NULL,
      embed_tier      TEXT    NOT NULL,          -- none|local|remote|vendor
      embed_model     TEXT    NOT NULL,          -- configured name
      embed_model_id  TEXT,                      -- as REPORTED by the endpoint; compare this
      embed_dim       INTEGER NOT NULL,
      doc_prefix      TEXT    NOT NULL DEFAULT '',
      query_prefix    TEXT    NOT NULL DEFAULT '',
      pooling         TEXT    NOT NULL DEFAULT 'mean',
      normalize       INTEGER NOT NULL DEFAULT 1,
      qdrant_alias    TEXT    NOT NULL DEFAULT 'brain',
      set_at          INTEGER NOT NULL DEFAULT (unixepoch())
    );

    -- observations
    CREATE TABLE IF NOT EXISTS observations (
      id           TEXT PRIMARY KEY,
      scope        TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
      project_id   TEXT,
      note_ref     TEXT,                          -- -> notes.id, optional
      task_ref     TEXT,                          -- provenance only, not a scope filter
      session_id   TEXT,
      agent        TEXT,
      kind         TEXT NOT NULL CHECK (kind IN ('tool_call','prompt')),
      tool_name    TEXT,
      file_path    TEXT,                           -- the tool's TARGET path, nothing else
      input        TEXT,
      output       TEXT,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      failed       INTEGER NOT NULL DEFAULT 0,     -- set by the failure hook, never inferred
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      archived_at  INTEGER,
      CHECK ((scope = 'project') = (project_id IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_obs_project   ON observations(project_id);
    CREATE INDEX IF NOT EXISTS idx_obs_scope     ON observations(scope);
    CREATE INDEX IF NOT EXISTS idx_obs_session   ON observations(session_id);
    CREATE INDEX IF NOT EXISTS idx_obs_created   ON observations(created_at);
    CREATE INDEX IF NOT EXISTS idx_obs_note      ON observations(note_ref);
    CREATE INDEX IF NOT EXISTS idx_obs_task      ON observations(task_ref);
    CREATE INDEX IF NOT EXISTS idx_obs_file      ON observations(file_path);
    CREATE INDEX IF NOT EXISTS idx_obs_failed    ON observations(failed, created_at);
    CREATE INDEX IF NOT EXISTS idx_observations_archived ON observations(archived_at);

    -- observations_archive
    CREATE TABLE IF NOT EXISTS observations_archive (
      id                      TEXT PRIMARY KEY,
      original_observation_id TEXT NOT NULL UNIQUE,
      scope                   TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
      project_id              TEXT,
      note_ref                TEXT,
      task_ref                TEXT,
      session_id              TEXT,
      agent                   TEXT,
      kind                    TEXT NOT NULL CHECK (kind IN ('tool_call','prompt')),
      tool_name               TEXT,
      file_path               TEXT,
      input                   TEXT,
      output                  TEXT,
      duration_ms             INTEGER NOT NULL DEFAULT 0,
      failed                  INTEGER NOT NULL DEFAULT 0,
      created_at              INTEGER NOT NULL,
      archived_at             INTEGER NOT NULL,
      CHECK ((scope = 'project') = (project_id IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_obs_arc_project   ON observations_archive(project_id);
    CREATE INDEX IF NOT EXISTS idx_obs_arc_scope     ON observations_archive(scope);
    CREATE INDEX IF NOT EXISTS idx_obs_arc_archived  ON observations_archive(archived_at);

    -- trajectories (DDL in TRAJECTORIES_DDL; see alignTrajectorySchema)
    ${TRAJECTORIES_DDL}
    ${TRAJECTORY_ARCHIVE_DDL}

    -- notes (DDL in NOTES_DDL; see alignNotesSchema)
    ${NOTES_DDL}

    CREATE TABLE IF NOT EXISTS note_concepts (
      note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      concept  TEXT NOT NULL,
      PRIMARY KEY (note_id, concept)
    );

    CREATE TABLE IF NOT EXISTS note_files (
      note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      file_path  TEXT NOT NULL,
      PRIMARY KEY (note_id, file_path)
    );

    CREATE INDEX IF NOT EXISTS idx_note_concepts_c ON note_concepts(concept);
    CREATE INDEX IF NOT EXISTS idx_note_files_f    ON note_files(file_path);

    -- failure_patterns
    CREATE TABLE IF NOT EXISTS failure_patterns (
      id             TEXT PRIMARY KEY,
      scope          TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
      project_id     TEXT,
      session_id     TEXT,
      task_type      TEXT NOT NULL DEFAULT 'unknown',
      error_text     TEXT NOT NULL,
      count          INTEGER NOT NULL DEFAULT 1,
      first_seen_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      CHECK ((scope = 'project') = (project_id IS NOT NULL)),
      UNIQUE (project_id, task_type, error_text)
    );

    -- sessions
    CREATE TABLE IF NOT EXISTS sessions (
      id                 TEXT PRIMARY KEY,
      scope              TEXT NOT NULL DEFAULT 'unknown' CHECK(scope IN ('project','global','unknown')),
      project_id         TEXT,
      agent_name         TEXT,
      cwd                TEXT,
      status             TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed','abandoned')),
      started_at         TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at           TEXT,
      summary            TEXT,
      files_touched_json TEXT,
      handoff_summary_id TEXT,
      CHECK ((scope = 'project') = (project_id IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_proj_status ON sessions(project_id, status, started_at);

    -- actions
    CREATE TABLE IF NOT EXISTS actions (
      id                     TEXT PRIMARY KEY,
      session_id             TEXT,
      scope                  TEXT NOT NULL DEFAULT 'unknown' CHECK(scope IN ('project','global','unknown')),
      project_id             TEXT,
      title                  TEXT NOT NULL,
      description            TEXT,
      status                 TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','blocked','in_progress','done','dismissed')),
      priority               TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
      blocked_reason         TEXT,
      files_json             TEXT,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at            TEXT,
      resolved_by_session_id TEXT,
      CHECK ((scope = 'project') = (project_id IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_actions_proj_status ON actions(project_id, status, priority);

    CREATE INDEX IF NOT EXISTS idx_fp_lookup ON failure_patterns(project_id, task_type, count DESC);
    CREATE INDEX IF NOT EXISTS idx_fp_recent ON failure_patterns(last_seen_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fp_unique_coalesce ON failure_patterns(COALESCE(project_id, '__GLOBAL_OR_UNKNOWN__:' || scope), task_type, error_text);

    -- summaries
    CREATE TABLE IF NOT EXISTS summaries (
      id              TEXT PRIMARY KEY,
      scope           TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
      project_id      TEXT,
      kind            TEXT NOT NULL CHECK (kind IN ('session','rollup','failure_digest')),
      window_from     INTEGER,
      window_to       INTEGER,
      outcome         TEXT CHECK (outcome IN ('success','failure','unknown')),
      producer_tier   TEXT NOT NULL,        -- agent|remote|vendor
      producer_model  TEXT,                 -- null for 'agent'
      prompt_version  TEXT NOT NULL,
      verified        INTEGER NOT NULL DEFAULT 0,
      version         INTEGER NOT NULL DEFAULT 1,
      supersedes      TEXT REFERENCES summaries(id),
      is_latest       INTEGER NOT NULL DEFAULT 1,
      sources_expired INTEGER NOT NULL DEFAULT 0,
      embedding       BLOB,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      CHECK ((scope = 'project') = (project_id IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS summary_claims (
      id          TEXT PRIMARY KEY,
      summary_id  TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
      text        TEXT NOT NULL,
      ordinal     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS summary_sources (
      summary_id  TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
      claim_id    TEXT REFERENCES summary_claims(id) ON DELETE CASCADE,
      record_id   TEXT NOT NULL,
      grain       TEXT NOT NULL CHECK (grain IN ('observation','trajectory','note')),
      PRIMARY KEY (summary_id, claim_id, record_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sum_project  ON summaries(project_id);
    CREATE INDEX IF NOT EXISTS idx_sum_kind     ON summaries(kind, created_at);
    CREATE INDEX IF NOT EXISTS idx_sum_latest   ON summaries(is_latest);
    CREATE INDEX IF NOT EXISTS idx_sum_producer ON summaries(producer_tier, producer_model);
    CREATE INDEX IF NOT EXISTS idx_sum_src_rec  ON summary_sources(record_id);

    -- consolidation_leases
    CREATE TABLE IF NOT EXISTS consolidation_leases (
      lease_id        TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      scope           TEXT NOT NULL,
      project_id      TEXT,
      session_id      TEXT,
      observation_ids TEXT NOT NULL,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at      INTEGER NOT NULL,
      completed_at    INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_lease_expires ON consolidation_leases(expires_at);
    CREATE INDEX IF NOT EXISTS idx_lease_session ON consolidation_leases(session_id);

    -- embed_queue
    CREATE TABLE IF NOT EXISTS embed_queue (
      record_id   TEXT NOT NULL,
      grain       TEXT NOT NULL CHECK (grain IN ('observation','trajectory','note','summary')),
      status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','done','failed')),
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT,
      target      TEXT NOT NULL DEFAULT 'live',   -- 'live' or a re-embed collection name
      queued_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (record_id, grain, target)
    );

    CREATE INDEX IF NOT EXISTS idx_eq_claim ON embed_queue(target, status, queued_at);

    -- dead_letters
    CREATE TABLE IF NOT EXISTS dead_letters (
      id          TEXT PRIMARY KEY,
      source      TEXT NOT NULL,        -- capture|summarize|consolidate
      reason      TEXT NOT NULL,        -- schema_invalid|unparseable|empty_content|
                                        -- truncated|citation_unresolved|not_verbatim
      producer    TEXT,                 -- model/tier, for the per-producer reject rate
      payload     TEXT NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_dl_reason   ON dead_letters(reason, created_at);
    CREATE INDEX IF NOT EXISTS idx_dl_producer ON dead_letters(producer);

    -- api_keys
    CREATE TABLE IF NOT EXISTS api_keys (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      key           TEXT NOT NULL UNIQUE,
      expires_at    TEXT,
      last_used_at  TEXT,
      revoked_at    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);
  `);

  // The trajectory tables above are only created when absent; these two calls
  // are what reach a store that already has them. Both are idempotent and
  // also (re)create the trajectory indexes.
  alignTrajectorySchema(db, 'trajectories', TRAJECTORIES_DDL, TRAJECTORIES_INDEX_DDL);
  alignTrajectorySchema(
    db,
    'trajectory_archive',
    TRAJECTORY_ARCHIVE_DDL,
    TRAJECTORY_ARCHIVE_INDEX_DDL
  );
  alignNotesSchema(db);
  alignFailurePatternsSchema(db);
}
