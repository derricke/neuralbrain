# MCP surface

A thin client of the HTTP API with **no database handle of its own**, so there
stays exactly one write path to validate and audit. (Inside the service process,
`POST /mcp` uses `createDirectBrainMcpHandlers` in `src/routes/mcp.ts` with 100%
tool parity.)

NeuralSwarm has no MCP layer — `src/scripts/shellMcp.ts` is a server it
*provides to* its agents, the opposite direction. This is net-new.

**Twelve tools, on purpose.** Many memory systems expose dozens of tools that
agents never call. Keep the surface to the minimum that does the job; every tool
here has to earn its place.

---

## `brain_search`

Mid-task lookup — the pull half, which NeuralSwarm lacked. Uses 3-signal
Reciprocal Rank Fusion (Qdrant dense vectors + SQLite FTS5 BM25 + Entity-Graph
1-hop expansion) with hierarchical tier boosting (`exact > parent > grandparent >
global > child`) and temporal filters.

```
q                 string   required
record_types      string[] note|trajectory|observation|summary|entity|action (default: ['note', 'trajectory'])
project_id        string   omit for global-only (flat slug e.g. "neuralbrain" or hierarchical e.g. "acme/socials/calendar"; never a filesystem path)
include_ancestors boolean  default true
include_children  boolean  default false
include_global    boolean  default true
include_history   boolean  default false
user_id           string   optional user_id filter
after             string   optional ISO-8601 lower bound timestamp filter
before            string   optional ISO-8601 upper bound timestamp filter
as_of             string   optional ISO-8601 validity filter for notes (valid_from <= as_of <= valid_until)
temporal_bias     string   none|recent|upcoming (optional)
entity_type       string   optional entity_type filter (e.g. brand, person, asset, metric, document, tool)
memory_layer      string   semantic|procedural (optional note layer filter)
type              string[] fact|architecture|pattern|workflow|bug|preference|lesson
file_path         string   "what do we know about this file?"
include_sources   boolean  default false (summary source provenance)
sources_limit     integer  default 20 (1..100)
sources_offset    integer  default 0
limit             integer  default 10 (1..100)
```

Returns records with `record_type`, `score`, `project_id`, `match_tier`, optional
`matched_entities` (for Entity-Graph hits), and for derived rows `claims` /
`sources` so the agent can verify a claim against what it cites.

Surfaces `"degraded"` verbatim when vector search is unavailable. An agent must
be able to tell BM25-only results from hybrid ones.

## `brain_save`

Write a note deliberately — the one place free prose belongs.

```
type        string   fact|architecture|pattern|workflow|bug|preference|lesson   required
title       string   required
content     string   required
scope       string   project|global|unknown   required, never inferred
project_id  string   required iff scope=project (flat slug or hierarchical path e.g. "acme/socials/calendar"; never a filesystem path)
user_id     string   optional user_id attribution
agent_id    string   optional agent_id provenance (stored, never filtered)
session_id  string   optional session ID that authored this note
concepts    string[]
files       string[]
supersedes  string   previous note id; edits are supersedes, never in-place
event_at    string   optional ISO-8601 timestamp when the event occurred
valid_from  string   optional ISO-8601 start of fact validity window
valid_until string   optional ISO-8601 end of fact validity window
```

**The tool must not default `scope`.** If the agent does not know, it passes
`unknown` and the record is honestly unlabelled — recoverable by one SQL query.
Guessing at scope is how many memory systems end up with records nobody can recover.

## `brain_recent_failures`

Pull equivalent of `/inject`, for when an agent wants it mid-task.

```
project_id        string   (flat or hierarchical project_id, e.g. "acme/socials/calendar")
task_type         string
include_ancestors boolean  default true
include_children  boolean  default false
include_global    boolean  default true
user_id           string   optional user_id filter
limit             integer  default 5 (1..200)
```

Returns `{task_type, error_text, count, last_seen_at, project_id, match_tier}[]`. `count` is from SQL.

## `brain_consolidate_candidates`

What needs consolidating, with a lease. Many memory systems never offer this —
they consolidate internally with their own API key while the agent with better
context sits idle.

```
project_id string   (use the project root folder name, e.g. "neuralbrain")
limit      integer  optional
```

Returns `lease_id`, the source records, and `expires_at`.

## `brain_submit_summary`

Post a summary back. Thin wrapper on `POST /consolidate/summaries`, so the same
verification gate applies to an agent as to a local model.

