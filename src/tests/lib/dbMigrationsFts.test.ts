import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, resetDb } from '../../lib/db';
import { openDatabase } from '../../lib/sqlite';

describe('db migrations, entities/edges DDL, and FTS5 sync', () => {
  const savedDbUrl = process.env.DATABASE_URL;
  let tmpDir: string | null = null;

  beforeEach(() => {
    resetDb();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = ':memory:';
  });

  afterEach(() => {
    resetDb();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
  });

  it('creates all new columns, entities/entity_edges tables, indexes, and FTS5 triggers on fresh DB', () => {
    const db = getDb();

    const colNames = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (c) => c.name
      );

    expect(colNames('notes')).toEqual(
      expect.arrayContaining(['user_id', 'agent_id', 'event_at', 'valid_from', 'valid_until'])
    );
    expect(colNames('observations')).toEqual(
      expect.arrayContaining(['user_id', 'agent_id', 'event_at', 'condensed_text'])
    );
    expect(colNames('observations_archive')).toEqual(
      expect.arrayContaining(['user_id', 'agent_id', 'event_at', 'condensed_text'])
    );
    const obsIndexes = (
      db.prepare(`PRAGMA index_list(observations)`).all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(obsIndexes).toContain('idx_obs_event_at');
    expect(colNames('trajectories')).toEqual(expect.arrayContaining(['user_id', 'agent_id']));
    expect(colNames('trajectory_archive')).toEqual(
      expect.arrayContaining(['user_id', 'agent_id'])
    );
    expect(colNames('sessions')).toEqual(expect.arrayContaining(['user_id', 'agent_id']));
    expect(colNames('summaries')).toEqual(expect.arrayContaining(['user_id', 'agent_id']));
    expect(colNames('failure_patterns')).toEqual(expect.arrayContaining(['user_id', 'agent_id']));
    expect(colNames('actions')).toEqual(
      expect.arrayContaining([
        'user_id',
        'agent_id',
        'due_at',
        'remind_at',
        'recurrence',
        'last_reminded_at',
        'snooze_until',
        'parent_action_id',
        'embedding',
      ])
    );

    // entities & entity_edges constraints and indexes
    db.prepare(
      `INSERT INTO entities (id, scope, project_id, user_id, agent_id, entity_type, name, description, external_ref)
       VALUES ('ent-1', 'project', 'acme/cogs', 'user-1', 'agent-1', 'service', 'Billing API', 'Handles invoicing', 'svc://billing')`
    ).run();

    // Rule 4 CHECK constraint on entities
    expect(() =>
      db
        .prepare(
          `INSERT INTO entities (id, scope, project_id, entity_type, name)
           VALUES ('ent-bad', 'project', NULL, 'service', 'Broken')`
        )
        .run()
    ).toThrow();

    db.prepare(
      `INSERT INTO entity_edges (id, source_type, source_id, target_type, target_id, relation)
       VALUES ('edge-1', 'note', 'n-1', 'entity', 'ent-1', 'mentions')`
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO entity_edges (id, source_type, source_id, target_type, target_id, relation)
           VALUES ('edge-2', 'note', 'n-1', 'entity', 'ent-1', 'mentions')`
        )
        .run()
    ).toThrow();

    // embed_queue accepts 'entity' and 'action'
    db.prepare(
      `INSERT INTO embed_queue (record_id, record_type, status, target)
       VALUES ('ent-1', 'entity', 'pending', 'live'), ('act-1', 'action', 'pending', 'live')`
    ).run();

    // observations & observations_archive accept 'response'
    db.prepare(
      `INSERT INTO observations (id, scope, project_id, kind, tool_name, input, output)
       VALUES ('obs-resp', 'project', 'acme/cogs', 'response', 'assistant', 'running migrations', 'completed')`
    ).run();
    db.prepare(
      `INSERT INTO observations_archive (id, original_observation_id, scope, project_id, kind, created_at, archived_at)
       VALUES ('obs-arc-1', 'obs-orig-1', 'project', 'acme/cogs', 'response', 1000, 2000)`
    ).run();

    // FTS5 triggers + Porter stemming on notes, note_concepts, note_files
    db.prepare(
      `INSERT INTO notes (id, scope, project_id, type, title, content)
       VALUES ('note-1', 'project', 'acme/cogs', 'architecture', 'Running background workers', 'Queue processing guide')`
    ).run();
    db.prepare(`INSERT INTO note_concepts (note_id, concept) VALUES ('note-1', 'concurrency')`).run();
    db.prepare(
      `INSERT INTO note_files (note_id, file_path) VALUES ('note-1', 'src/worker/runner.ts')`
    ).run();

    // Stemming: 'run' matches 'Running'; extra matches 'concurrency'
    expect(
      db.prepare(`SELECT record_id FROM fts_notes WHERE fts_notes MATCH 'run'`).all()
    ).toEqual([{ record_id: 'note-1' }]);
    expect(
      db.prepare(`SELECT record_id FROM fts_notes WHERE fts_notes MATCH 'concurrency'`).all()
    ).toEqual([{ record_id: 'note-1' }]);

    // Update note keeps extra and updates content
    db.prepare(`UPDATE notes SET title = 'Stopped workers' WHERE id = 'note-1'`).run();
    expect(
      db.prepare(`SELECT record_id FROM fts_notes WHERE fts_notes MATCH 'run'`).all()
    ).toEqual([]);
    expect(
      db.prepare(`SELECT record_id FROM fts_notes WHERE fts_notes MATCH 'stop AND concurrency'`).all()
    ).toEqual([{ record_id: 'note-1' }]);

    // Deleting concept removes it from extra
    db.prepare(`DELETE FROM note_concepts WHERE note_id = 'note-1' AND concept = 'concurrency'`).run();
    expect(
      db.prepare(`SELECT record_id FROM fts_notes WHERE fts_notes MATCH 'concurrency'`).all()
    ).toEqual([]);

    // Deleting note clears fts_notes
    db.prepare(`DELETE FROM notes WHERE id = 'note-1'`).run();
    expect(db.prepare(`SELECT record_id FROM fts_notes`).all()).toEqual([]);

    // FTS5 on trajectories, observations, summaries + claims, entities, actions
    db.prepare(
      `INSERT INTO trajectories (id, scope, project_id, task_type, description, result)
       VALUES ('traj-1', 'project', 'acme/cogs', 'deployment', 'Deploying container', 'Succeeded cleanly')`
    ).run();
    expect(
      db.prepare(`SELECT record_id FROM fts_trajectories WHERE fts_trajectories MATCH 'deploy'`).all()
    ).toEqual([{ record_id: 'traj-1' }]);

    expect(
      db.prepare(`SELECT record_id FROM fts_observations WHERE fts_observations MATCH 'migrat*'`).all()
    ).toEqual([{ record_id: 'obs-resp' }]);

    db.prepare(
      `INSERT INTO summaries (id, scope, project_id, kind, producer_tier, prompt_version)
       VALUES ('sum-1', 'project', 'acme/cogs', 'session', 'agent', 'v1')`
    ).run();
    db.prepare(
      `INSERT INTO summary_claims (id, summary_id, text, ordinal)
       VALUES ('cl-1', 'sum-1', 'Fixed deadlock in queue', 0)`
    ).run();
    expect(
      db.prepare(`SELECT record_id FROM fts_summaries WHERE fts_summaries MATCH 'deadlock'`).all()
    ).toEqual([{ record_id: 'sum-1' }]);

    expect(
      db.prepare(`SELECT record_id FROM fts_entities WHERE fts_entities MATCH 'invoic*'`).all()
    ).toEqual([{ record_id: 'ent-1' }]);

    db.prepare(
      `INSERT INTO actions (id, scope, project_id, title, description, blocked_reason)
       VALUES ('act-1', 'project', 'acme/cogs', 'Renew TLS certificate', 'Expires soon', 'Waiting on DNS')`
    ).run();
    expect(
      db.prepare(`SELECT record_id FROM fts_actions WHERE fts_actions MATCH 'certificate'`).all()
    ).toEqual([{ record_id: 'act-1' }]);
  });

  it('migrates legacy pre-existing DBs, rebuilds constrained tables, and backfills FTS5 once idempotently', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-legacy-db-'));
    const dbFile = path.join(tmpDir, 'brain.db');

    // Create a pre-existing legacy DB before running getDb() migrations
    const legacyDb = openDatabase(dbFile);
    legacyDb.exec(`
      CREATE TABLE store_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        embed_tier TEXT NOT NULL,
        embed_model TEXT NOT NULL,
        embed_model_id TEXT,
        embed_dim INTEGER NOT NULL,
        doc_prefix TEXT NOT NULL DEFAULT '',
        query_prefix TEXT NOT NULL DEFAULT '',
        pooling TEXT NOT NULL DEFAULT 'mean',
        normalize INTEGER NOT NULL DEFAULT 1,
        qdrant_alias TEXT NOT NULL DEFAULT 'brain',
        set_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE observations (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
        project_id TEXT,
        note_ref TEXT,
        task_ref TEXT,
        session_id TEXT,
        agent TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('tool_call','prompt')),
        tool_name TEXT,
        file_path TEXT,
        input TEXT,
        output TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        archived_at INTEGER,
        CHECK ((scope = 'project') = (project_id IS NOT NULL))
      );
      CREATE TABLE observations_archive (
        id TEXT PRIMARY KEY,
        original_observation_id TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
        project_id TEXT,
        note_ref TEXT,
        task_ref TEXT,
        session_id TEXT,
        agent TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('tool_call','prompt')),
        tool_name TEXT,
        file_path TEXT,
        input TEXT,
        output TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        archived_at INTEGER NOT NULL,
        CHECK ((scope = 'project') = (project_id IS NOT NULL))
      );
      CREATE TABLE trajectories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
        project_id TEXT,
        note_ref TEXT,
        task_ref TEXT,
        task_type TEXT,
        agent TEXT,
        description TEXT NOT NULL,
        result TEXT,
        success INTEGER NOT NULL CHECK (success IN (0,1)),
        retries INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        embedding BLOB,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        archived_at INTEGER,
        CHECK ((scope = 'project') = (project_id IS NOT NULL))
      );
      CREATE TABLE trajectory_archive (
        id TEXT PRIMARY KEY,
        original_trajectory_id TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
        project_id TEXT,
        note_ref TEXT,
        task_ref TEXT,
        task_type TEXT,
        agent TEXT,
        description TEXT NOT NULL,
        result TEXT,
        success INTEGER NOT NULL CHECK (success IN (0,1)),
        retries INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        embedding BLOB,
        created_at INTEGER NOT NULL,
        archived_at INTEGER NOT NULL,
        CHECK ((scope = 'project') = (project_id IS NOT NULL))
      );
      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
        project_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('fact','architecture','pattern','workflow','bug','preference')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        author TEXT,
        author_kind TEXT CHECK (author_kind IN ('human','agent')),
        version INTEGER NOT NULL DEFAULT 1,
        supersedes TEXT REFERENCES notes(id),
        is_latest INTEGER NOT NULL DEFAULT 1,
        embedding BLOB,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        CHECK ((scope = 'project') = (project_id IS NOT NULL))
      );
      CREATE TABLE note_concepts (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        concept TEXT NOT NULL,
        PRIMARY KEY (note_id, concept)
      );
      CREATE TABLE note_files (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        PRIMARY KEY (note_id, file_path)
      );
      CREATE TABLE failure_patterns (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
        project_id TEXT,
        task_type TEXT NOT NULL DEFAULT 'unknown',
        error_text TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
        CHECK ((scope = 'project') = (project_id IS NOT NULL)),
        UNIQUE (project_id, task_type, error_text)
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT 'unknown' CHECK(scope IN ('project','global','unknown')),
        project_id TEXT,
        agent_name TEXT,
        cwd TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed','abandoned')),
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        summary TEXT,
        files_touched_json TEXT,
        handoff_summary_id TEXT,
        CHECK ((scope = 'project') = (project_id IS NOT NULL))
      );
      CREATE TABLE actions (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        scope TEXT NOT NULL DEFAULT 'unknown' CHECK(scope IN ('project','global','unknown')),
        project_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('ready','blocked','in_progress','done','dismissed')),
        priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
        blocked_reason TEXT,
        files_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        resolved_by_session_id TEXT,
        CHECK ((scope = 'project') = (project_id IS NOT NULL))
      );
      CREATE TABLE summaries (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
        project_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('session','rollup','failure_digest')),
        window_from INTEGER,
        window_to INTEGER,
        outcome TEXT CHECK (outcome IN ('success','failure','unknown')),
        producer_tier TEXT NOT NULL,
        producer_model TEXT,
        prompt_version TEXT NOT NULL,
        verified INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        supersedes TEXT REFERENCES summaries(id),
        is_latest INTEGER NOT NULL DEFAULT 1,
        sources_expired INTEGER NOT NULL DEFAULT 0,
        embedding BLOB,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        CHECK ((scope = 'project') = (project_id IS NOT NULL))
      );
      CREATE TABLE summary_claims (
        id TEXT PRIMARY KEY,
        summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        ordinal INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE summary_sources (
        summary_id TEXT NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
        claim_id TEXT REFERENCES summary_claims(id) ON DELETE CASCADE,
        record_id TEXT NOT NULL,
        grain TEXT NOT NULL CHECK (grain IN ('observation','trajectory','note')),
        PRIMARY KEY (summary_id, claim_id, record_id)
      );
      CREATE TABLE embed_queue (
        record_id TEXT NOT NULL,
        grain TEXT NOT NULL CHECK (grain IN ('observation','trajectory','note','summary')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        target TEXT NOT NULL DEFAULT 'live',
        queued_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (record_id, grain, target)
      );

      INSERT INTO notes (id, scope, project_id, type, title, content)
      VALUES ('leg-note', 'project', 'example-org/app', 'fact', 'Legacy caching', 'Uses Redis cluster');
      INSERT INTO note_concepts (note_id, concept) VALUES ('leg-note', 'redis');
      INSERT INTO trajectories (id, scope, project_id, task_type, description, result, success)
      VALUES ('leg-traj', 'project', 'example-org/app', 'build', 'Legacy build', 'Clean', 1);
      INSERT INTO observations (id, scope, project_id, kind, tool_name, input)
      VALUES ('leg-obs', 'project', 'example-org/app', 'tool_call', 'bash', 'npm test');
      INSERT INTO summaries (id, scope, project_id, kind, producer_tier, prompt_version)
      VALUES ('leg-sum', 'project', 'example-org/app', 'session', 'agent', 'v1');
      INSERT INTO summary_claims (id, summary_id, text, ordinal)
      VALUES ('leg-cl', 'leg-sum', 'Verified legacy summary backfill', 0);
      INSERT INTO actions (id, scope, project_id, title, description)
      VALUES ('leg-act', 'project', 'example-org/app', 'Legacy reminder', 'Upgrade schema');
    `);
    legacyDb.close();

    // Open via getDb() -> runs all migrations and FTS backfill
    process.env.DATABASE_URL = dbFile;
    const db = getDb();

    // Pre-existing records backfilled into FTS5
    expect(
      db.prepare(`SELECT record_id FROM fts_notes WHERE fts_notes MATCH 'redis'`).all()
    ).toEqual([{ record_id: 'leg-note' }]);
    expect(
      db.prepare(`SELECT record_id FROM fts_trajectories WHERE fts_trajectories MATCH 'build'`).all()
    ).toEqual([{ record_id: 'leg-traj' }]);
    expect(
      db.prepare(`SELECT record_id FROM fts_observations WHERE fts_observations MATCH 'bash'`).all()
    ).toEqual([{ record_id: 'leg-obs' }]);
    expect(
      db.prepare(`SELECT record_id FROM fts_summaries WHERE fts_summaries MATCH 'backfill'`).all()
    ).toEqual([{ record_id: 'leg-sum' }]);
    expect(
      db.prepare(`SELECT record_id FROM fts_actions WHERE fts_actions MATCH 'reminder'`).all()
    ).toEqual([{ record_id: 'leg-act' }]);

    // Rebuilt tables accept new enum/CHECK values and triggers survive rebuilds
    const migratedObsCols = (
      db.prepare(`PRAGMA table_info(observations)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    const migratedObsArcCols = (
      db.prepare(`PRAGMA table_info(observations_archive)`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(migratedObsCols).toContain('event_at');
    expect(migratedObsCols).toContain('condensed_text');
    expect(migratedObsArcCols).toContain('event_at');
    expect(migratedObsArcCols).toContain('condensed_text');
    const migratedObsIndexes = (
      db.prepare(`PRAGMA index_list(observations)`).all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(migratedObsIndexes).toContain('idx_obs_event_at');

    // Pre-existing observation preserves NULL event_at
    const legacyObsRow = db
      .prepare(`SELECT event_at FROM observations WHERE id = 'leg-obs'`)
      .get() as { event_at: string | null };
    expect(legacyObsRow.event_at).toBeNull();

    db.prepare(
      `INSERT INTO observations (id, scope, project_id, kind, input, event_at)
       VALUES ('post-obs', 'project', 'example-org/app', 'response', 'post-migration response', '2025-03-10T12:00:00.000Z')`
    ).run();
    const postObsRow = db
      .prepare(`SELECT event_at FROM observations WHERE id = 'post-obs'`)
      .get() as { event_at: string | null };
    expect(postObsRow.event_at).toBe('2025-03-10T12:00:00.000Z');
    expect(
      db.prepare(`SELECT record_id FROM fts_observations WHERE fts_observations MATCH 'response'`).all()
    ).toEqual([{ record_id: 'post-obs' }]);

    db.prepare(
      `INSERT INTO notes (id, scope, project_id, type, title, content)
       VALUES ('post-lesson', 'project', 'example-org/app', 'lesson', 'Lesson learned', 'Migrations work')`
    ).run();
    db.prepare(
      `INSERT INTO embed_queue (record_id, record_type, status, target)
       VALUES ('ent-new', 'entity', 'pending', 'live'), ('act-new', 'action', 'pending', 'live')`
    ).run();

    // Re-open DB a second time -> idempotent, zero duplicate FTS rows
    resetDb();
    const db2 = getDb();
    expect((db2.prepare(`SELECT COUNT(*) AS n FROM fts_notes`).get() as { n: number }).n).toBe(2);
    expect((db2.prepare(`SELECT COUNT(*) AS n FROM fts_actions`).get() as { n: number }).n).toBe(1);
  });
});
