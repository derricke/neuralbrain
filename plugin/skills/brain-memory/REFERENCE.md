# neuralbrain Reference

## Core Invariants

1. **No LLM in the capture path**: Observations and trajectories are deterministic and arithmetic.
2. **SQLite is source of truth; Qdrant is an index**: Hybrid retrieval fuses Qdrant dense vectors and in-process BM25 via Reciprocal Rank Fusion (`1 / (60 + rank)`).
3. **Never reject writes for capacity**: No per-session caps; capture endpoints are rate-limit exempt.
4. **Explicit scope, never inferred**: Every `brain_save` and `brain_action_add` requires `scope`: `'project'` (with `project_id`), `'global'` (universal truth), or `'unknown'`.
5. **Three core record types**: `observations` (raw tool calls/prompts), `trajectories` (session outcome rollups), `notes` (curated knowledge, never auto-deleted, edited via `supersedes`).
6. **Derived records are additive and disposable**: Summaries cite source `observations` and never mutate them.

## Canonical `project_id` Resolution

1. Check `.brainrc` or `.brain.json` (`{ "project_id": "<slug>", "auto_subproject": true, "max_depth": 2 }`), walking up directories (stopping at `$HOME` when inside it).
2. Otherwise use the git repository root's folder name (in a git worktree, the **main** repository's folder, not the worktree's).
3. Otherwise use the folder the session started in. Lowercase; never a full filesystem path (e.g. `~/Projects/neuralbrain/src/lib` → `neuralbrain`).
4. Hierarchical slash-path slugs are supported (e.g. `acme/socials/calendar`, max 256 chars). Child subprojects automatically inherit parent context while isolating siblings.
5. Allowed characters per segment: lowercase alphanumerics plus `.`, `_`, `-`, separated by `/`.

## MCP Tools (12 Sanctioned Tools)

### Retrieval & Graph

| Tool | Purpose | Parameters |
|---|---|---|
| `brain_search` | 3-signal hybrid dense + FTS5 BM25 + Entity-Graph RRF search | `q` (req), `record_types` (default `['note', 'trajectory']`; options `'note'`, `'trajectory'`, `'summary'`, `'observation'`, `'entity'`, `'action'`), `project_id`, `include_ancestors` (default `true`), `include_children` (default `false`), `include_global` (default `true`), `include_history` (default `false`), `user_id`, `after`, `before`, `as_of`, `temporal_bias` (`'none' \| 'recent' \| 'upcoming'`), `entity_type`, `memory_layer` (`'semantic' \| 'procedural'`), `type`, `file_path`, `include_sources`, `sources_limit`, `sources_offset`, `limit` |
| `brain_recent_failures` | SQL-counted recent failure patterns | `project_id`, `task_type`, `include_ancestors` (default `true`), `include_children` (default `false`), `include_global` (default `true`), `user_id`, `limit` (default `5`) |
| `brain_graph` | Multi-hop BFS query and entity/edge CRUD | `mode` (`'query' \| 'upsert_entity' \| 'link' \| 'unlink'`, default `'query'`), `project_id`, `scope` (req for `upsert_entity`), `include_ancestors` (default `true`), `include_children` (default `false`), `include_global` (default `false`), `depth` (`1..3`), `node_id`, `entity_type`, `relation`, `user_id`, `agent_id`, `id`, `entity_id`, `name`, `description`, `external_ref`, `metadata`, `source_type`, `source_id`, `target_type`, `target_id`, `limit` |

### Writing & Lessons

| Tool | Purpose | Parameters |
|---|---|---|
| `brain_save` | Save a curated note or lesson | `type` (req: `'fact' \| 'architecture' \| 'pattern' \| 'workflow' \| 'bug' \| 'preference' \| 'lesson'`), `title` (req), `content` (req), `scope` (req: `'project' \| 'global' \| 'unknown'`), `project_id` (req if `scope === 'project'`), `user_id`, `agent_id`, `session_id`, `concepts`, `files`, `supersedes`, `event_at`, `valid_from`, `valid_until` |

### Sessions & Next Actions

| Tool | Purpose | Parameters |
|---|---|---|
| `brain_sessions` | List, fetch, or chronologically replay sessions | `mode` (`'list' \| 'get' \| 'replay'`, default `'list'`), `session_id` (req for `get`/`replay`), `project_id`, `include_ancestors` (default `true`), `include_children` (default `false`), `include_global` (default `false`), `user_id`, `status`, `agent_name`, `limit` |
| `brain_session_end` | End or pause a session with a handoff summary | `session_id` (req), `status` (`'completed' \| 'paused' \| 'abandoned'`), `summary`, `files_touched`, `handoff_summary_id` |
| `brain_action_add` | Create a Next Action or scheduled/recurring reminder | `title` (req), `description`, `scope` (req: `'project' \| 'global' \| 'unknown'`), `project_id` (req if `scope === 'project'`), `user_id`, `agent_id`, `session_id`, `status`, `priority`, `blocked_reason`, `files`, `due_at`, `remind_at`, `recurrence`, `snooze_until` |
| `brain_action_list` | List Next Actions filtered by project/status/due | `project_id`, `include_ancestors` (default `true`), `include_children` (default `false`), `include_global` (default `true`), `due_only`, `before`, `user_id`, `status`, `limit` |
| `brain_action_update` | Update a Next Action (spawns next occurrence when completing recurring action) | `id` (req), `status`, `priority`, `title`, `description`, `blocked_reason`, `resolved_by_session_id`, `due_at`, `remind_at`, `recurrence`, `snooze_until`, `user_id`, `agent_id` |
| `brain_action_due` | List due, reminded, or overdue open Next Actions not snoozed | `project_id`, `include_ancestors` (default `true`), `include_children` (default `false`), `include_global` (default `true`), `before`, `user_id`, `limit` |

### Extractive Consolidation

| Tool | Purpose | Parameters |
|---|---|---|
| `brain_consolidate_candidates` | Lease unconsolidated observation sessions | `project_id`, `limit` |
| `brain_submit_summary` | Submit cited summary to 8-check gate | `lease_id` (req), `claims` (req: `[{ text, source_ids }]`), `files_touched`, `error_verbatim` |

## The 8-Check Consolidation Verification Gate

`brain_submit_summary` (and `POST /consolidate/summaries`) returns `422 Unprocessable Entity` and routes invalid payloads to `dead_letters` if any check fails:

1. **`empty_content`**: Submission and `claims` array must be non-empty.
2. **`truncated`**: Finish reason must not be `length`.
3. **`unparseable`**: Pure JSON only; no markdown code fences or prose outside JSON.
4. **`schema_invalid`**: Rejects forbidden speculative fields (`narrative`, `importance`, `confidence`, `strength`); requires non-empty `text` and `source_ids` on every claim and string array `files_touched`.
5. **`lease_validation`**: `lease_id` must exist in `consolidation_leases`, be uncompleted, and be unexpired.
6. **`citation_unresolved`**: Every `source_id` in `claims` must exist in the leased session's observations.
7. **`not_verbatim` (`error_verbatim`)**: Must match a substring of the leased observations' input or output character-for-character.
8. **`not_verbatim` (`files_touched` & quotes)**: Every `files_touched` entry must match a tool call's target `file_path` in the session; any quoted substring `> 5` chars in claim text must appear verbatim in source observations.
