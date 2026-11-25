# HTTP API

The only way into the store. **Nothing but the brain service ever opens the
database file** — not clients, not scripts, not tests, not an operator with
`sqlite3`. The API owns validation, migrations, auth and tracing, so there is
exactly one write path to audit.

A direct write is not a shortcut: it skips the embed queue (the row never
reaches Qdrant), the `failure_patterns` UPSERT (the failure never reaches
injection) and dead-letter routing. Any repair needing new SQL becomes a
`POST /maintenance/*` endpoint rather than a script run by hand.

Auth: `Authorization: Bearer <key>` on everything except `/health`. Create keys
with `npm run api-key:create`.

Middleware order (from NeuralSwarm's `app.ts:52-64`, which got this right):
**tracing → rate limiter → auth → routes.**

---

## Capture

### `POST /capture/observations`

The hot path. Accepts one observation or a batch.

```json
{
  "observations": [{
    "scope": "project",
    "project_id": "neuralbrain",
    "note_ref": null,
    "task_ref": "t-9931",
    "session_id": "s-4410",
    "agent": "claude-code",
    "kind": "tool_call",
    "tool_name": "Edit",
    "file_path": "src/lib/db.ts",
    "input": "...",
    "output": "...",
    "duration_ms": 412,
    "failed": 0,
    "event_at": "2026-05-01T14:30:00.000Z"
  }]
}
```

`201` → `{"accepted": 1, "ids": ["obs_..."], "rejected": []}`

**Rules this endpoint must obey:**

- **Optional `event_at` timestamp, deterministic relative-date anchoring & signal tagging.** `event_at` accepts an ISO-8601 date/time string (normalized to UTC ISO-8601) or finite numeric Unix epoch seconds. Omitted, `null`, or empty string stores `NULL`. Malformed values are dead-lettered as `schema_invalid`. At ingest, relative date phrases in `input`/`output` (`yesterday`, `last Saturday`, `two weeks ago`, `last month`, etc.) are deterministically anchored in UTC against `event_at ?? created_at` into `resolved_dates_json` and inline `[YYYY-MM-DD]` annotations inside `condensed_text`, and deterministic linguistic signal tags (`preference`, `state_update`, `completed_action`, `planned_action`) are persisted as a JSON array in `signal_tags` (`NULL` when none match), while raw `observations.input` and `observations.output` remain 100% verbatim.

- **Exempt from rate limiting.** Hook-driven capture exceeds 100/min in seconds,
  and rule 3 forbids rejecting a write for volume.
- **No truncation, no model, no inference.** Store `input`/`output` whole.
- **`scope` is required and never guessed.** Omitted → `"unknown"`, never
  `"global"`. Defaulting to global would put unlabelled records into every
  project's injection.
- **`project_id` is normalised and echoed back.** Supports flat slugs (`neuralbrain`)
  and hierarchical relative slash paths (`acme/socials/calendar`, max 256 chars),
  lowercased per segment with internal whitespace converted to `-`, charset
  `[a-z0-9._-]` per segment. A filesystem path or unsupported character is a
  `400`, not a silent conversion — so a client learns its id is wrong rather than
  quietly writing to a second project.
- **User & Agent IDs.** All memory tables store optional nullable `user_id` and
  `agent_id`. Queries filter by `user_id` when supplied, and **never filter on
  `agent_id`** (cross-agent memory visibility is preserved).
- **`failed` comes from the client's failure hook.** Never derived from output
  text.
- Partial success is `201` with a populated `rejected` array — one malformed
  record must not reject the batch.
- A rejected record goes to `dead_letters` with reason
  `schema_invalid`. **There is no capacity rejection reason.**
- Returns as soon as rows are committed. Embedding is queued, not awaited.

### `POST /capture/trajectories`

Same shape for the trajectory grain. Fields per `docs/SCHEMA.md`. If
`observation_ids` are supplied, the rollup is computed **arithmetically** — count,
sum durations, first prompt as `description`. `success` is tri-state: `0` on any
failed source, `1` only for a client-signalled rollup with no failure, and `NULL`
(unknown) for a swept one — see `docs/SCHEMA.md`.

---

## Retrieval

### `POST /search`

3-signal hybrid retrieval: Qdrant dense vectors + two-tier SQLite FTS5 BM25
(stopword-filtered relaxed `OR` + boosted strict `AND`/`NEAR` with explicit
per-column BM25 weights, including `observations.condensed_text`) + Entity-Graph
1-hop expansion (`entity_edges`), fused with RRF ($1 / (60 + \text{rank})$) and
scaled by hierarchical tier multipliers (`exact > parent > grandparent > global > child`)
and temporal bias/validity adjustments.

```json
{
  "q": "foreign key constraint failed on migration",
  "record_types": ["note", "trajectory"],
  "scope": "project",
  "project_id": "acme/socials/calendar",
  "include_ancestors": true,
  "include_children": false,
  "include_global": true,
  "include_history": false,
  "user_id": "alice",
  "after": "2026-01-01T00:00:00Z",
  "before": "2026-12-31T23:59:59Z",
  "as_of": "2026-06-01T00:00:00Z",
  "reference_date": "2026-06-20T12:00:00Z",
  "temporal_bias": "recent",
  "snippet_mode": "query_focused",
  "max_record_chars": 600,
  "kind_weights": { "prompt": 1.15, "tool_call": 1.05, "response": 0.9 },
  "max_kind_share": { "response": 0.6 },
  "filters": {
    "type": ["bug", "pattern"],
    "file_path": "src/lib/db.ts",
    "entity_type": "asset",
    "memory_layer": "procedural",
    "signal_tag": "preference"
  },
  "limit": 10
}
```

`200` → results carrying `record_type`, `score`, `project_id`, `match_tier`
(`exact | ancestor | child | global | unknown`), optional `matched_entities`
(when matched/boosted via `entity_edges`), optional `snippet` (populated on
`observation` results), `record`, and `claims` / `sources`
for derived rows. When `q` expresses a natural-language or calendar temporal
window, the response also includes `temporal_window: { start, end, expressions }`.

- `record_types` supports `'note' | 'trajectory' | 'observation' | 'summary' | 'entity' | 'action'` (default `['note', 'trajectory']`; legacy `grains` alias still accepted).
- `reference_date` (optional UTC ISO-8601 timestamp; defaults to server `now`) anchors natural-language temporal query parsing (`"four weeks ago"`, `"in the past two weeks"`, `"last Saturday"`, `"in March"`, `"May 20, 2023"`, `"Q2 2024"`, `"between March and May 2023"`) and `temporal_bias`. When a temporal window is detected, search performs auxiliary SQLite recall over in-window notes/observations and `resolved_dates_json` overlaps, applies a soft cosine temporal boost (`1.22x..1.40x` inside the window, tapering to `1.0x` across a 1x half-width grace zone without hard-dropping out-of-window context), and returns `temporal_window`.
- `snippet_mode` (`'query_focused' | 'condensed' | 'raw'`, default `'query_focused'`) controls how `observation` records are windowed at read time without mutating stored `input`/`output`:
  - `'query_focused'` (default): annotates relative dates inline (`[YYYY-MM-DD]`) and scans the full untruncated `input`/`output` to extract query-matching passages (joining non-adjacent spans with ` [...] `) within `max_record_chars` (default `1000` for `prompt`, `600` for `response`/`tool_call`) and populates `snippet`.
  - `'condensed'`: uses `condensed_text` (or computes extractive condensation with inline `[YYYY-MM-DD]` annotations on the fly) capped at `max_record_chars` (default `600`).
  - `'raw'`: returns verbatim raw `record.input` and `record.output` (respecting explicit `max_record_chars` if supplied, else 32,000-char safety bound) while still attaching an inline-annotated query-focused `snippet`.
- `kind_weights` (`Partial<Record<'prompt' | 'response' | 'tool_call', number>>`, clamped to `[0.1, 5.0]`) overrides automatic query-intent observation weighting (`assistant` recall queries boost `response`, code/path/error `tool` queries boost `tool_call`, and `general` recall queries boost `prompt` while damping verbose low-density essays). Recommendation/preference queries automatically boost `'preference'`-tagged observations (`1.22x`), current-state queries boost `'state_update'`-tagged observations (`1.18x` plus a gentle recency nudge so newer updates outrank superseded observations), and `filters.signal_tag` optionally filters observations by tag (`'preference' | 'state_update' | 'completed_action' | 'planned_action'`).
- `max_kind_share` (`Partial<Record<'prompt' | 'response' | 'tool_call', number>>` in `(0, 1]`) caps any single observation `kind` in pass 1 (default `{ "response": 0.6 }` when searching observations with `limit >= 5`, no `filters.kind`, and non-assistant intent) and backfills in score order in pass 2 when fewer alternatives exist.
- `include_ancestors: true` (default) inherits ancestor projects (`acme`, `acme/socials`) while isolating sibling subprojects (`acme/socials/generator`, `acme/cogs`).
- `include_children: true` rolls up all strict descendant subprojects (`acme/*`).
- `include_global: true` merges `scope='global'` with the named project. It
  never includes `scope='unknown'` — those are surfaced only by an explicit
  `scope: "unknown"` query, which doubles as the repair list.
- `as_of` filters notes by validity window (`valid_from <= as_of <= valid_until`). Invalid ISO timestamps on `after`/`before`/`as_of`/`reference_date` return `400 SCHEMA_INVALID`.
- If `store_meta` mismatches config, this returns `200` with
  `"degraded": "vector search unavailable: <what differs>"` and BM25 + Entity-Graph
  results. **It does not pretend to be healthy and does not silently drop the
  dense leg.**
- With `BRAIN_EMBED=none` it runs in `"mode": "bm25"` (FTS5 BM25 + Entity-Graph).

### `GET /notes` · `GET /files/:path/notes` · `GET /sessions` · `GET /trajectories` · `GET /observations` · `GET /failure-patterns`

List endpoints accept optional hierarchical and user filters (preserving exact
defaults when omitted):

| Endpoint | Default `include_ancestors` | Default `include_children` | Default `include_global` | Extra Params |
|---|---|---|---|---|
| `GET /notes` | `true` | `false` | `true` | `scope`, `project_id`, `user_id`, `type`, `concept`, `file_path`, `limit`, `offset` |
| `GET /files/:path/notes` | `true` | `false` | `true` | `project_id`, `user_id`, `limit` |
| `GET /sessions` | `true` | `false` | `false` | `project_id`, `user_id`, `status`, `agent_name`, `limit` |
| `GET /actions` | `true` | `false` | `true` | `project_id`, `user_id`, `status`, `session_id`, `due_only`, `before`, `limit` |
| `GET /failure-patterns` | `true` | `false` | `true` | `project_id`, `task_type`, `user_id`, `limit` |
| `GET /trajectories` | `true` | `false` | `false` | `project_id`, `scope`, `user_id`, `task_type`, `success`, `rollup_source`, `limit`, `offset` |
| `GET /observations` | `true` | `false` | `false` | `project_id`, `scope`, `user_id`, `session_id`, `failed`, `limit`, `offset` |

### `GET /notes/:id` · `GET /trajectories/:id` · `GET /observations/:id`

Single record. `404` if absent. Derived rows include their `sources`.

### `POST /notes`

Creates a curated note with explicit `scope` (`project | global | unknown`),
optional `user_id`, `agent_id`, `session_id`, `concepts`, `files`, `supersedes`,
and optional UTC ISO-8601 temporal fields `event_at`, `valid_from`, `valid_until`.

---

## Push injection

### `GET /inject`

Everything an agent should know *before* it starts, delivered without asking.
Automatically includes ancestor projects (`include_ancestors: true`) and global
context (`include_global: true`). Accepts `project_id`, `task_type`, `user_id`, `limit`.

```
GET /inject?project_id=acme/socials/calendar&task_type=migration&limit=5
```

```json
{
  "failure_patterns": [
    {"task_type":"migration","error_text":"SqliteError: FOREIGN KEY constraint failed",
     "count":4,"last_seen_at":1762...,"match_tier":"exact"}
  ],
  "prior_outcomes": [ ... recent trajectories, same task_type ... ],
  "ready_actions": [ ... open actions with status in ('ready','in_progress') ... ],
  "due_actions": [ ... open due/reminded actions not snoozed, with overdue flag ... ],
  "latest_session_summary": { ... most recent ended session with non-empty summary (ancestor fallback), or null ... },
  "lessons": [ ... scoped notes, type in ('lesson','bug','pattern') ... ],
  "notes": [ ... scoped notes, type in ('architecture','workflow','preference','fact') ... ],
  "formatted_warnings": "CRITICAL WARNINGS ...",
  "consolidation_warning": "..."
}
```

Counts come from `failure_patterns.count` (SQL), never from a model. Scope is the
named project, its ancestor projects, and `global`.

- `ready_actions`: Open (`ready` or `in_progress`) next actions ordered by priority (`urgent` → `high` → `normal` → `low`) then recency.
- `due_actions`: Open (`ready` or `in_progress`) actions whose `remind_at <= now` or `due_at <= now` and not snoozed (`snooze_until IS NULL OR snooze_until <= now`), with `overdue` and `match_tier` fields.
- `latest_session_summary`: Most recent ended session with a non-empty `summary` for the project (falling back through ancestor projects if none exist on the child, or global if `project_id` is omitted), or `null`.
- `lessons`: Scoped notes with `type` in `('lesson', 'bug', 'pattern')`.
- `notes`: Scoped notes with `type` in `('architecture', 'workflow', 'preference', 'fact')`.
- `formatted_warnings`: Pre-rendered `CRITICAL WARNINGS` block for prompt injection.

---

## Sessions (Short Term)

### `POST /sessions/start`

Starts a new session or reactivates an existing session if `id` already exists.
Accepts optional `user_id` and `agent_id`.

```json
{
  "id": "sess_optional",
  "scope": "project",
  "project_id": "acme/socials/calendar",
  "user_id": "alice",
  "agent_id": "planner-1",
  "agent_name": "claude-code",
  "cwd": "/path/to/repo"
}
```

`201` → `{ "session": { ... } }`

### `POST /sessions/:id/end`

Ends a session, setting `ended_at`, `status` (`active | paused | completed | abandoned`, default `completed`), `files_touched`, and `handoff_summary_id`. If `summary` is omitted, computes a deterministic arithmetic summary from `observations` (Rule 1).

`200` → `{ "session": { ... } }` · `404` if not found.

### `GET /sessions`

Lists sessions. Query parameters: `project_id`, `include_ancestors` (default `true`), `include_children` (default `false`), `include_global` (default `false` when `project_id` is set), `user_id`, `status`, `agent_name`, `limit` (default `50`, max `200`).

`200` → `{ "sessions": [ ... ] }`

### `GET /sessions/:id`

Returns full session details with linked records:

`200` → `{ "session": { ... }, "observations": [ ... ], "notes": [ ... ], "actions": [ ... ] }` · `404` if not found.

### `GET /sessions/:id/replay`

Returns a chronological replay timeline of `observation`, `note`, and `action` items associated with the session:

`200` → `{ "session": { ... }, "timeline": [ { "kind": "observation|note|action", "timestamp": "...", "id": "...", "title": "...", "detail": "...", "meta": { ... } } ] }` · `404` if not found.

---

## Next Actions & Proactive Reminders (Short Term)

### `POST /actions`

Creates a Next Action (with optional scheduling/recurrence) and explicit 3-state `scope` (`project` requires `project_id`).

```json
{
  "title": "Publish weekly social calendar",
  "description": "Verify asset links before Monday send",
  "scope": "project",
  "project_id": "acme/socials/calendar",
  "user_id": "alice",
  "agent_id": "scheduler-1",
  "session_id": "sess_...",
  "status": "ready",
  "priority": "high",
  "blocked_reason": null,
  "files": ["src/app.ts"],
  "due_at": "2026-12-01T15:00:00Z",
  "remind_at": "2026-12-01T14:00:00Z",
  "recurrence": "P1W",
  "snooze_until": null
}
```

- `status`: `ready | blocked | in_progress | done | dismissed` (default `ready`)
- `priority`: `low | normal | high | urgent` (default `normal`)
- `recurrence`: 5-field UTC cron (`0 9 * * 1`), macro (`@hourly | @daily | @midnight | @weekly | @monthly | @yearly | @annually`), or ISO-8601 duration (`P1D`, `P1W`, `P1M`, `PT2H`)

`201` → `{ "action": { ... } }`

### `GET /actions`

Lists Next Actions ordered by priority (`urgent` → `high` → `normal` → `low`), then `created_at DESC`. Query parameters: `project_id`, `include_ancestors` (default `true`), `include_children` (default `false`), `include_global` (default `true`), `user_id`, `status`, `session_id`, `due_only` (`true | 1`), `before` (ISO-8601), `limit` (default `50`, max `200`).

`200` → `{ "actions": [ ... ] }`

### `GET /actions/due`

Lists open (`ready` or `in_progress`) actions whose `remind_at <= cutoff` or `due_at <= cutoff` and not snoozed (`snooze_until IS NULL OR snooze_until <= cutoff`), ordered by earliest `COALESCE(remind_at, due_at)` ASC then priority. Query parameters: `project_id`, `include_ancestors` (default `true`), `include_children` (default `false`), `include_global` (default `true`), `user_id`, `before` (ISO-8601, defaults to now), `unreminded_only`, `cooldown_ms` (or `cooldown` e.g. `30m`), `limit`.

`200` → `{ "actions": [ ... ] }` (each item includes `match_tier` and `overdue`).

### `POST /actions/reminders/check`

Evaluates due unreminded actions (`unremindedOnly: true`, respecting `cooldown_ms` / `cooldown`) and, unless `dry_run: true`, atomically stamps `last_reminded_at` in SQLite. Accepts JSON body: `project_id`, `include_ancestors`, `include_children`, `include_global`, `user_id`, `before`, `cooldown_ms` / `cooldown`, `dry_run`, `limit`.

`200` → `{ "checked_at": "...", "reminders": [ ... ], "marked_count": 2 }`

### `POST /actions/reminders/ack`

Acknowledges delivered reminders (e.g. after webhook delivery in `neuralbrain reminders check --webhook <url>`) by stamping `last_reminded_at` on the specified action IDs. Body: `{ "ids": ["act_..."], "reminded_at": "..." }` (`reminded_at` optional, defaults to now).

`200` → `{ "updated": 1, "reminded_at": "..." }` · `400 SCHEMA_INVALID` if `ids` is missing/not an array.

### `PATCH /actions/:id`

Updates an existing Next Action (`scope`, `project_id`, `user_id`, `agent_id`, `title`, `description`, `status`, `priority`, `blocked_reason`, `files`, `due_at`, `remind_at`, `recurrence`, `snooze_until`, `resolved_by_session_id`). Automatically sets `resolved_at` when `status` transitions to `done` or `dismissed`. When transitioning to `done` on an action with `recurrence`, atomically spawns the next `'ready'` occurrence (`next_occurrence` in response, linked via `parent_action_id`, preserving `due_at - remind_at` lead time).

`200` → `{ "action": { ... } }` · `404` if not found.

---

## Knowledge Graph & Persistent Entities

### `GET /graph`

Returns a scoped knowledge graph built from SQLite notes, lessons, concepts, files, sessions, actions, persistent entities, summaries, and `entity_edges` / `summary_sources`, with 1..3 hop cross-subproject BFS traversal. Query parameters: `project_id`, `scope`, `include_ancestors` (default `true`), `include_children` (default `false`), `include_global` (default `false`), `depth` (`1..3`, default `1`), `node_id`, `entity_type`, `relation`, `user_id`, `limit` (default `80`, max `200`).

```json
{
  "nodes": [
    { "id": "...", "type": "note|lesson|concept|file|session|action|summary|entity|observation|trajectory", "label": "...", "scope": "...", "project_id": "...", "entity_type": "...", "external_ref": "...", "match_tier": "...", "meta": {} }
  ],
  "edges": [
    { "source": "...", "target": "...", "type": "has_concept|touches_file|supersedes|from_session|cites_source|part_of|depends_on|references|owns|produced_by|blocks|related_to|..." }
  ],
  "stats": { "nodeCount": 0, "edgeCount": 0 }
}
```

### `POST /graph/entities`

Creates or updates a persistent entity node with explicit Rule 4 scope, secret redaction, deduplication on `(scope/project_id, entity_type, lower(name))`, and atomic `embed_queue` enqueueing.

```json
{
  "scope": "project",
  "project_id": "acme/socials/generator",
  "entity_type": "asset",
  "name": "Q4 Launch Video",
  "description": "Primary hero asset",
  "external_ref": "s3://acme-assets/q4-launch.mp4",
  "metadata": { "format": "mp4" },
  "user_id": "alice"
}
```

`201` → `{ "entity": { ... } }`

### `GET /graph/entities` · `GET /graph/entities/:id`

- `GET /graph/entities`: Lists entities with hierarchical filters (`project_id`, `scope`, `include_ancestors`, `include_children`, `include_global`, `entity_type`, `external_ref`, `user_id`, `limit`). `200` → `{ "entities": [ ... ] }`.
- `GET /graph/entities/:id`: Returns `{ "entity": { ... } }` or `404 NOT_FOUND`.

### `POST /graph/edges`

Creates or updates a directed edge in `entity_edges` (supports cross-subproject links; auto-resolves `source_type` / `target_type` when omitted).

```json
{
  "source_id": "note_123",
  "target_id": "ent_456",
  "relation": "references",
  "metadata": { "role": "hero" }
}
```

`201` → `{ "edge": { ... } }`

### `DELETE /graph/edges` · `DELETE /graph/edges/:id`

- `DELETE /graph/edges`: Unlinks edges matching body or query `{ id, source_id, target_id, relation }`. `200` → `{ "deleted": 1 }`.
- `DELETE /graph/edges/:id`: Unlinks a single edge by ID. `200` → `{ "deleted": 1 }` or `404 NOT_FOUND` if absent.

### `GET /dashboard/api/graph` & Dashboard BFF Endpoints

Dashboard BFF endpoints (cookie/Bearer auth + CSRF protection on writes):
- `GET /dashboard/api/graph` (same params/payload as `GET /graph`)
- `GET /dashboard/api/graph/entities` · `POST /dashboard/api/graph/entities`
- `POST /dashboard/api/graph/edges` · `DELETE /dashboard/api/graph/edges`
- `GET /dashboard/api/actions/due`

---

## Consolidation

### `GET /consolidate/candidates`

What needs consolidating. Returns claimable work with a lease so two producers
cannot process the same window.

```json
{"candidates":[{"lease_id":"l-77","kind":"session","session_id":"s-4410",
  "observation_ids":["obs_1","..."],"expires_at":1762...}]}
```

### `POST /consolidate/summaries`

Accepts a summary. **This is the verification gate** — see `docs/CONTRACTS.md`.

```json
{
  "lease_id": "l-77",
  "outcome": null,
  "claims": [{"text":"...","source_ids":["obs_1","obs_3"]}],
  "producer_tier": "agent",
  "producer_model": null,
  "prompt_version": "extract-v1"
}
```

`201` on pass. `422` on failure, with the specific reason, and the payload goes
to `dead_letters` against that producer. Never stored unverified.

`outcome` submitted by a producer is **ignored** and recomputed from the source
rows. It is accepted in the payload only so the same contract serves agents that
cannot omit it.

> [!NOTE]
> **`BRAIN_AI_SUMMARIZE` Placeholder**: `BRAIN_AI_SUMMARIZE` is an explicit configuration placeholder (reserved for future session-grain workers; currently no separate table or leasing surface exists for session-grain summaries aside from `/consolidate/*`). It inherits `BRAIN_AI`.

---

## Operations

### `GET /health`

No auth, no rate limit. Reports honestly:

```json
{"status":"ok","db":"ok","qdrant":"ok","embed_queue_pending":12,
 "store_meta":{"match":true,"embed_model_id":"nomic-embed-text-v1.5","embed_dim":512}}
```

`store_meta.match: false` makes `status` `"degraded"`, never `"ok"`.

### `POST /maintenance/cleanup`

Archive and delete per retention settings, in a transaction. Returns counts. A
summarised observation archives rather than deletes when
`BRAIN_KEEP_SUMMARIZED_SOURCES=1`, so derived rows keep verifiable sources.

### `POST /maintenance/rollup-sweep`

Rolls up abandoned sessions: any `session_id` whose newest observation is older
than `BRAIN_ROLLUP_IDLE_MINUTES` (default 30) and which has no trajectory.
Arithmetic only. Idempotent — it selects on "no trajectory exists", so running it
twice is a no-op. Takes optional `idle_minutes` and `limit`; `400` on a
non-positive `idle_minutes`. Returns counts.

Exists because a client that crashes mid-task never sends the explicit rollup
signal, so without this its observations are captured and then never used — never
part of a failure pattern or a prior outcome. A later explicit signal replaces
the swept row.

### `POST /maintenance/reembed`

Starts or resumes a re-embed. Builds a new collection, drains `embed_queue` with
`target` set to it, moves the Qdrant alias on completion, updates `store_meta`
last. `GET` the same path for progress. Resumable: a crash continues from the
queue. The old collection is kept until explicitly dropped.

### `POST /maintenance/rename-project`

Renames a `project_id` across SQLite tables (`observations`, `observations_archive`, `trajectories`, `trajectory_archive`, `notes`, `failure_patterns`, `sessions`, `actions`, `summaries`, `entities`, `consolidation_leases`) and updates `project_id` / `project_ancestors` payloads in Qdrant. Body: `{ "from_project_id": "...", "to_project_id": "..." }`.

### `neuralbrain reminders check` CLI

HTTP-only CLI command (`src/cli.ts`) for cron or webhook-based reminder delivery (never opens SQLite directly):
- `neuralbrain reminders check [--json] [--webhook <url>] [--project <id>] [--include-children] [--no-ancestors] [--no-global] [--cooldown <dur>] [--dry-run] [--limit <n>]`
- Without `--webhook`: calls `POST /actions/reminders/check`.
- With `--webhook`: calls `POST /actions/reminders/check` with `dry_run: true`, POSTs `{ event: "neuralbrain.reminders.due", checked_at, count, reminders }` to the webhook URL, and calls `POST /actions/reminders/ack` only if the webhook returns HTTP 2xx and `--dry-run` is not set.

### `GET /maintenance/api-keys`

Lists active API keys (`id`, `name`, `created_at`, `last_used_at`, `expires_at`).
Strictly omits raw keys and hashes for security.

### `POST /maintenance/api-keys`

Creates a new API key via the single-writer database connection.
Accepts `{ name?: string, expires_in_seconds?: number }`.
Returns `{ id, name, key: rawKey, created_at, expires_at }` with status `201`.
The raw key is returned only upon creation and cannot be retrieved again.

### `DELETE /maintenance/api-keys/:id`

Revokes/deletes an active API key by its `id`. Subsequent requests using this key
fail with `401 Unauthorized`.

### `GET /diagnostics/store`

Read-only inspection of the service's own connection, so `neuralbrain doctor`
never has to open the database file:

```json
{"db":{"ok":true,"journal_mode":"wal"},
 "schema":{"aligned":true,"issues":[]},
 "counts":{"dead_letters":0,"unknown_scope_notes":0,"notes":84,"trajectories":118,"observations":6742}}
```

`schema.issues` includes `PRAGMA foreign_keys is not active` when the service
connection runs without foreign keys.

### `GET /diagnostics/ai`

Runs the conformance fixtures against each configured function and reports
pass/fail per assertion with offending values. Backs `neuralbrain doctor --ai`.

Must never be able to report "N/M passing" and "all checks passing" in the same
response, a failure common to memory-tool health checks. One verdict, computed once.

---

## Error shape

```json
{"error": {"code": "SCOPE_REQUIRED", "message": "...", "trace_id": "..."}}
```

| Status | Meaning |
|---|---|
| `400` | malformed request |
| `401` | missing/invalid key |
| `404` | no such record |
| `422` | failed the verification gate (consolidation only) |
| `429` | rate limited — **never reachable on capture paths** |
| `503` | database unavailable |

`500` must not be returned for a swallowed exception. The inherited code's
`catch (e) {}` in the failure-pattern path is the pattern to avoid: every
handled error logs with its `trace_id`.
