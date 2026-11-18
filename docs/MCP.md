# MCP surface

A thin client of the HTTP API with **no database handle of its own**, so there
stays exactly one write path to validate and audit.

NeuralSwarm has no MCP layer — `src/scripts/shellMcp.ts` is a server it
*provides to* its agents, the opposite direction. This is net-new.

**Eleven tools, on purpose.** Many memory systems expose dozens of tools that
agents never call. Keep the surface to the minimum that does the job; every tool
here has to earn its place.

---

## `brain_search`

Mid-task lookup — the pull half, which NeuralSwarm lacked.

```
q            string   required
grains       string[] note|trajectory|observation|summary   (default: note, trajectory)
project_id   string   omit for global-only (use the project root folder name, e.g. "neuralbrain"; never a subfolder or filesystem path)
include_global boolean default true
type         string[] fact|architecture|pattern|workflow|bug|preference|lesson
file_path    string   "what do we know about this file?"
limit        integer  default 10
```

Returns records with `grain`, `score` and, for derived rows, `sources` so the
agent can verify a claim against what it cites.

Surfaces `"degraded"` verbatim when vector search is unavailable. An agent must
be able to tell BM25-only results from hybrid ones.

## `brain_save`

Write a note deliberately — the one place free prose belongs.

```
type       string  fact|architecture|pattern|workflow|bug|preference|lesson   required
title      string  required
content    string  required
scope      string  project|global|unknown   required, never inferred
project_id string  required iff scope=project (use the project root folder name — .brainrc, else git repo root, main repo for a worktree — e.g. "neuralbrain"; never a subfolder or filesystem path, so all agents derive the same id)
session_id string  optional session ID that authored this note
concepts   string[]
files      string[]
supersedes string  previous note id; edits are supersedes, never in-place
```

**The tool must not default `scope`.** If the agent does not know, it passes
`unknown` and the record is honestly unlabelled — recoverable by one SQL query.
Guessing at scope is how many memory systems end up with records nobody can recover.

## `brain_recent_failures`

Pull equivalent of `/inject`, for when an agent wants it mid-task.

```
project_id string   (use the project root folder name, e.g. "neuralbrain")
task_type  string
limit      integer  default 5
```

Returns `{task_type, error_text, count, last_seen_at}`. `count` is from SQL.

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

Create a Next Action to surface unfinished work, follow-ups, or blockers for
future sessions. Thin wrapper on `POST /actions`.

```
title          string   required
description    string   optional
scope          string   project|global|unknown   required, never inferred
project_id     string   required iff scope=project (use the project root folder name, e.g. "neuralbrain")
session_id     string   optional session ID that created this action
status         string   ready|blocked|in_progress|done|dismissed   (default: ready)
priority       string   low|normal|high|urgent   (default: normal)
blocked_reason string   optional, if status is blocked
files          string[] optional file paths associated with this action
```

## `brain_action_list`

List Next Actions for a project (and optionally global actions), filtered by
status. Thin wrapper on `GET /actions`.

```
project_id     string   (use the project root folder name, e.g. "neuralbrain")
include_global boolean  default true
status         string   optional (e.g. ready, in_progress, blocked, done)
limit          integer  optional
```

## `brain_action_update`

Update an existing Next Action. Thin wrapper on `PATCH /actions/:id`.
Automatically sets `resolved_at` when `status` becomes `done` or `dismissed`.

```
id                     string   required
status                 string   ready|blocked|in_progress|done|dismissed   optional
priority               string   low|normal|high|urgent   optional
title                  string   optional
description            string   optional
blocked_reason         string   optional
resolved_by_session_id string   optional session ID that resolved this action
```

## `brain_sessions`

Inspect prior agent sessions: list sessions, fetch a single session with its
details, or replay a session timeline chronologically. Thin wrapper on
`GET /sessions`, `GET /sessions/:id`, and `GET /sessions/:id/replay`.

```
mode        string   list|get|replay   (default: list)
session_id  string   required when mode is 'get' or 'replay'
project_id  string   optional (use the project root folder name, e.g. "neuralbrain")
status      string   optional (e.g. active, completed, paused, abandoned)
agent_name  string   optional filter by agent name when listing
limit       integer  optional maximum number of sessions to return when listing
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

Explore the relational knowledge graph across notes, lessons, concepts, files,
sessions, actions, and summaries. Thin wrapper on `GET /graph`.

```
project_id  string   optional (use the project root folder name, e.g. "neuralbrain")
scope       string   project|global|unknown   optional
limit       integer  optional maximum number of graph nodes to return
```

---

## What is deliberately absent

| Not shipped | Why |
|---|---|
| `brain_compress` | No capture-path model, ever (rule 1). Not a configuration option. |
| `brain_delete` / `brain_forget` | Destructive, and the store must stay repairable by SQL. Deletion is an operator action, not an agent tool. |
| `brain_score` / `brain_rate` | No model-generated numeric scores. Uncalibrated model scores collapse to a constant and carry no signal. |
| `brain_set_scope` | Scope is set by the writer at write time. A tool to re-scope later is a tool to guess later. |

## Prompt guidance shipped with the server

The tools are only half of it — tools that are reachable but never prompted for go unused. The
MCP server should state, in its instructions:

- call `brain_search` **before** starting non-trivial work, not after failing
- check ready next actions (via `/inject` or `brain_action_list`) at task start
  before picking up work
- `/inject` content arrives unasked at task start; do not re-query for it
- use `brain_sessions` to inspect prior agent sessions or replay a session
  timeline when resuming work
- use `brain_graph` to explore relationships across notes, lessons, concepts,
  files, sessions, actions, and summaries
- save a note when a correction or a non-obvious decision happens, not at
  session end when the detail is gone
- surface unfinished work or blockers via `brain_action_add` so the next session
  can resume cleanly
- call `brain_session_end` at session completion or pause to record a clean
  cross-agent handoff summary
- pass `scope: "unknown"` rather than guessing
- for project scope, `project_id` is the project root folder name (the
  folder holding `.brainrc`, else the git repo root — the main repo for a
  worktree — else the folder the session started in), lowercase, e.g.
  `"neuralbrain"`; never a subfolder you are working in and never a
  filesystem path, so all agents come up with the same id
