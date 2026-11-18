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
    "failed": 0
  }]
}
```

`201` → `{"accepted": 1, "ids": ["obs_..."], "rejected": []}`

**Rules this endpoint must obey:**

- **Exempt from rate limiting.** Hook-driven capture exceeds 100/min in seconds,
  and rule 3 forbids rejecting a write for volume.
- **No truncation, no model, no inference.** Store `input`/`output` whole.
- **`scope` is required and never guessed.** Omitted → `"unknown"`, never
  `"global"`. Defaulting to global would put unlabelled records into every
  project's injection.
- **`project_id` is normalised and echoed back.** Trimmed, lowercased,
  whitespace to `-`, charset `[a-z0-9._-]`. A path or an unsupported character
  is a `400`, not a silent conversion — so a client learns its id is wrong
  rather than quietly writing to a second project. The error hints say to
  use the project root folder name (from `.brainrc`, else the git repo root —
  the main repo for a worktree), never a subfolder, e.g. 'neuralbrain', so all
  agents come up with the same id. The response carries the
  stored form.
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

Hybrid: dense + BM25, fused with RRF.

```json
{
  "q": "foreign key constraint failed on migration",
  "grains": ["note","trajectory"],
  "scope": "project",
  "project_id": "neuralbrain",
  "include_global": true,
  "filters": { "type": ["bug","pattern"], "file_path": "src/lib/db.ts" },
  "limit": 10
}
```

`200` → results carrying `grain`, `score`, the record, and `sources` for derived
rows.

- `include_global: true` merges `scope='global'` with the named project. It
  never includes `scope='unknown'` — those are surfaced only by an explicit
  `scope: "unknown"` query, which doubles as the repair list.
- If `store_meta` mismatches config, this returns `200` with
  `"degraded": "vector search unavailable: <what differs>"` and BM25-only
  results. **It does not pretend to be healthy and does not silently drop the
  dense leg.**
- With `BRAIN_EMBED=none` it is BM25-only by design, reported as
  `"mode": "bm25"`.

### `GET /notes/:id` · `GET /trajectories/:id` · `GET /observations/:id`

Single record. `404` if absent. Derived rows include their `sources`.

### `GET /files/:path/notes`

What do we know about this file? Highest-value question at task start; backed by
the `note_files` join table.

---

## Push injection

### `GET /inject`

The half NeuralSwarm got right. Everything an agent should know *before* it
starts, delivered without asking.

```
GET /inject?project_id=X&task_type=migration&limit=5
```

```json
{
  "failure_patterns": [
    {"task_type":"migration","error_text":"SqliteError: FOREIGN KEY constraint failed",
     "count":4,"last_seen_at":1762...}
  ],
  "prior_outcomes": [ ... recent trajectories, same task_type ... ],
  "ready_actions": [ ... open actions with status in ('ready','in_progress') ... ],
  "latest_session_summary": { ... most recent ended session with non-empty summary, or null ... },
  "lessons": [ ... scoped notes, type in ('lesson','bug','pattern') ... ],
  "notes": [ ... scoped notes, type in ('architecture','workflow','preference','fact') ... ],
  "formatted_warnings": "CRITICAL WARNINGS ..."
}
```

Counts come from `failure_patterns.count` (SQL), never from a model. Scope is the
named project plus `global`.

- `ready_actions`: Open (`ready` or `in_progress`) next actions ordered by priority (`urgent` → `high` → `normal` → `low`) then recency.
- `latest_session_summary`: Most recent ended session with a non-empty `summary` for the project (or global if `project_id` is omitted), or `null`.
- `lessons`: Scoped notes with `type` in `('lesson', 'bug', 'pattern')`.
- `notes`: Scoped notes with `type` in `('architecture', 'workflow', 'preference', 'fact')`.
- `formatted_warnings`: Pre-rendered `CRITICAL WARNINGS` block for prompt injection.

---

## Sessions (Short Term)

### `POST /sessions/start`

Starts a new session or reactivates an existing session if `id` already exists.

```json
{
  "id": "sess_optional",
  "scope": "project",
  "project_id": "neuralbrain",
  "agent_name": "claude-code",
  "cwd": "/path/to/repo"
}
```

`201` → `{ "session": { ... } }`

### `POST /sessions/:id/end`

Ends a session, setting `ended_at`, `status` (`active | paused | completed | abandoned`, default `completed`), `files_touched`, and `handoff_summary_id`. If `summary` is omitted, computes a deterministic arithmetic summary from `observations` (Rule 1).

`200` → `{ "session": { ... } }` · `404` if not found.

### `GET /sessions`

Lists sessions. Query parameters: `project_id`, `status`, `agent_name`, `limit` (default `50`, max `200`).

`200` → `{ "sessions": [ ... ] }`

### `GET /sessions/:id`

Returns full session details with linked records:

`200` → `{ "session": { ... }, "observations": [ ... ], "notes": [ ... ], "actions": [ ... ] }` · `404` if not found.

### `GET /sessions/:id/replay`

Returns a chronological replay timeline of `observation`, `note`, and `action` items associated with the session:

`200` → `{ "session": { ... }, "timeline": [ { "kind": "observation|note|action", "timestamp": "...", "id": "...", "title": "...", "detail": "...", "meta": { ... } } ] }` · `404` if not found.

---

## Next Actions (Short Term)

### `POST /actions`

Creates a Next Action with explicit 3-state `scope` (`project` requires `project_id`).

```json
{
  "title": "Re-run smoke tests after schema change",
  "description": "Verify /inject returns ready_actions",
  "scope": "project",
  "project_id": "neuralbrain",
  "session_id": "sess_...",
  "status": "ready",
  "priority": "high",
  "blocked_reason": null,
  "files": ["src/app.ts"]
}
```

- `status`: `ready | blocked | in_progress | done | dismissed` (default `ready`)
- `priority`: `low | normal | high | urgent` (default `normal`)

`201` → `{ "action": { ... } }`

### `GET /actions`

Lists Next Actions ordered by priority (`urgent` → `high` → `normal` → `low`), then `created_at DESC`. Query parameters: `project_id`, `include_global` (default `true`), `status`, `session_id`, `limit` (default `50`, max `200`).

`200` → `{ "actions": [ ... ] }`

### `PATCH /actions/:id`

Updates an existing Next Action (`scope`, `project_id`, `title`, `description`, `status`, `priority`, `blocked_reason`, `files`, `resolved_by_session_id`). Automatically sets `resolved_at` when `status` transitions to `done` or `dismissed`.

`200` → `{ "action": { ... } }` · `404` if not found.

---

## Knowledge Graph

### `GET /graph`

Returns a scoped knowledge graph built from SQLite notes, lessons, concepts, files, sessions, actions, summaries, and `summary_sources` citations. Query parameters: `project_id`, `scope`, `limit` (default `80`, max `200`).

```json
{
  "nodes": [
    { "id": "...", "type": "note|lesson|concept|file|session|action|summary", "label": "...", "scope": "...", "project_id": "...", "meta": {} }
  ],
  "edges": [
    { "source": "...", "target": "...", "type": "has_concept|touches_file|supersedes|from_session|cites_source" }
  ],
  "stats": { "nodeCount": 0, "edgeCount": 0 }
}
```

### `GET /dashboard/api/graph`

Dashboard BFF endpoint returning the same `{ nodes, edges, stats }` knowledge graph payload for the Dashboard `Graph` tab (accepts the same `project_id`, `scope`, `limit` query parameters).

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

### `GET /diagnostics/ai`

Runs the conformance fixtures against each configured function and reports
pass/fail per assertion with offending values. Backs `brain doctor --ai`.

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