```
lease_id       string   required
claims         object[] {text, source_ids[]}   required
files_touched  string[] optional
error_verbatim string|null optional
```

A `422` is returned to the agent **with the specific failure** — which citation
did not resolve, which string was not verbatim. An agent that can see why it
failed can retry correctly. Silently accepting bad output is how bad rows
accumulate.

## `brain_action_add`

Create a Next Action (or scheduled/recurring reminder) to surface unfinished work,
follow-ups, or blockers for future sessions. Thin wrapper on `POST /actions`.

```
title          string   required
description    string   optional
scope          string   project|global|unknown   required, never inferred
project_id     string   required iff scope=project (flat or hierarchical slug e.g. "acme/socials/calendar")
user_id        string   optional user_id attribution
agent_id       string   optional agent_id provenance (stored, never filtered)
session_id     string   optional session ID that created this action
status         string   ready|blocked|in_progress|done|dismissed   (default: ready)
priority       string   low|normal|high|urgent   (default: normal)
blocked_reason string   optional, if status is blocked
files          string[] optional file paths associated with this action
due_at         string   optional ISO-8601 due date/time (normalized to UTC)
remind_at      string   optional ISO-8601 reminder trigger date/time (normalized to UTC)
recurrence     string   optional UTC cron, macro (@daily, @weekly), or ISO-8601 duration (P1D, P1W, PT2H)
snooze_until   string   optional ISO-8601 timestamp until which reminders are snoozed
```

## `brain_action_list`

List Next Actions for a project (and optionally ancestors, children, and global
actions), filtered by status, `due_only`, `before`, or `user_id`. Thin wrapper
on `GET /actions`.

```
project_id        string   (flat or hierarchical slug)
include_ancestors boolean  default true
include_children  boolean  default false
include_global    boolean  default true
due_only          boolean  optional (only open due/reminded actions not snoozed)
before            string   optional ISO-8601 upper bound cutoff for due_at / remind_at
user_id           string   optional user_id filter
status            string   optional (e.g. ready, in_progress, blocked, done)
limit             integer  optional (1..200)
```

## `brain_action_update`

Update an existing Next Action. Thin wrapper on `PATCH /actions/:id`.
Automatically sets `resolved_at` when `status` becomes `done` or `dismissed`,
and spawns `next_occurrence` when completing a recurring action.

```
id                     string        required
status                 string        ready|blocked|in_progress|done|dismissed   optional
priority               string        low|normal|high|urgent   optional
title                  string        optional
description            string        optional
blocked_reason         string        optional
resolved_by_session_id string        optional session ID that resolved this action
due_at                 string|null   optional (pass null to clear)
remind_at              string|null   optional (pass null to clear)
recurrence             string|null   optional (pass null to clear)
snooze_until           string|null   optional (pass null to clear)
user_id                string|null   optional
agent_id               string|null   optional
```

## `brain_action_due`

List due, reminded, or overdue open Next Actions (`status IN ('ready', 'in_progress')`
and not snoozed past cutoff). Thin wrapper on `GET /actions/due`.

```
project_id        string   (flat or hierarchical slug)
include_ancestors boolean  default true
include_children  boolean  default false
include_global    boolean  default true
before            string   optional ISO-8601 cutoff (defaults to now)
user_id           string   optional user_id filter
limit             integer  optional (1..200)
```

Returns `{ actions }` where each action includes `match_tier` and `overdue` boolean.

## `brain_sessions`

Inspect prior agent sessions: list sessions, fetch a single session with its
details, or replay a session timeline chronologically. Thin wrapper on
`GET /sessions`, `GET /sessions/:id`, and `GET /sessions/:id/replay`.

```
mode              string   list|get|replay   (default: list)
session_id        string   required when mode is 'get' or 'replay'
project_id        string   optional (flat or hierarchical slug)
include_ancestors boolean  default true
include_children  boolean  default false
include_global    boolean  default false
user_id           string   optional user_id filter
status            string   optional (e.g. active, completed, paused, abandoned)
agent_name        string   optional filter by agent name when listing
limit             integer  optional maximum number of sessions to return when listing
```

## `brain_session_end`

End or pause a session and record a clean cross-agent handoff summary, files
touched, and optional `handoff_summary_id`. Thin wrapper on
`POST /sessions/:id/end`.

