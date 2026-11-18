# neuralbrain Reference

## Core Invariants

1. **No LLM in the capture path**: Observations and trajectories are deterministic and arithmetic.
2. **SQLite is source of truth; Qdrant is an index**: Hybrid retrieval fuses Qdrant dense vectors and in-process BM25 via Reciprocal Rank Fusion (`1 / (60 + rank)`).
3. **Never reject writes for capacity**: No per-session caps; capture endpoints are rate-limit exempt.
4. **Explicit scope, never inferred**: Every `brain_save` and `brain_action_add` requires `scope`: `'project'` (with `project_id`), `'global'` (universal truth), or `'unknown'`.
5. **Three grains**: `observations` (raw tool calls/prompts), `trajectories` (session outcome rollups), `notes` (curated knowledge, never auto-deleted, edited via `supersedes`).
6. **Derived records are additive and disposable**: Summaries cite source `observations` and never mutate them.

## Canonical `project_id` Resolution

1. Check `.brainrc` or `.brain.json` (`{ "project_id": "<slug>" }`), walking up all parent directories.
2. Otherwise use the git repository root's folder name (in a git worktree, the **main** repository's folder, not the worktree's).
3. Otherwise use the folder the session started in. Lowercase; never a subfolder you happen to be in, never a full filesystem path (e.g. `~/Projects/neuralbrain/src/lib` → `neuralbrain`).
4. If the root is ambiguous, create `.brainrc` at the root (`neuralbrain init`) rather than guessing; for a single uncertain write use `scope: "unknown"`.
5. Allowed characters: lowercase alphanumerics plus `.`, `_`, `-`.

## MCP Tools (11 Sanctioned Tools)

### Retrieval & Graph

| Tool | Purpose | Parameters |
|---|---|---|
| `brain_search` | Hybrid dense + BM25 search across grains | `q` (req), `record_types` (default `['note', 'trajectory']`; options `'note'`, `'trajectory'`, `'summary'`, `'observation'`), `project_id`, `include_global` (default `true`), `type` (`fact`, `architecture`, `pattern`, `workflow`, `bug`, `preference`, `lesson`), `file_path`, `limit` (default `10`) |
| `brain_recent_failures` | SQL-counted recent failure patterns | `project_id`, `task_type`, `limit` (default `5`) |
| `brain_graph` | Relational graph across notes, lessons, concepts, files, sessions, actions, summaries | `project_id`, `scope` (`'project' \| 'global' \| 'unknown'`), `limit` |

### Writing & Lessons

| Tool | Purpose | Parameters |
|---|---|---|
| `brain_save` | Save a curated note or lesson | `type` (req: `'fact' \| 'architecture' \| 'pattern' \| 'workflow' \| 'bug' \| 'preference' \| 'lesson'`), `title` (req), `content` (req), `scope` (req: `'project' \| 'global' \| 'unknown'`), `project_id` (req if `scope === 'project'`), `session_id`, `concepts`, `files`, `supersedes` |

### Sessions & Next Actions

| Tool | Purpose | Parameters |
|---|---|---|
| `brain_sessions` | List, fetch, or chronologically replay sessions | `mode` (`'list' \| 'get' \| 'replay'`, default `'list'`), `session_id` (req for `get`/`replay`), `project_id`, `status` (`'active' \| 'completed' \| 'paused' \| 'abandoned'`), `agent_name`, `limit` |
| `brain_session_end` | End or pause a session with a handoff summary | `session_id` (req), `status` (`'completed' \| 'paused' \| 'abandoned'`), `summary`, `files_touched`, `handoff_summary_id` |
| `brain_action_add` | Create a Next Action for future sessions | `title` (req), `description`, `scope` (req: `'project' \| 'global' \| 'unknown'`), `project_id` (req if `scope === 'project'`), `session_id`, `status` (`'ready' \| 'blocked' \| 'in_progress' \| 'done' \| 'dismissed'`), `priority` (`'low' \| 'normal' \| 'high' \| 'urgent'`), `blocked_reason`, `files` |
| `brain_action_list` | List Next Actions filtered by project/status | `project_id`, `include_global`, `status`, `limit` |
| `brain_action_update` | Update a Next Action's status, priority, or details | `id` (req), `status`, `priority`, `title`, `description`, `blocked_reason`, `resolved_by_session_id` |

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
