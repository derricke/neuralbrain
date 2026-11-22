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

interface ColumnInfo {
  name: string;
  notnull: number;
}

function tableColumns(db: Database, table: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

function ensureColumns(
  db: Database,
  table: string,
  columns: Array<{ name: string; ddl: string; backfill?: string }>
): void {
  const existing = new Set(tableColumns(db, table).map((c) => c.name));
  for (const col of columns) {
    if (existing.has(col.name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col.name} ${col.ddl}`);
    if (col.backfill) db.exec(col.backfill);
    logger.info({ table, column: col.name }, `${table} schema: column added`);
  }
}

function rebuildTable(
  db: Database,
  table: string,
  legacyName: string,
  createDdl: string,
  indexDdl?: string
): void {
  db.exec(`DROP TABLE IF EXISTS ${legacyName}`);
  pragma(db, 'foreign_keys = OFF');
  try {
    transaction(db, () => {
      db.exec(`ALTER TABLE ${table} RENAME TO ${legacyName}`);
      db.exec(createDdl);
      const oldCols = new Set(tableColumns(db, legacyName).map((c) => c.name));
      const shared = tableColumns(db, table)
        .map((c) => c.name)
        .filter((name) => oldCols.has(name));
      const list = shared.join(', ');
      db.exec(`INSERT INTO ${table} (${list}) SELECT ${list} FROM ${legacyName}`);
      db.exec(`DROP TABLE ${legacyName}`);
      if (indexDdl) db.exec(indexDdl);
    })();
  } finally {
    pragma(db, 'foreign_keys = ON');
  }
}

const OBSERVATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS observations (
    id           TEXT PRIMARY KEY,
    scope        TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
    project_id   TEXT,
    user_id      TEXT,
    agent_id     TEXT,
    note_ref     TEXT,                          -- -> notes.id, optional
    task_ref     TEXT,                          -- provenance only, not a scope filter
    session_id   TEXT,
    agent        TEXT,
    kind         TEXT NOT NULL CHECK (kind IN ('tool_call','prompt','response')),
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
`;

const OBSERVATIONS_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_obs_project   ON observations(project_id);
  CREATE INDEX IF NOT EXISTS idx_obs_scope     ON observations(scope);
  CREATE INDEX IF NOT EXISTS idx_obs_scope_proj ON observations(scope, project_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_obs_session   ON observations(session_id);
  CREATE INDEX IF NOT EXISTS idx_obs_created   ON observations(created_at);
  CREATE INDEX IF NOT EXISTS idx_obs_note      ON observations(note_ref);
  CREATE INDEX IF NOT EXISTS idx_obs_task      ON observations(task_ref);
  CREATE INDEX IF NOT EXISTS idx_obs_file      ON observations(file_path);
  CREATE INDEX IF NOT EXISTS idx_obs_failed    ON observations(failed, created_at);
  CREATE INDEX IF NOT EXISTS idx_observations_archived ON observations(archived_at);
`;

const OBSERVATIONS_ARCHIVE_DDL = `
  CREATE TABLE IF NOT EXISTS observations_archive (
    id                      TEXT PRIMARY KEY,
    original_observation_id TEXT NOT NULL UNIQUE,
    scope                   TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
    project_id              TEXT,
    user_id                 TEXT,
    agent_id                TEXT,
    note_ref                TEXT,
    task_ref                TEXT,
    session_id              TEXT,
    agent                   TEXT,
    kind                    TEXT NOT NULL CHECK (kind IN ('tool_call','prompt','response')),
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
`;

const OBSERVATIONS_ARCHIVE_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_obs_arc_project    ON observations_archive(project_id);
  CREATE INDEX IF NOT EXISTS idx_obs_arc_scope      ON observations_archive(scope);
  CREATE INDEX IF NOT EXISTS idx_obs_arc_scope_proj ON observations_archive(scope, project_id);
  CREATE INDEX IF NOT EXISTS idx_obs_arc_archived   ON observations_archive(archived_at);
`;

function alignObservationsSchema(db: Database): void {
  const targets: Array<{
    table: 'observations' | 'observations_archive';
    ddl: string;
    indexDdl: string;
  }> = [
    { table: 'observations', ddl: OBSERVATIONS_DDL, indexDdl: OBSERVATIONS_INDEX_DDL },
    {
      table: 'observations_archive',
      ddl: OBSERVATIONS_ARCHIVE_DDL,
      indexDdl: OBSERVATIONS_ARCHIVE_INDEX_DDL,
    },
  ];

  for (const { table, ddl, indexDdl } of targets) {
    ensureColumns(db, table, [
      { name: 'user_id', ddl: 'TEXT' },
      { name: 'agent_id', ddl: 'TEXT' },
    ]);

    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql?: string } | undefined;

    if (row?.sql && !row.sql.includes("'response'")) {
      rebuildTable(db, table, `${table}_legacy_kind`, ddl, indexDdl);
      logger.info({ table }, `${table} schema: kind CHECK updated to include 'response'`);
    } else {
      db.exec(indexDdl);
    }
  }
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
    user_id       TEXT,
    agent_id      TEXT,
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
  CREATE INDEX IF NOT EXISTS idx_traj_project    ON trajectories(project_id);
  CREATE INDEX IF NOT EXISTS idx_traj_scope      ON trajectories(scope);
  CREATE INDEX IF NOT EXISTS idx_traj_scope_proj ON trajectories(scope, project_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_traj_type       ON trajectories(task_type);
  CREATE INDEX IF NOT EXISTS idx_traj_created    ON trajectories(created_at);
  CREATE INDEX IF NOT EXISTS idx_traj_success    ON trajectories(success, created_at);
  CREATE INDEX IF NOT EXISTS idx_traj_note       ON trajectories(note_ref);
  CREATE INDEX IF NOT EXISTS idx_traj_session    ON trajectories(session_id);
  CREATE INDEX IF NOT EXISTS idx_traj_rollup     ON trajectories(rollup_source);
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
    user_id                TEXT,
    agent_id               TEXT,
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
  CREATE INDEX IF NOT EXISTS idx_traj_arc_project    ON trajectory_archive(project_id);
  CREATE INDEX IF NOT EXISTS idx_traj_arc_scope      ON trajectory_archive(scope);
  CREATE INDEX IF NOT EXISTS idx_traj_arc_scope_proj ON trajectory_archive(scope, project_id);
  CREATE INDEX IF NOT EXISTS idx_traj_arc_archived   ON trajectory_archive(archived_at);
  CREATE INDEX IF NOT EXISTS idx_traj_arc_session    ON trajectory_archive(session_id);
`;

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
  ensureColumns(db, table, [
    { name: 'session_id', ddl: 'TEXT' },
    {
      name: 'rollup_source',
      ddl: "TEXT CHECK (rollup_source IN ('signalled','swept'))",
      backfill: `UPDATE ${table} SET rollup_source = 'signalled' WHERE rollup_source IS NULL`,
    },
    { name: 'tool_calls', ddl: 'INTEGER NOT NULL DEFAULT 0' },
    { name: 'user_id', ddl: 'TEXT' },
    { name: 'agent_id', ddl: 'TEXT' },
  ]);

  // 2. Relax success to nullable. SQLite has no "ALTER COLUMN", so this is the
  //    documented rebuild: rename, recreate, copy, drop, re-index.
  const success = tableColumns(db, table).find((c) => c.name === 'success');
  if (!success || success.notnull === 0) {
    db.exec(indexDdl);
    return;
  }

  rebuildTable(db, table, `${table}_legacy_notnull`, createDdl, indexDdl);
  logger.info({ table }, 'trajectory schema: success relaxed to nullable (NULL = unknown)');
}

const NOTES_DDL = `
  CREATE TABLE IF NOT EXISTS notes (
    id           TEXT PRIMARY KEY,
    scope        TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
    project_id   TEXT,
    user_id      TEXT,
    agent_id     TEXT,
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
    event_at     TEXT,
    valid_from   TEXT,
    valid_until  TEXT,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    CHECK ((scope = 'project') = (project_id IS NOT NULL))
  );
`;

const NOTES_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_notes_project    ON notes(project_id);
  CREATE INDEX IF NOT EXISTS idx_notes_scope      ON notes(scope);
  CREATE INDEX IF NOT EXISTS idx_notes_scope_proj ON notes(scope, project_id, is_latest, updated_at);
  CREATE INDEX IF NOT EXISTS idx_notes_type       ON notes(type);
  CREATE INDEX IF NOT EXISTS idx_notes_latest     ON notes(is_latest, updated_at);
  CREATE INDEX IF NOT EXISTS idx_notes_session    ON notes(session_id);
  CREATE INDEX IF NOT EXISTS idx_notes_temporal   ON notes(event_at, valid_from, valid_until);
  CREATE INDEX IF NOT EXISTS idx_notes_user       ON notes(user_id) WHERE user_id IS NOT NULL;
`;

function alignNotesSchema(db: Database): void {
  ensureColumns(db, 'notes', [
    { name: 'session_id', ddl: 'TEXT' },
    { name: 'user_id', ddl: 'TEXT' },
    { name: 'agent_id', ddl: 'TEXT' },
    { name: 'event_at', ddl: 'TEXT' },
    { name: 'valid_from', ddl: 'TEXT' },
    { name: 'valid_until', ddl: 'TEXT' },
  ]);

  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notes'")
    .get() as { sql?: string } | undefined;

  if (row?.sql && !row.sql.includes("'lesson'")) {
    rebuildTable(db, 'notes', 'notes_legacy_type', NOTES_DDL);
    logger.info({ table: 'notes' }, "notes schema: type CHECK updated to include 'lesson'");
  }

  db.exec(NOTES_INDEX_DDL);
}

function alignSessionsSchema(db: Database): void {
  ensureColumns(db, 'sessions', [
    { name: 'user_id', ddl: 'TEXT' },
    { name: 'agent_id', ddl: 'TEXT' },
  ]);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_proj_status ON sessions(project_id, status, started_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_scope_proj ON sessions(scope, project_id, status, started_at);
  `);
}

function alignSummariesSchema(db: Database): void {
  ensureColumns(db, 'summaries', [
    { name: 'user_id', ddl: 'TEXT' },
    { name: 'agent_id', ddl: 'TEXT' },
  ]);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sum_project    ON summaries(project_id);
    CREATE INDEX IF NOT EXISTS idx_sum_scope_proj ON summaries(scope, project_id, is_latest, created_at);
    CREATE INDEX IF NOT EXISTS idx_sum_kind       ON summaries(kind, created_at);
    CREATE INDEX IF NOT EXISTS idx_sum_latest     ON summaries(is_latest);
    CREATE INDEX IF NOT EXISTS idx_sum_producer   ON summaries(producer_tier, producer_model);
  `);
}

function alignFailurePatternsSchema(db: Database): void {
  ensureColumns(db, 'failure_patterns', [
    { name: 'session_id', ddl: 'TEXT' },
    { name: 'user_id', ddl: 'TEXT' },
    { name: 'agent_id', ddl: 'TEXT' },
  ]);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fp_lookup     ON failure_patterns(project_id, task_type, count DESC);
    CREATE INDEX IF NOT EXISTS idx_fp_scope_proj ON failure_patterns(scope, project_id, task_type, count DESC);
    CREATE INDEX IF NOT EXISTS idx_fp_recent     ON failure_patterns(last_seen_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fp_unique_coalesce ON failure_patterns(COALESCE(project_id, '__GLOBAL_OR_UNKNOWN__:' || scope), task_type, error_text);
  `);
}

function alignActionsSchema(db: Database): void {
  ensureColumns(db, 'actions', [
    { name: 'user_id', ddl: 'TEXT' },
    { name: 'agent_id', ddl: 'TEXT' },
    { name: 'due_at', ddl: 'TEXT' },
    { name: 'remind_at', ddl: 'TEXT' },
    { name: 'recurrence', ddl: 'TEXT' },
    { name: 'last_reminded_at', ddl: 'TEXT' },
    { name: 'snooze_until', ddl: 'TEXT' },
    { name: 'parent_action_id', ddl: 'TEXT' },
    { name: 'embedding', ddl: 'BLOB' },
  ]);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_actions_proj_status ON actions(project_id, status, priority);
    CREATE INDEX IF NOT EXISTS idx_actions_scope_proj  ON actions(scope, project_id, status, priority);
    CREATE INDEX IF NOT EXISTS idx_actions_due ON actions(status, due_at) WHERE status IN ('ready','in_progress') AND due_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_actions_remind ON actions(status, remind_at) WHERE status IN ('ready','in_progress') AND remind_at IS NOT NULL;
  `);
}

const EMBED_QUEUE_DDL = `
  CREATE TABLE IF NOT EXISTS embed_queue (
    record_id   TEXT NOT NULL,
    record_type TEXT NOT NULL CHECK (record_type IN ('observation','trajectory','note','summary','entity','action')),
    status      TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','done','failed')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    target      TEXT NOT NULL DEFAULT 'live',   -- 'live' or a re-embed collection name
    queued_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (record_id, record_type, target)
  );
`;

const EMBED_QUEUE_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_eq_claim ON embed_queue(target, status, queued_at);
`;

function alignEmbedQueueSchema(db: Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'embed_queue'")
    .get() as { sql?: string } | undefined;

  if (row?.sql && !row.sql.includes("'entity'")) {
    rebuildTable(db, 'embed_queue', 'embed_queue_legacy_types', EMBED_QUEUE_DDL, EMBED_QUEUE_INDEX_DDL);
    logger.info({ table: 'embed_queue' }, "embed_queue schema: record_type CHECK updated to include 'entity' and 'action'");
  } else {
    db.exec(EMBED_QUEUE_INDEX_DDL);
  }
}

const NOTES_EXTRA_EXPR = `
  TRIM(
    COALESCE((SELECT GROUP_CONCAT(concept, ' ') FROM note_concepts WHERE note_id = n.id), '') ||
    ' ' ||
    COALESCE((SELECT GROUP_CONCAT(file_path, ' ') FROM note_files WHERE note_id = n.id), '')
  )
`;

const SUMMARIES_TEXT_EXPR = `
  COALESCE((SELECT GROUP_CONCAT(text, char(10)) FROM (SELECT text FROM summary_claims WHERE summary_id = s.id ORDER BY ordinal ASC)), '')
`;

/**
 * Create FTS5 virtual tables, sync triggers, and run one-time backfill on
 * existing databases. Must run AFTER all table rebuilds so triggers are never
 * dropped by ALTER/DROP TABLE operations.
 */
function alignFtsSchema(db: Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5(
      record_id UNINDEXED, title, content, extra, tokenize='porter unicode61'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_trajectories USING fts5(
      record_id UNINDEXED, description, result, task_type, tokenize='porter unicode61'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_observations USING fts5(
      record_id UNINDEXED, tool_name, file_path, input, output, tokenize='porter unicode61'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_summaries USING fts5(
      record_id UNINDEXED, text, tokenize='porter unicode61'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_entities USING fts5(
      record_id UNINDEXED, name, entity_type, description, external_ref, tokenize='porter unicode61'
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_actions USING fts5(
      record_id UNINDEXED, title, description, blocked_reason, tokenize='porter unicode61'
    );

    -- Drop legacy unscoped AFTER UPDATE triggers so existing databases upgrade
    -- to column-scoped triggers (avoiding FTS5 re-indexing on embedding/status/last_reminded_at writes).
    DROP TRIGGER IF EXISTS trg_fts_notes_au;
    DROP TRIGGER IF EXISTS trg_fts_trajectories_au;
    DROP TRIGGER IF EXISTS trg_fts_observations_au;
    DROP TRIGGER IF EXISTS trg_fts_summaries_au;
    DROP TRIGGER IF EXISTS trg_fts_summary_claims_au;
    DROP TRIGGER IF EXISTS trg_fts_entities_au;
    DROP TRIGGER IF EXISTS trg_fts_actions_au;

    -- notes triggers
    CREATE TRIGGER IF NOT EXISTS trg_fts_notes_ai AFTER INSERT ON notes BEGIN
      DELETE FROM fts_notes WHERE record_id = new.id;
      INSERT INTO fts_notes(record_id, title, content, extra)
      SELECT n.id, COALESCE(n.title, ''), COALESCE(n.content, ''), ${NOTES_EXTRA_EXPR}
      FROM notes n WHERE n.id = new.id;
    END;
    CREATE TRIGGER trg_fts_notes_au AFTER UPDATE OF id, title, content, type, author ON notes BEGIN
      DELETE FROM fts_notes WHERE record_id = old.id;
      INSERT INTO fts_notes(record_id, title, content, extra)
      SELECT n.id, COALESCE(n.title, ''), COALESCE(n.content, ''), ${NOTES_EXTRA_EXPR}
      FROM notes n WHERE n.id = new.id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_fts_notes_ad AFTER DELETE ON notes BEGIN
      DELETE FROM fts_notes WHERE record_id = old.id;
    END;

    -- note_concepts triggers
    CREATE TRIGGER IF NOT EXISTS trg_fts_note_concepts_ai AFTER INSERT ON note_concepts BEGIN
      DELETE FROM fts_notes WHERE record_id = new.note_id;
      INSERT INTO fts_notes(record_id, title, content, extra)
      SELECT n.id, COALESCE(n.title, ''), COALESCE(n.content, ''), ${NOTES_EXTRA_EXPR}
      FROM notes n WHERE n.id = new.note_id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_fts_note_concepts_ad AFTER DELETE ON note_concepts BEGIN
      DELETE FROM fts_notes WHERE record_id = old.note_id;
      INSERT INTO fts_notes(record_id, title, content, extra)
      SELECT n.id, COALESCE(n.title, ''), COALESCE(n.content, ''), ${NOTES_EXTRA_EXPR}
      FROM notes n WHERE n.id = old.note_id;
    END;

    -- note_files triggers
    CREATE TRIGGER IF NOT EXISTS trg_fts_note_files_ai AFTER INSERT ON note_files BEGIN
      DELETE FROM fts_notes WHERE record_id = new.note_id;
      INSERT INTO fts_notes(record_id, title, content, extra)
      SELECT n.id, COALESCE(n.title, ''), COALESCE(n.content, ''), ${NOTES_EXTRA_EXPR}
      FROM notes n WHERE n.id = new.note_id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_fts_note_files_ad AFTER DELETE ON note_files BEGIN
      DELETE FROM fts_notes WHERE record_id = old.note_id;
      INSERT INTO fts_notes(record_id, title, content, extra)
      SELECT n.id, COALESCE(n.title, ''), COALESCE(n.content, ''), ${NOTES_EXTRA_EXPR}
      FROM notes n WHERE n.id = old.note_id;
    END;

    -- trajectories triggers
    CREATE TRIGGER IF NOT EXISTS trg_fts_trajectories_ai AFTER INSERT ON trajectories BEGIN
      DELETE FROM fts_trajectories WHERE record_id = new.id;
      INSERT INTO fts_trajectories(record_id, description, result, task_type)
      VALUES (new.id, COALESCE(new.description, ''), COALESCE(new.result, ''), COALESCE(new.task_type, ''));
    END;
    CREATE TRIGGER trg_fts_trajectories_au AFTER UPDATE OF id, description, result, task_type ON trajectories BEGIN
      DELETE FROM fts_trajectories WHERE record_id = old.id;
      INSERT INTO fts_trajectories(record_id, description, result, task_type)
      VALUES (new.id, COALESCE(new.description, ''), COALESCE(new.result, ''), COALESCE(new.task_type, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS trg_fts_trajectories_ad AFTER DELETE ON trajectories BEGIN
      DELETE FROM fts_trajectories WHERE record_id = old.id;
    END;

    -- observations triggers
    CREATE TRIGGER IF NOT EXISTS trg_fts_observations_ai AFTER INSERT ON observations BEGIN
      DELETE FROM fts_observations WHERE record_id = new.id;
      INSERT INTO fts_observations(record_id, tool_name, file_path, input, output)
      VALUES (new.id, COALESCE(new.tool_name, ''), COALESCE(new.file_path, ''), COALESCE(new.input, ''), COALESCE(new.output, ''));
    END;
    CREATE TRIGGER trg_fts_observations_au AFTER UPDATE OF id, tool_name, file_path, input, output ON observations BEGIN
      DELETE FROM fts_observations WHERE record_id = old.id;
      INSERT INTO fts_observations(record_id, tool_name, file_path, input, output)
      VALUES (new.id, COALESCE(new.tool_name, ''), COALESCE(new.file_path, ''), COALESCE(new.input, ''), COALESCE(new.output, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS trg_fts_observations_ad AFTER DELETE ON observations BEGIN
      DELETE FROM fts_observations WHERE record_id = old.id;
    END;

    -- summaries triggers
    CREATE TRIGGER IF NOT EXISTS trg_fts_summaries_ai AFTER INSERT ON summaries BEGIN
      DELETE FROM fts_summaries WHERE record_id = new.id;
      INSERT INTO fts_summaries(record_id, text)
      SELECT s.id, ${SUMMARIES_TEXT_EXPR}
      FROM summaries s WHERE s.id = new.id;
    END;
    CREATE TRIGGER trg_fts_summaries_au AFTER UPDATE OF id, kind, outcome, files_touched, error_verbatim ON summaries BEGIN
      DELETE FROM fts_summaries WHERE record_id = old.id;
      INSERT INTO fts_summaries(record_id, text)
      SELECT s.id, ${SUMMARIES_TEXT_EXPR}
      FROM summaries s WHERE s.id = new.id;
    END;
    CREATE TRIGGER IF NOT EXISTS trg_fts_summaries_ad AFTER DELETE ON summaries BEGIN
      DELETE FROM fts_summaries WHERE record_id = old.id;
    END;

    -- summary_claims triggers
    CREATE TRIGGER IF NOT EXISTS trg_fts_summary_claims_ai AFTER INSERT ON summary_claims BEGIN
      DELETE FROM fts_summaries WHERE record_id = new.summary_id;
      INSERT INTO fts_summaries(record_id, text)
      SELECT s.id, ${SUMMARIES_TEXT_EXPR}
      FROM summaries s WHERE s.id = new.summary_id;
    END;
    CREATE TRIGGER trg_fts_summary_claims_au AFTER UPDATE OF summary_id, text ON summary_claims BEGIN
      DELETE FROM fts_summaries WHERE record_id IN (old.summary_id, new.summary_id);
      INSERT INTO fts_summaries(record_id, text)
      SELECT s.id, ${SUMMARIES_TEXT_EXPR}
      FROM summaries s WHERE s.id IN (old.summary_id, new.summary_id);
    END;
    CREATE TRIGGER IF NOT EXISTS trg_fts_summary_claims_ad AFTER DELETE ON summary_claims BEGIN
      DELETE FROM fts_summaries WHERE record_id = old.summary_id;
      INSERT INTO fts_summaries(record_id, text)
      SELECT s.id, ${SUMMARIES_TEXT_EXPR}
      FROM summaries s WHERE s.id = old.summary_id;
    END;

    -- entities triggers
    CREATE TRIGGER IF NOT EXISTS trg_fts_entities_ai AFTER INSERT ON entities BEGIN
      DELETE FROM fts_entities WHERE record_id = new.id;
      INSERT INTO fts_entities(record_id, name, entity_type, description, external_ref)
      VALUES (new.id, COALESCE(new.name, ''), COALESCE(new.entity_type, ''), COALESCE(new.description, ''), COALESCE(new.external_ref, ''));
    END;
    CREATE TRIGGER trg_fts_entities_au AFTER UPDATE OF id, name, entity_type, description, external_ref ON entities BEGIN
      DELETE FROM fts_entities WHERE record_id = old.id;
      INSERT INTO fts_entities(record_id, name, entity_type, description, external_ref)
      VALUES (new.id, COALESCE(new.name, ''), COALESCE(new.entity_type, ''), COALESCE(new.description, ''), COALESCE(new.external_ref, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS trg_fts_entities_ad AFTER DELETE ON entities BEGIN
      DELETE FROM fts_entities WHERE record_id = old.id;
    END;

    -- actions triggers
    CREATE TRIGGER IF NOT EXISTS trg_fts_actions_ai AFTER INSERT ON actions BEGIN
      DELETE FROM fts_actions WHERE record_id = new.id;
      INSERT INTO fts_actions(record_id, title, description, blocked_reason)
      VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.description, ''), COALESCE(new.blocked_reason, ''));
    END;
    CREATE TRIGGER trg_fts_actions_au AFTER UPDATE OF id, title, description, blocked_reason ON actions BEGIN
      DELETE FROM fts_actions WHERE record_id = old.id;
      INSERT INTO fts_actions(record_id, title, description, blocked_reason)
      VALUES (new.id, COALESCE(new.title, ''), COALESCE(new.description, ''), COALESCE(new.blocked_reason, ''));
    END;
    CREATE TRIGGER IF NOT EXISTS trg_fts_actions_ad AFTER DELETE ON actions BEGIN
      DELETE FROM fts_actions WHERE record_id = old.id;
    END;
  `);

  const backfills: Array<{ source: string; fts: string; sql: string }> = [
    {
      source: 'notes',
      fts: 'fts_notes',
      sql: `
        INSERT INTO fts_notes(record_id, title, content, extra)
        SELECT n.id, COALESCE(n.title, ''), COALESCE(n.content, ''), ${NOTES_EXTRA_EXPR}
        FROM notes n
      `,
    },
    {
      source: 'trajectories',
      fts: 'fts_trajectories',
      sql: `
        INSERT INTO fts_trajectories(record_id, description, result, task_type)
        SELECT id, COALESCE(description, ''), COALESCE(result, ''), COALESCE(task_type, '')
        FROM trajectories
      `,
    },
    {
      source: 'observations',
      fts: 'fts_observations',
      sql: `
        INSERT INTO fts_observations(record_id, tool_name, file_path, input, output)
        SELECT id, COALESCE(tool_name, ''), COALESCE(file_path, ''), COALESCE(input, ''), COALESCE(output, '')
        FROM observations
      `,
    },
    {
      source: 'summaries',
      fts: 'fts_summaries',
      sql: `
        INSERT INTO fts_summaries(record_id, text)
        SELECT s.id, ${SUMMARIES_TEXT_EXPR}
        FROM summaries s
      `,
    },
    {
      source: 'entities',
      fts: 'fts_entities',
      sql: `
        INSERT INTO fts_entities(record_id, name, entity_type, description, external_ref)
        SELECT id, COALESCE(name, ''), COALESCE(entity_type, ''), COALESCE(description, ''), COALESCE(external_ref, '')
        FROM entities
      `,
    },
    {
      source: 'actions',
      fts: 'fts_actions',
      sql: `
        INSERT INTO fts_actions(record_id, title, description, blocked_reason)
        SELECT id, COALESCE(title, ''), COALESCE(description, ''), COALESCE(blocked_reason, '')
        FROM actions
      `,
    },
  ];

  transaction(db, () => {
    for (const item of backfills) {
      const hasSrc = db.prepare(`SELECT 1 FROM ${item.source} LIMIT 1`).get();
      if (!hasSrc) continue;
      const hasFts = db.prepare(`SELECT 1 FROM ${item.fts} LIMIT 1`).get();
      if (hasFts) continue;
      db.exec(item.sql);
      logger.info({ source: item.source, fts: item.fts }, 'FTS5 backfill complete');
    }
  })();
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

    -- observations (DDL in OBSERVATIONS_DDL; see alignObservationsSchema)
    ${OBSERVATIONS_DDL}
    ${OBSERVATIONS_ARCHIVE_DDL}

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
      user_id        TEXT,
      agent_id       TEXT,
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
      user_id            TEXT,
      agent_id           TEXT,
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

    -- actions
    CREATE TABLE IF NOT EXISTS actions (
      id                     TEXT PRIMARY KEY,
      session_id             TEXT,
      scope                  TEXT NOT NULL DEFAULT 'unknown' CHECK(scope IN ('project','global','unknown')),
      project_id             TEXT,
      user_id                TEXT,
      agent_id               TEXT,
      title                  TEXT NOT NULL,
      description            TEXT,
      status                 TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','blocked','in_progress','done','dismissed')),
      priority               TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
      blocked_reason         TEXT,
      files_json             TEXT,
      due_at                 TEXT,
      remind_at              TEXT,
      recurrence             TEXT,
      last_reminded_at       TEXT,
      snooze_until           TEXT,
      parent_action_id       TEXT,
      embedding              BLOB,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at            TEXT,
      resolved_by_session_id TEXT,
      CHECK ((scope = 'project') = (project_id IS NOT NULL))
    );

    -- summaries
    CREATE TABLE IF NOT EXISTS summaries (
      id              TEXT PRIMARY KEY,
      scope           TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
      project_id      TEXT,
      user_id         TEXT,
      agent_id        TEXT,
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
      record_type TEXT NOT NULL CHECK (record_type IN ('observation','trajectory','note')),
      PRIMARY KEY (summary_id, claim_id, record_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sum_src_rec  ON summary_sources(record_id);

    -- entities
    CREATE TABLE IF NOT EXISTS entities (
      id            TEXT PRIMARY KEY,
      scope         TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
      project_id    TEXT,
      user_id       TEXT,
      agent_id      TEXT,
      entity_type   TEXT NOT NULL,
      name          TEXT NOT NULL,
      description   TEXT,
      external_ref  TEXT,
      metadata_json TEXT,
      embedding     BLOB,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      CHECK ((scope = 'project') = (project_id IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_entities_scope_proj ON entities(scope, project_id, entity_type);
    CREATE INDEX IF NOT EXISTS idx_entities_ext_ref    ON entities(external_ref) WHERE external_ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_entities_user       ON entities(user_id) WHERE user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_entities_dedup      ON entities(COALESCE(project_id, '__SCOPE__:' || scope), entity_type, lower(name));

    -- entity_edges
    CREATE TABLE IF NOT EXISTS entity_edges (
      id            TEXT PRIMARY KEY,
      source_type   TEXT NOT NULL,
      source_id     TEXT NOT NULL,
      target_type   TEXT NOT NULL,
      target_id     TEXT NOT NULL,
      relation      TEXT NOT NULL,
      metadata_json TEXT,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE (source_type, source_id, target_type, target_id, relation)
    );

    CREATE INDEX IF NOT EXISTS idx_entity_edges_src ON entity_edges(source_id, relation);
    CREATE INDEX IF NOT EXISTS idx_entity_edges_tgt ON entity_edges(target_id, relation);
    CREATE INDEX IF NOT EXISTS idx_entity_edges_rel ON entity_edges(relation);

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

    -- embed_queue (DDL in EMBED_QUEUE_DDL; see alignEmbedQueueSchema)
    ${EMBED_QUEUE_DDL}

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

  // Legacy grain -> record_type rename before schema alignments/rebuilds
  for (const table of ['summary_sources', 'embed_queue'] as const) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const hasGrain = cols.some((c) => c.name === 'grain');
    const hasRecordType = cols.some((c) => c.name === 'record_type');
    if (hasGrain && !hasRecordType) {
      db.exec(`ALTER TABLE ${table} RENAME COLUMN grain TO record_type`);
    }
  }

  // Schema alignments & rebuilds for pre-existing databases
  alignObservationsSchema(db);
  alignTrajectorySchema(db, 'trajectories', TRAJECTORIES_DDL, TRAJECTORIES_INDEX_DDL);
  alignTrajectorySchema(
    db,
    'trajectory_archive',
    TRAJECTORY_ARCHIVE_DDL,
    TRAJECTORY_ARCHIVE_INDEX_DDL
  );
  alignNotesSchema(db);
  alignSessionsSchema(db);
  alignSummariesSchema(db);
  alignFailurePatternsSchema(db);
  alignActionsSchema(db);
  alignEmbedQueueSchema(db);

  // Must run AFTER all table rebuilds so FTS triggers are never lost
  alignFtsSchema(db);
}