```
session_id          string   required
status              string   completed|paused|abandoned   optional
summary             string   optional handoff summary for the next agent or session
files_touched       string[] optional files touched during this session
handoff_summary_id  string   optional derived summary ID linked as handoff
```

## `brain_graph`

Explore or mutate the relational knowledge graph across notes, lessons, concepts,
files, sessions, actions, persistent entities, and summaries. Supports multi-hop
BFS (`depth: 1..3`) across subprojects via `entity_edges`, plus entity/edge
creation and unlinking. Thin wrapper on `GET /graph`, `POST /graph/entities`,
`POST /graph/edges`, and `DELETE /graph/edges`.

```
mode              string        query|upsert_entity|link|unlink   (default: query)
project_id        string        optional for query; required iff mode=upsert_entity & scope=project
scope             string        project|global|unknown (REQUIRED when mode=upsert_entity)
include_ancestors boolean       default true (query mode)
include_children  boolean       default false (query mode)
include_global    boolean       default false (query mode)
depth             integer       1..3 (BFS hop depth over entity_edges, default 1)
node_id           string        optional focal node ID for query mode
entity_type       string        required for upsert_entity (e.g. brand|person|asset|metric|document|tool); optional filter for query
relation          string        required for link (e.g. part_of|depends_on|references|owns|produced_by|blocks|related_to); optional filter for query/unlink
user_id           string        optional user_id attribution/filter
agent_id          string        optional agent_id provenance (stored, never filtered)
id                string        optional entity ID (upsert_entity) or edge ID (unlink)
entity_id         string        optional alias for entity ID (upsert_entity)
name              string        required when mode=upsert_entity
description       string        optional (upsert_entity)
external_ref      string        optional external URI/pointer (upsert_entity, e.g. s3://..., https://...)
metadata          object|string optional JSON metadata (upsert_entity / link)
source_type       string        optional source node type for link (auto-resolved if omitted)
source_id         string        source node ID (required for link, optional for unlink)
target_type       string        optional target node type for link (auto-resolved if omitted)
target_id         string        target node ID (required for link, optional for unlink)
limit             integer       optional maximum number of seed graph nodes to return (1..200)
```

---

## What is deliberately absent

| Not shipped | Why |
|---|---|
| `brain_compress` | No capture-path model, ever (rule 1). Not a configuration option. |
| `brain_delete` / `brain_forget` | Destructive, and the store must stay repairable by SQL. Deletion is an operator action, not an agent tool (only `brain_graph` `mode: 'unlink'` removes a graph edge). |
| `brain_score` / `brain_rate` | No model-generated numeric scores. Uncalibrated model scores collapse to a constant and carry no signal. |
| `brain_set_scope` | Scope is set by the writer at write time. A tool to re-scope later is a tool to guess later. |

## Prompt guidance shipped with the server

The tools are only half of it — tools that are reachable but never prompted for go unused. The
MCP server states, in `MCP_INSTRUCTIONS`:

- call `brain_search` **before** starting non-trivial work, not after failing
- include `record_types: ["summary"]` (or `["note", "trajectory", "summary"]`) in `brain_search` when resuming prior work on a file, debugging a recurring error, or when no curated notes exist yet
- check ready and due next actions (via `/inject`, `brain_action_due`, or `brain_action_list`) at task start before picking up work
- `/inject` content arrives unasked at task start; do not re-query for it
- use `brain_sessions` to inspect prior agent sessions or replay a session timeline when resuming work
- use `brain_graph` to explore multi-hop relationships or upsert/link persistent entities (`upsert_entity`, `link`, `unlink`) across notes, lessons, concepts, files, sessions, actions, entities, and summaries
- save a note when a correction or a non-obvious decision happens, not at session end when the detail is gone
- surface unfinished work, blockers, or scheduled follow-ups (`due_at`, `remind_at`, `recurrence`, `snooze_until`) via `brain_action_add` / `brain_action_update` and check overdue items with `brain_action_due`
- call `brain_session_end` at session completion or pause to record a clean cross-agent handoff summary
- pass `scope: "unknown"` rather than guessing
- for project scope, `project_id` is the project root folder name or hierarchical slash-path slug (e.g. `"neuralbrain"` or `"acme/socials/calendar"`, from `.brainrc`, else the git repo root — the main repo for a worktree — else the folder the session started in), lowercase, never a filesystem path, so all agents come up with the same id; child subprojects automatically inherit parent project context while isolating sibling subprojects
