/**
 * Read-only store inspections shared by the service (`GET /diagnostics/store`)
 * and by `neuralbrain doctor` when the service is stopped.
 *
 * Every function here takes the connection it inspects and only issues SELECTs
 * and PRAGMA reads, so the doctor can run them against a `readOnly` handle
 * without ever becoming a second writer (CLAUDE.md, "One Process, One
 * Connection").
 */
import type { Database } from './sqlite';

export interface DatabaseHealth {
  ok: boolean;
  journal_mode: string;
  error?: string;
}

export interface SchemaAlignment {
  aligned: boolean;
  issues: string[];
}

export interface StoreCounts {
  dead_letters: number;
  unknown_scope_notes: number;
  notes: number;
  trajectories: number;
  observations: number;
}

export function inspectDatabaseHealth(db: Database): DatabaseHealth {
  try {
    const row = db.prepare('SELECT 1 as val').get() as { val: number } | undefined;
    const pragmaRow = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string } | undefined;
    const journalMode = pragmaRow?.journal_mode || 'unknown';
    if (row?.val !== 1) {
      return { ok: false, journal_mode: journalMode, error: 'Database query returned unexpected result' };
    }
    return { ok: true, journal_mode: journalMode };
  } catch (err) {
    return {
      ok: false,
      journal_mode: 'unknown',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Verifies the relational shape the stores depend on.
 *
 * `checkForeignKeys` is on for the service's own connection, where
 * `PRAGMA foreign_keys` is the setting every write runs under. It is off for a
 * doctor's read-only handle: the pragma is per-connection, so reading it there
 * would describe the doctor's connection, not the store.
 */
export function inspectSchemaAlignment(
  db: Database,
  options: { checkForeignKeys?: boolean } = {}
): SchemaAlignment {
  const issues: string[] = [];

  if (options.checkForeignKeys !== false) {
    const fkRow = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined;
    if (fkRow?.foreign_keys !== 1) {
      issues.push('PRAGMA foreign_keys is not active');
    }
  }

  const getTableColumns = (tableName: string): Map<string, { name: string; notnull: number; type: string }> => {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
      notnull: number;
      type: string;
    }>;
    return new Map(rows.map((r) => [r.name, r]));
  };

  for (const table of ['trajectories', 'trajectory_archive']) {
    const cols = getTableColumns(table);
    if (cols.size === 0) {
      issues.push(`table ${table} does not exist`);
      continue;
    }
    const successCol = cols.get('success');
    if (!successCol) issues.push(`${table}.success missing`);
    else if (successCol.notnull !== 0) issues.push(`${table}.success is not nullable (notnull=1)`);

    const projCol = cols.get('project_id');
    if (!projCol) issues.push(`${table}.project_id missing`);
    else if (projCol.notnull !== 0) issues.push(`${table}.project_id is not nullable (notnull=1)`);

    for (const col of ['session_id', 'rollup_source', 'tool_calls']) {
      if (!cols.has(col)) issues.push(`${table}.${col} missing`);
    }
  }

  for (const table of ['observations', 'observations_archive']) {
    const cols = getTableColumns(table);
    if (cols.size === 0) {
      issues.push(`table ${table} does not exist`);
      continue;
    }
    const projCol = cols.get('project_id');
    if (!projCol) issues.push(`${table}.project_id missing`);
    else if (projCol.notnull !== 0) issues.push(`${table}.project_id is not nullable (notnull=1)`);
  }

  for (const table of ['entities', 'entity_edges']) {
    if (getTableColumns(table).size === 0) {
      issues.push(`table ${table} does not exist`);
    }
  }

  const ftsRows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('fts_notes', 'fts_entities', 'fts_actions')"
    )
    .all() as Array<{ name: string }>;
  const ftsSet = new Set(ftsRows.map((r) => r.name));
  for (const ftsName of ['fts_notes', 'fts_entities', 'fts_actions']) {
    if (!ftsSet.has(ftsName)) {
      issues.push(`FTS5 table ${ftsName} does not exist`);
    }
  }

  const actionCols = getTableColumns('actions');
  if (actionCols.size === 0) {
    issues.push('table actions does not exist');
  } else {
    for (const col of ['due_at', 'remind_at', 'recurrence', 'last_reminded_at', 'snooze_until', 'user_id']) {
      if (!actionCols.has(col)) issues.push(`actions.${col} missing`);
    }
  }

  const noteCols = getTableColumns('notes');
  if (noteCols.size === 0) {
    issues.push('table notes does not exist');
  } else {
    for (const col of ['event_at', 'valid_from', 'valid_until', 'user_id']) {
      if (!noteCols.has(col)) issues.push(`notes.${col} missing`);
    }
  }

  return { aligned: issues.length === 0, issues };
}

/** Row counts for the doctor's operational metrics. A missing table counts as 0. */
export function countStoreRecords(db: Database): StoreCounts {
  const count = (sql: string): number => {
    try {
      const row = db.prepare(sql).get() as { count: number } | undefined;
      return Number(row?.count ?? 0);
    } catch {
      return 0;
    }
  };
  return {
    dead_letters: count('SELECT COUNT(*) as count FROM dead_letters'),
    unknown_scope_notes: count("SELECT COUNT(*) as count FROM notes WHERE scope = 'unknown'"),
    notes: count('SELECT COUNT(*) as count FROM notes'),
    trajectories: count('SELECT COUNT(*) as count FROM trajectories'),
    observations: count('SELECT COUNT(*) as count FROM observations'),
  };
}
