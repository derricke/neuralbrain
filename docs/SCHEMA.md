# Schema

SQLite is the source of truth (rule 2). Qdrant holds vectors only and is
rebuildable from these tables at any time.

> **The brain service is the only writer.** No client, script, test or operator
> opens this database read-write — a direct insert skips the embed queue, so the
> row lives in SQLite and never in Qdrant, invisible to search with nothing
> reporting it. Read-only inspection (`file:...?mode=ro`) is fine for diagnosis;
> repair goes through `POST /maintenance/*`. Tests use `:memory:` or a temp path,
> and `getDb()` refuses anything else under a test run.

Conventions: ids are TEXT (uuid), timestamps are INTEGER unix seconds
(`unixepoch()`), booleans are INTEGER 0/1. No foreign keys to anything outside
this file.

**`project_id` is normalised before storage** by `src/lib/scope.ts`: trimmed,
trimmed of trailing `/`, consecutive `//` collapsed, and per segment lowercased,
internal whitespace converted to `-`, restricted to `[a-z0-9._-]`, max length
`256` characters. Both flat IDs (`neuralbrain`) and hierarchical relative slash
paths (`acme/socials/calendar`) are supported. Filesystem paths (`/`, `\`,
`C:/`, `~`, `.`, `..`) and unsupported characters are **rejected, not converted**
— deriving `foo` from `/home/user/Projects/Foo` would be a guess, collides with
any other repo of that basename, and breaks when the repo moves. Error messages
and hints say to use the project root folder name (from `.brainrc`, else the
git repo root — the main repo for a worktree), e.g. `'neuralbrain'` or
`'acme/socials/calendar'`, so all agents come up with the same id. Without this,
`MyProject` and `myproject` are two projects and memory splits silently (D25).

**Every table that can be scoped carries the same three-state scope** (rule 4)
plus nullable `user_id` (filterable) and `agent_id` (provenance only, never
filtered):

```sql
scope      TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
project_id TEXT,     -- NULL unless scope='project'
user_id    TEXT,     -- optional; filterable when explicitly provided
agent_id   TEXT,     -- optional provenance; never filtered
CHECK ((scope = 'project') = (project_id IS NOT NULL))
```

`global` means "applies everywhere", `unknown` means "the writer did not say".
Conflating them is where many memory systems fail: once "no project" and
"everywhere" share a value, the writer's intent can't be recovered.

---

## store_meta — exactly one row

The embedder identity, pinned on first use. Makes a config/store mismatch loud
instead of a silent downgrade (D6, D7, D10).

```sql
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
```

Startup compares config against this row. Compare `embed_model_id`, **not just
`embed_dim`** — two models can share a dimension, and a remote endpoint's loaded
model can change without the brain restarting. On mismatch: refuse vector search,
log what differs, keep SQL and BM25 serving, point at the re-embed job. Never
rewrite this row to match reality.

---

## observations — one tool call or prompt

High volume, machine-written, **no model ever touches this write** (rule 1).

```sql
CREATE TABLE IF NOT EXISTS observations (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
  project_id   TEXT,
  user_id      TEXT,
  agent_id     TEXT,
  note_ref     TEXT,                          -- -> notes.id, optional
  task_ref     TEXT,                          -- provenance; filterable, but not a scope axis
  session_id   TEXT,
  agent        TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('tool_call','prompt','response')),
  tool_name      TEXT,
  file_path      TEXT,                         -- the tool's TARGET path, nothing else
  input          TEXT,
  output         TEXT,
  condensed_text      TEXT,                    -- deterministic extractive condensation (additive)
  resolved_dates_json TEXT,                    -- deterministic UTC relative-date annotations (additive)
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,     -- set by the failure hook, never inferred
  event_at     TEXT,                           -- optional UTC ISO-8601 when event occurred
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at  INTEGER,
  CHECK ((scope = 'project') = (project_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_obs_project    ON observations(project_id);
CREATE INDEX IF NOT EXISTS idx_obs_scope      ON observations(scope);
CREATE INDEX IF NOT EXISTS idx_obs_scope_proj ON observations(scope, project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_obs_event_at   ON observations(scope, project_id, event_at);
CREATE INDEX IF NOT EXISTS idx_obs_session    ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_created    ON observations(created_at);
CREATE INDEX IF NOT EXISTS idx_obs_note       ON observations(note_ref);
CREATE INDEX IF NOT EXISTS idx_obs_task       ON observations(task_ref);
CREATE INDEX IF NOT EXISTS idx_obs_file       ON observations(file_path);
CREATE INDEX IF NOT EXISTS idx_obs_failed     ON observations(failed, created_at);
```

`input`/`output` are stored **whole**. Do not truncate on the write path —
truncating *and then* summarising the remainder away is how the ground truth gets lost.
`condensed_text` and `resolved_dates_json` are additive, disposable columns computed
deterministically at ingest (`src/lib/condenser.ts` and `src/lib/temporal.ts`, zero
generative model calls): `resolveRelativeDates` anchors relative expressions
(`yesterday`, `last Saturday`, `two weeks ago`, `last month`, etc.) in UTC against
`event_at ?? created_at` without mutating raw `input`/`output`, persists structured
spans in `resolved_dates_json` (`NULL` when none match), and feeds inline
`[YYYY-MM-DD]` annotations into `condensed_text`. `condenseObservation` strips
conversational boilerplate, deduplicates near-identical lines, preserves concise
`prompt` observations (`<= 500` chars), and extracts high-signal passages for
verbose `response` and `tool_call` rows. `trg_fts_observations_au` is scoped to
`AFTER UPDATE OF id, tool_name, file_path, input, output, condensed_text` so updating
non-FTS columns (`resolved_dates_json`, `archived_at`, etc.) never re-indexes
`fts_observations`.
`file_path` is defined narrowly: the path a tool acted on. A path merely
mentioned in command output does not count. (Testing showed two producers
disagreeing on this exact point with nothing to flag it.)

`observations_archive` mirrors this table (including `condensed_text` and `resolved_dates_json`) with `archived_at INTEGER NOT NULL`,
and **every column nullable that is nullable here** — in particular
`project_id`. The inherited `trajectory_archive` had `swarm_id NOT NULL`, which
would have made null-scope records unarchivable and broken retention for exactly
the rows rule 4 requires.

---

## trajectories — one task attempt with an outcome

Generalised from `src/memory/trajectoryStore.ts`, whose shape is sound.

```sql
CREATE TABLE IF NOT EXISTS trajectories (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL CHECK (scope IN ('project','global','unknown')),
  project_id   TEXT,                           -- was swarm_id
  user_id      TEXT,
  agent_id     TEXT,
  note_ref     TEXT,                           -- new
  task_ref     TEXT,                           -- provenance; filterable, not a scope axis
  task_type    TEXT,                           -- new; what failure patterns group by
  agent        TEXT,                           -- was agent_id
  description  TEXT NOT NULL,
  result       TEXT,
  success      INTEGER CHECK (success IN (0,1)),  -- NULL = outcome unknown
  retries      INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  tool_calls   INTEGER NOT NULL DEFAULT 0,
  session_id   TEXT,
  rollup_source TEXT CHECK (rollup_source IN ('signalled','swept')),
  embedding    BLOB,                            -- Float32Array buffer; derived data
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at  INTEGER,
  CHECK ((scope = 'project') = (project_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_traj_project    ON trajectories(project_id);
CREATE INDEX IF NOT EXISTS idx_traj_scope      ON trajectories(scope);
CREATE INDEX IF NOT EXISTS idx_traj_scope_proj ON trajectories(scope, project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_traj_type       ON trajectories(task_type);
CREATE INDEX IF NOT EXISTS idx_traj_created    ON trajectories(created_at);
CREATE INDEX IF NOT EXISTS idx_traj_success    ON trajectories(success, created_at);
CREATE INDEX IF NOT EXISTS idx_traj_note       ON trajectories(note_ref);
```

Dropped from the original: `task_id REFERENCES tasks(id)`, `swarm_id REFERENCES
swarms(id)`, `job_id REFERENCES swarm_jobs(id)`, `provider`, `model`.

`trajectory_archive` mirrors this with nullable `project_id`.

Rollups into this table are **arithmetic only** (rule 1): count tool calls, sum
durations, take the first prompt as `description`.

`success` is **tri-state** and the asymmetry is deliberate:

| Case | `success` |
|---|---|
| any source observation has `failed = 1` | `0` |
| `rollup_source = 'signalled'`, no failure | `1` — the client closed the task and a failure hook was in place to say otherwise |
| `rollup_source = 'swept'`, no failure | **`NULL`** unless a source observation *records* completion |

A swept rollup must not claim success. Absence of a failure hook is equally
consistent with the process having been killed — which is precisely the mistake a
model made on the sparse test fixture (answering `"success"` for a record with no
outcome at all), and arithmetic must not repeat it. `NULL` is never coerced to
`0` or `1` on read; query it with `success=unknown`.

Both archive tables accept `NULL` here, for the same reason `project_id` is
nullable there: a non-nullable archive column makes exactly the records the rules
require unarchivable.

---

## notes — curated knowledge, never auto-deleted

The grain most memory tools mean by "memories". Authored on purpose by an agent or
a human; edited by supersede, never updated in place.

```sql
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

CREATE INDEX IF NOT EXISTS idx_notes_project    ON notes(project_id);
CREATE INDEX IF NOT EXISTS idx_notes_scope      ON notes(scope);
CREATE INDEX IF NOT EXISTS idx_notes_scope_proj ON notes(scope, project_id, is_latest, updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_type       ON notes(type);
CREATE INDEX IF NOT EXISTS idx_notes_latest     ON notes(is_latest, updated_at);
CREATE INDEX IF NOT EXISTS idx_notes_session    ON notes(session_id);
CREATE INDEX IF NOT EXISTS idx_notes_temporal   ON notes(event_at, valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_notes_user       ON notes(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_note_concepts_c  ON note_concepts(concept);
CREATE INDEX IF NOT EXISTS idx_note_files_f     ON note_files(file_path);
```

`type` taxonomy is taken from a real notes corpus, extended with `lesson` for durable takeaways and post-mortems. `concepts` and `files` (each present on most notes in that corpus) are **join tables, not JSON
arrays** — they are filter axes, and "which notes touch this file?" must be a
query. `file_path` lookup is the highest-value question an agent can ask at task
start. Temporal columns (`event_at`, `valid_from`, `valid_until`) are normalized UTC
ISO-8601 strings supporting point-in-time (`as_of`) and range (`after`/`before`) search.

**`strength` is deliberately absent.** Model-assigned strength scores tend to sit at
one mid-scale value on every record — a model parking on a calibration it cannot do.
A constant is not a signal.

---

## failure_patterns — push-injection payload

Replaces the `failure_patterns` JSON blob that lived on `global_jobs` and
`agent_type_profiles`.

```sql
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

CREATE INDEX IF NOT EXISTS idx_fp_lookup     ON failure_patterns(project_id, task_type, count DESC);
CREATE INDEX IF NOT EXISTS idx_fp_scope_proj ON failure_patterns(scope, project_id, task_type, count DESC);
CREATE INDEX IF NOT EXISTS idx_fp_recent     ON failure_patterns(last_seen_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fp_unique_coalesce ON failure_patterns(COALESCE(project_id, '__GLOBAL_OR_UNKNOWN__:' || scope), task_type, error_text);
```

`count` is maintained by an **UPSERT at write time**, never read-modify-write on
a blob (which loses increments under concurrency) and never a number a model
volunteered. Testing confirmed a model reports individual facts but does not
think to mention the aggregate — and the aggregate is the entire value here.

```sql
INSERT INTO failure_patterns (id, scope, project_id, user_id, agent_id, session_id, task_type, error_text)
VALUES (?,?,?,?,?,?,?,?)
ON CONFLICT (project_id, task_type, error_text) DO UPDATE SET
  count = count + 1,
  user_id = COALESCE(excluded.user_id, failure_patterns.user_id),
  agent_id = COALESCE(excluded.agent_id, failure_patterns.agent_id),
  last_seen_at = unixepoch(),
  session_id = COALESCE(excluded.session_id, failure_patterns.session_id);
```

A parse or read failure here **logs and surfaces**. The original swallowed it
with a bare `catch (e) {}`, so one corrupt blob disabled injection permanently
and silently.

---

## sessions — short-term session lifecycle

Tracks active, paused, completed, and abandoned coding sessions. When a session
ends without a caller-provided summary, `endSession` computes a deterministic
arithmetic summary from `observations` (Rule 1).

```sql
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

CREATE INDEX IF NOT EXISTS idx_sessions_proj_status ON sessions(project_id, status, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_scope_proj  ON sessions(scope, project_id, status, started_at);
```

---

## actions — short-term next actions & reminders

Actionable follow-ups, blockers, scheduled reminders, and recurring tasks
surfaced across sessions via `/inject`, `/actions/due`, `/actions/reminders/*`,
and the `brain_action_*` MCP tools.

```sql
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

CREATE INDEX IF NOT EXISTS idx_actions_proj_status ON actions(project_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_actions_scope_proj  ON actions(scope, project_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_actions_due ON actions(status, due_at) WHERE status IN ('ready','in_progress') AND due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_actions_remind ON actions(status, remind_at) WHERE status IN ('ready','in_progress') AND remind_at IS NOT NULL;
```

---

## entities & entity_edges — persistent knowledge graph

Persistent entity nodes (`brand`, `person`, `asset`, `metric`, `document`,
`tool`, or custom domain-agnostic `entity_type`) and directed relational edges
connecting any nodes across subprojects (`part_of`, `depends_on`, `references`,
`owns`, `produced_by`, `blocks`, `related_to`, or custom relations).

```sql
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
```

---

## summaries — derived rows (rule 6)

Additive, attributed, disposable. Drop every row here and the brain still works.

```sql
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

CREATE INDEX IF NOT EXISTS idx_sum_project    ON summaries(project_id);
CREATE INDEX IF NOT EXISTS idx_sum_scope_proj ON summaries(scope, project_id, is_latest, created_at);
CREATE INDEX IF NOT EXISTS idx_sum_kind       ON summaries(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_sum_latest     ON summaries(is_latest);
CREATE INDEX IF NOT EXISTS idx_sum_producer   ON summaries(producer_tier, producer_model);
CREATE INDEX IF NOT EXISTS idx_sum_src_rec    ON summary_sources(record_id);
```

`summary_sources` is a **join table, not an id array**, so "which summaries cover
this observation?" is a query. `producer_*` columns exist so you can regenerate
selectively — "redo everything the 7B wrote, keep what the agent wrote" — rather
than discarding all derived rows together.

`outcome` is written by **arithmetic, not by the model.** Testing found a model
answering `"success"` on a record with no outcome at all, and citation/substring
verification cannot catch that because `outcome` is not a quoted string.

`sources_expired` is set when a summary outlives its sources. Prefer archiving a
summarised observation over deleting it (`BRAIN_KEEP_SUMMARIZED_SOURCES=1`) so
this stays rare.

**No free-prose field is required of a producer.** There is no `narrative`
column. Testing showed a required "why it matters" field compels invention even
from a well-behaved model: it produced "likely part of an audit or modification
process" from a bare file read. Deliberate prose is a `note`, authored on purpose.

---

## FTS5 Full-Text Indexes

Six FTS5 virtual tables (`tokenize='porter unicode61'`) kept synchronized by
`AFTER INSERT` / `AFTER UPDATE` / `AFTER DELETE` triggers (plus `note_concepts`,
`note_files`, and `summary_claims` triggers) and backfilled on migration (legacy
5-column `fts_observations` tables without `condensed_text` are automatically
recreated and backfilled):

```sql
fts_notes(record_id UNINDEXED, title, content, extra, tokenize='porter unicode61')
fts_trajectories(record_id UNINDEXED, description, result, task_type, tokenize='porter unicode61')
fts_observations(record_id UNINDEXED, tool_name, file_path, input, output, condensed_text, tokenize='porter unicode61')
fts_summaries(record_id UNINDEXED, text, tokenize='porter unicode61')
fts_entities(record_id UNINDEXED, name, entity_type, description, external_ref, tokenize='porter unicode61')
fts_actions(record_id UNINDEXED, title, description, blocked_reason, tokenize='porter unicode61')
```

### Two-Tier FTS5 Querying & Explicit BM25 Column Weights

Lexical search (`src/learning/search.ts`) bounds query scans (`MAX_FTS_QUERY_CHARS = 4000`,
`MAX_FTS_TOKENS = 48` so AST depth never approaches `SQLITE_MAX_EXPR_DEPTH`), filters
high-frequency English stopwords (with automatic fallback to unfiltered tokens on
pure-stopword queries), and executes two FTS5 tiers:
1. **Tier 1 (Strict `AND` / `NEAR`)**: Runs over top high-specificity content terms
   (and `NEAR(..., 6)` on quoted multi-word titles) when `>= 2` content tokens exist,
   applying a `1.6x` BM25 multiplier (`max(strictBm25 * 1.6, relaxedBm25 * 1.35)`).
2. **Tier 2 (Relaxed `OR`)**: Broad lexical recall over quoted tokens.

Every FTS5 query uses explicit per-column `bm25(...)` weights (`0.0` on `UNINDEXED` `record_id`):
- `fts_observations` (`record_id, tool_name, file_path, input, output, condensed_text`):
  - `'general'` intent: `bm25(fts_observations, 0.0, 1.5, 1.6, 1.6, 0.75, 1.8)`
  - `'assistant'` intent: `bm25(fts_observations, 0.0, 1.2, 1.2, 1.0, 1.4, 1.6)`
  - `'tool'` intent: `bm25(fts_observations, 0.0, 2.0, 2.2, 1.4, 1.0, 1.5)`
- `fts_notes` (`record_id, title, content, extra`): `bm25(fts_notes, 0.0, 2.2, 1.0, 1.6)`
- `fts_trajectories` (`record_id, description, result, task_type`): `bm25(fts_trajectories, 0.0, 1.6, 1.0, 1.4)`
- `fts_summaries` (`record_id, text`): `bm25(fts_summaries, 0.0, 1.0)`
- `fts_entities` (`record_id, name, entity_type, description, external_ref`): `bm25(fts_entities, 0.0, 2.5, 1.4, 1.0, 1.8)`
- `fts_actions` (`record_id, title, description, blocked_reason`): `bm25(fts_actions, 0.0, 2.0, 1.0, 1.2)`

---

## embed_queue — embedding off the write path (D3)

```sql
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

CREATE INDEX IF NOT EXISTS idx_eq_claim ON embed_queue(target, status, queued_at);
```

Capture inserts the row and returns; a worker drains this. A provider outage
delays indexing and **never refuses a write** (rule 3). This same queue drives
re-embedding, with `target` naming the new collection — so progress lives here
and the record tables stay free of model bookkeeping.

---

## dead_letters — malformed only, never capacity

```sql
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
```

**A write is never dead-lettered for volume** (rule 3). A reason like
`"Session observation limit reached"` must not exist here. `empty_content` and `truncated` are real reasons — both were
observed in testing, arriving as `200 OK` with `finish_reason: "stop"`, throwing
nothing.

---

## api_keys — carried over unchanged

```sql
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
```

---

## Qdrant

One collection behind an **alias** (`store_meta.qdrant_alias`). Search always
queries the alias; a re-embed builds a new collection and moves the alias
atomically, so there is no window of mixed vector spaces and rollback is moving
it back.

```
vectors:        { size: <store_meta.embed_dim>, distance: Cosine }
sparse_vectors: { bm25: { modifier: idf } }        -- server-side Qdrant/bm25
```

**Payload indexes on every filtered field** — the live collection has
`payload_schema: {}`, which is why its filters were useless:

```
scope (keyword)             project_id (keyword)    project_ancestors (keyword[])
user_id (keyword)           entity_type (keyword)   record_type (keyword)
kind (keyword)              type (keyword)          task_type (keyword)
note_ref (keyword)          task_ref (keyword)      file_path (keyword)
agent (keyword)             success (bool)          created_at (integer)
```

Fuse dense vectors, SQLite FTS5 BM25, and Entity-Graph 1-hop links with
**Reciprocal Rank Fusion (RRF, $1 / (60 + \text{rank})$), never a weighted sum**
— BM25 scores shift per query while dense scores do not, and adding incompatible
scales makes the ranking meaningless.

`record_type` (`note`, `trajectory`, `observation`, `summary`, `entity`, `action`)
lets a search target specific layers or exclude derived rows, so a summary can
never silently outrank the record it describes.

---

## Migrations

All DDL is `CREATE TABLE IF NOT EXISTS` run at open, plus `store_meta.schema_version`.
There was no migrations directory in NeuralSwarm and there need not be one here
yet — but **`ensureColumnExists` must not re-add dropped foreign keys**, which is
how the inherited `db.ts` would restore orchestrator coupling (`db.ts:287-288`,
and again in the table rebuild at `db.ts:400-405`).
