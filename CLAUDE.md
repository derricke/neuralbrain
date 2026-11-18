# Neuralbrain

> **Navigation & Documentation Map.** This file is the constitution — fundamental rules, architectural invariants,
> and operational commands. For detailed domain specifications, see:
>
> | Document | Topic |
> |---|---|
> | [docs/SCHEMA.md](docs/SCHEMA.md) | SQLite DDL, indexes, triggers, and Qdrant payload schema |
> | [docs/API.md](docs/API.md) | HTTP REST API endpoints, schemas, and status codes |
> | [docs/MCP.md](docs/MCP.md) | Model Context Protocol tool definitions and usage guide |
> | [docs/CONTRACTS.md](docs/CONTRACTS.md) | Consolidation JSON schemas and gate interface specifications |
> | [docs/EMBEDDER.md](docs/EMBEDDER.md) | Vector embedder architecture, MRL math, benchmarks, and atomic cutovers |
> | [docs/CONSOLIDATION.md](docs/CONSOLIDATION.md) | Derived consolidation, prompt comparisons, and token traps |
> | [docs/DIVERGENCES.md](docs/DIVERGENCES.md) | Preserved components and schema divergences from NeuralSwarm |

A standalone memory service — a "brain" — for coding agents. Extracted from the NeuralSwarm agent-coding orchestrator and generalised.

NeuralSwarm's memory was scoped to **swarms, roles and LLM providers**. This is scoped to **projects, notes and tasks**, and serves any agent (Claude Code, Claude Desktop, Antigravity, Cursor, etc.). [NeuralSwarm](https://github.com/derricke/neuralswarm) was treated as read-only source material, not a specification; divergences were made wherever design rules required (detailed in [docs/DIVERGENCES.md](docs/DIVERGENCES.md)).

---

## Why This Exists

Many agent memory systems fail in the same four ways. Each one maps to a non-negotiable design rule below. Do not reintroduce them.

| Failure | What Happens |
|---|---|
| **LLM in the write path** | Records are rewritten by an LLM on ingest. The summariser hallucinates into the record and the raw input is lost; when compression is switched off to stop the damage, the store stops growing. |
| **Scope by inference** | Records are written without a stated scope and the system guesses later. "No project" and "applies everywhere" become indistinguishable, so a backfill cannot recover intent and project filtering returns nothing. |
| **Lossy capture** | A per-session observation cap is meant to be relieved by consolidation. When consolidation is off or failing, every write past the cap is silently dropped. |
| **Unaddressable store** | No way to inspect or repair a record with SQL, and health checks that contradict themselves ("6/10 passing" and "all checks passing" in the same run). |

---

## Non-Negotiable Design Rules

1. **No LLM in the capture path.** Records are structured columns. Rollups are arithmetic: count tool calls, sum durations, take the first prompt as the description, derive success from whether a failure hook fired. Nothing between a client's POST and the committed row may hallucinate. (Generative models are permitted solely for producing **derived** records under Rule 6).
2. **SQLite is the source of truth. Qdrant is an index.** Every record must be inspectable and repairable with standard SQL. If Qdrant is lost, it is rebuilt from SQLite. **The database file is opened by the brain service and by nothing else** — see "Database access" below.
3. **Never reject a write for capacity.** No per-session caps. No rate limit on capture (`POST /capture/*` is exempt). Backpressure is acceptable; rejection is not. Dead letters are strictly for **malformed** records — never for volume or dependency outages.
4. **Explicit scope, never inferred — and "global" is not "unknown".** The writer states scope as one of three values: `project` (with a non-empty `project_id`), `global` (deliberately universal), or `unknown` (writer omitted scope). Never guess or backfill by inference. When determining `project_id`, error messages and hints guide agents to use the name of the project's **root** folder — the folder containing `.brainrc` if present, otherwise the git repository root (for a git worktree, the main repository's folder, not the worktree's), otherwise the folder the session started in — lowercase, never a subfolder and never a filesystem path (e.g. working in `~/Projects/neuralbrain/src/lib` or a worktree of it → `neuralbrain`), so all agents come up with the same id. Plugin hooks pin one `project_id` per session. If the root is ambiguous, create a `.brainrc` at the root (`neuralbrain init`) rather than guessing.
5. **Three grains, one schema.**
   - `observations`: Machine-written tool calls and prompts. High volume. Archive at 30 days, purge at 90 days.
   - `trajectories`: Machine-written task attempts with arithmetic outcome metrics. Low volume, long retention.
   - `notes`: Curated knowledge (facts, decisions, patterns, bugs, workflows, preferences). Authored deliberately, scoped per Rule 4, **never auto-deleted**.
   - Observations roll up into trajectories arithmetically (Rule 1). Notes are authored on purpose and edited by supersede.
6. **Derived records are additive, attributed and disposable.** A summary is a new row that cites its sources in `summary_sources`. It never mutates or replaces source records. The store remains fully functional with every derived row deleted. Nothing load-bearing depends on consolidation.

---

## Database Access: One Process, One Connection

**Nothing but the brain service opens the database file for writing. Not a client, not a script, not a test, not an operator with `sqlite3`.**

Rule 2 requires transparent data structure; this rule requires a single writer connection (`WAL` mode, `foreign_keys = ON`). SQL stays the repair language; the service stays the only writer.

### Why Direct Writes Cause Silent Partial State

Bypassing the service connection causes silent, undetectable desynchronisation:
- **`embed_queue` bypass**: The row exists in SQLite but **never in Qdrant**. It becomes permanently invisible to vector search without raising errors.
- **`failure_patterns` UPSERT bypass**: A failure pattern is omitted from push injection.
- **Dead-letter routing bypass**: Malformed payloads land in primary tables rather than `dead_letters`.
- **`foreign_keys = ON` bypass**: External connections omitting the pragma insert invalid relations.
- **Tracing omission**: Missing `trace_id` destroys auditability.

### Allowed Access
- **The service**: Read-write connection.
- **Read-only diagnosis**: Opened with `file:...?mode=ro` when the service is stopped.
- **Operational repairs**: Execute via `POST /maintenance/*` endpoints and the CLI.
- **Tests**: Strictly `:memory:` or OS temp files. Enforced by `getDb()` in `src/lib/db.ts`, which refuses repository paths during test runs.

---

## Implemented Architecture

```
                               ┌────────────────────────────────┐
                               │     Client (Agent / IDE)       │
                               └───────┬────────────────┬───────┘
                                       │                │
                        stdio / JSON-RPC│                │ HTTP REST
                                       ▼                │ (spool fallback)
                               ┌────────────────┐       │
                               │   MCP Server   │       │
                               │(Thin REST Cli) │       │
                               └───────┬────────┘       │
                                       │ HTTP REST      │
                                       ▼                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Neuralbrain Service (Port 3737)                                             │
│                                                                             │
│  [Middleware Pipeline]                                                      │
│    Tracing (trace_id) ──> RateLimiter (Exempt: /capture, /health) ──> Auth   │
│                                                                             │
│  [Core Endpoints]                                                           │
│    POST /capture/observations, /capture/trajectories                        │
│    POST /sessions/start, /sessions/:id/end · GET /sessions, /sessions/:id*  │
│    POST /actions · GET /actions · PATCH /actions/:id                        │
│    GET  /inject (Failure patterns, outcomes, ready actions, summary, notes) │
│    POST /search (Hybrid dense vector + in-process BM25 via RRF)             │
│    GET  /graph  (Knowledge graph across notes, sessions, actions, summaries)│
│    GET  /consolidate/candidates  &  POST /consolidate/summaries (Gate)      │
│    GET  /dashboard  (CSP-secured Operator UI)                               │
│    POST /maintenance/{reembed, rollup-sweep, cleanup, api-keys}             │
│                                                                             │
│  [Storage Engine]                            [Vector & AI Engine]           │
│    SQLite (node:sqlite, WAL, FKs)              In-process nomic ONNX        │
│    Relational Tables (sessions, actions,       Matryoshka LayerNorm/Slice/L2│
│     notes, observations, trajectories, etc.)   Qdrant Client (Port 6333)    │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Memory Layers**:
  - **Long Term**: Curated `notes` (`fact`, `architecture`, `pattern`, `workflow`, `bug`, `preference`) and `lesson` records (`notes.type = 'lesson'`), versioned by supersede and never auto-deleted.
  - **Short Term**: `sessions` lifecycle (`POST /sessions/start`, `/sessions/:id/end`, `/sessions/:id/replay`), `actions` (Next Actions queue via `/actions`), and deterministic arithmetic session summaries.
  - **Observations**: High-volume `observations` (30d archive / 90d purge), arithmetic `trajectories`, and derived `summaries`.
  - **Knowledge Graph**: Relational graph across notes, lessons, concepts, files, sessions, actions, and summaries (`GET /graph` and `GET /dashboard/api/graph`).
- **HTTP API**: The single ingress point. Validates schemas, enforces scope, handles auth, and logs traces.
- **Client Spool (`src/lib/spool.ts`)**: Local client JSONL spool for network transport failures (5 MB cap, 168h max age, dedupe, flush).
- **Thin MCP Server (`src/mcp/server.ts`)**: Pure REST client with zero direct DB access (`import` from `../lib/db` forbidden). Exposes 11 sanctioned tools: `brain_search`, `brain_save`, `brain_recent_failures`, `brain_consolidate_candidates`, `brain_submit_summary`, `brain_action_add`, `brain_action_list`, `brain_action_update`, `brain_sessions`, `brain_session_end`, `brain_graph`.
- **Hybrid Retrieval**: Combines dense Qdrant vector retrieval and in-process BM25 lexical ranking fused via Reciprocal Rank Fusion ($1 / (60 + \text{rank})$).
- **Push & Pull Delivery**:
  - *Push* (`GET /inject`): Scoped failure patterns (atomic SQL UPSERTs), prior outcomes, `ready_actions`, `latest_session_summary`, `lessons`, `notes`, and `formatted_warnings` (`CRITICAL WARNINGS` block).
  - *Pull* (`POST /search` / `brain_search`): Mid-task hybrid semantic search.
- **Web Operator Dashboard (`GET /dashboard`)**: Built-in, zero-dependency operator UI.

### User Directory (`~/.neuralbrain/` / `BRAIN_HOME`)

User-level state and configuration live in `~/.neuralbrain/` by default (overridable via `BRAIN_HOME`):
- `data/brain.db`: SQLite database (source of truth).
- `data/models/`: Cached in-process ONNX embedding models.
- `qdrant/`: Qdrant vector storage directory (for Docker modes).
- `spool/`: Client-side JSONL transport failure spool.
- `.env`: User configuration (`PORT`, `HOST`, `BRAIN_API_KEY`, `BRAIN_AI`, `BRAIN_EMBED`, etc.). Environment variables are loaded in priority order without clobbering `process.env`: `<cwd>/.env.local` → `<cwd>/.env` → `~/.neuralbrain/.env.local` → `~/.neuralbrain/.env`.
- `mode`: Selected runtime mode (`docker`, `qdrant-docker`, or `local-only`).
- `brain.pid` & `brain.log`: Host daemon PID and log files (for `qdrant-docker` and `local-only` modes).

### Directory Structure

- `src/app.ts` & `src/index.ts`: Application bootstrap, Express server setup, middleware pipeline.
- `src/cli.ts`: `neuralbrain` CLI (`install`, `start`, `stop`, `status`, `logs`, `doctor`, `install-agent`, `mcp`).
- `src/lib/`:
  - `brainHome.ts`: `~/.neuralbrain/` (`BRAIN_HOME`) path resolution and layered `.env` loading.
  - `db.ts`: SQLite connection, WAL mode, schema migrations, and test isolation guard.
  - `scope.ts`: Canonical three-state scope validation (`project`, `global`, `unknown`).
  - `spool.ts`: Robust client-side JSONL transport failure spool.
- `src/memory/`:
  - `observationStore.ts`: High-volume observation capture, dead-letter routing.
  - `trajectoryStore.ts`: Trajectory captures, 30-day archive, 90-day retention.
  - `noteStore.ts`: Curated notes & lessons, `note_concepts`, `note_files`, supersede versioning.
  - `sessionStore.ts`: Short-term session lifecycle, arithmetic end-of-session summaries, and chronological replay.
  - `actionStore.ts`: Short-term Next Actions queue (`ready`, `blocked`, `in_progress`, `done`, `dismissed`).
  - `graphStore.ts`: Relational knowledge graph builder across notes, lessons, concepts, files, sessions, actions, and summaries.
  - `failurePatternStore.ts`: Relational failure patterns, atomic SQL frequency UPSERT, `/inject` builder.
  - `deadLetterStore.ts`: Storage and producer attribution for malformed payloads.
  - `embedQueueStore.ts`: SQLite persistent queue for vector embedding.
  - `rollupSweeper.ts`: Background sweeper for idle session rollups and retention cleanup.
- `src/learning/`:
  - `embedding.ts`: In-process `nomic-embed-text-v1.5` ONNX model (512 dims, Matryoshka math), remote, vendor adapters.
  - `storeMeta.ts`: Loud embedder configuration validation against `store_meta` table.
  - `embedWorker.ts`: Queue worker and atomic collection-aliased re-embedding engine.
  - `search.ts`: Hybrid Reciprocal Rank Fusion (RRF) dense + BM25 search.
  - `engine.ts` & `types.ts`: Qdrant collection management and payload indexing.
- `src/consolidation/`:
  - `candidates.ts`: Leased candidate acquisition with concurrency locks.
  - `gate.ts`: 8-check mechanical verification gate for submitted summaries.
  - `fixtures.ts` & `runner.ts`: AI consolidation conformance fixtures and diagnostics.
- `src/ai/`:
  - `config.ts`, `vendors.ts`, `chat.ts`, `circuitBreaker.ts`: Cloud/local LLM adapters with capability gating.
- `src/mcp/server.ts`: Standalone Model Context Protocol stdio server.
- `src/routes/`: REST route controllers for capture, search, inject, notes, consolidation, maintenance, dashboard.
- `src/dashboard/`: Safe DOM client script, HTML layout, and styles for operator console.
- `src/scripts/`: Maintenance CLI tools (`doctor`, `smokeTest`, `createApiKey`).

---

## AI Ecosystem & Configuration Tiers

A single endpoint and vendor setting are shared across generative functions, with separate tiers per capability:

```bash
BRAIN_ENDPOINT=http://localhost:11434/v1   # Shared chat and embedding endpoint
BRAIN_VENDOR=openai|anthropic|google       # Cloud vendor for 'vendor' tier
BRAIN_AI=agent                             # Default generative tier (summarize, consolidate)
BRAIN_EMBED=local                          # Embedder tier (local | remote | vendor | none)
BRAIN_EMBED_MODEL=nomic                    # nomic | minilm | endpoint model name
```

### Capability Tier Matrix

| Tier | Generative (`summarize`, `consolidate`) | Embedder (`embed`) |
|---|---|---|
| `none` | ✅ Disabled (fully functional store) | ✅ Pure BM25 + SQL search (0 MB vector RAM) |
| `agent` | ✅ **Default** — host agent over MCP | ✖ Host agents cannot generate dense vectors |
| `local` | ✖ Local LLMs should not run in Node process | ✅ **Default** — in-process ONNX (nomic @ 512 dims) |
| `remote` | ✅ Local/LAN OpenAI-compatible chat model | ✅ GPU-accelerated embedding endpoint |
| `vendor` | ✅ Cloud generative model with API key | ✅ Cloud embedding model with API key |

- **Embedder has no silent fallback**: Changing models changes vector spaces; mismatches are loud and require `POST /maintenance/reembed`.
- **Consolidator fallback is safe**: Derived rows cite producers and are disposable (Rule 6).
- **`BRAIN_AI_SUMMARIZE` Placeholder**: `BRAIN_AI_SUMMARIZE` is explicitly a configuration placeholder (reserved for future session-grain workers; currently no table or leasing surface exists for session-grain summaries aside from `/consolidate/*`). It inherits `BRAIN_AI`.
- **`store_meta` Loud Verification**: Startup compares active configuration against `store_meta`. If dimensions or models mismatch, vector search is blocked, loud diagnostic errors are logged, and SQL/BM25 retrieval remains active.

---

## CLI & NPM Commands

### `neuralbrain` CLI (`src/cli.ts`)

| Command | Purpose |
|---|---|
| `neuralbrain install` | Interactive setup in `~/.neuralbrain/` (default). Supports `--mode docker \| qdrant-docker \| local-only`, `--port <n>`, `--yes` / `-y`, `--no-global`, `--no-agents`. |
| `neuralbrain start` | Starts the configured Brain service (Docker Compose or host daemon depending on `mode`). |
| `neuralbrain stop` | Stops running host Brain daemon and/or Docker Compose containers. |
| `neuralbrain status` | Displays `BRAIN_HOME`, runtime mode, daemon PID status, and `/health` check. |
| `neuralbrain logs` | Tails Docker Compose logs or `~/.neuralbrain/brain.log`. |
| `neuralbrain doctor` | Runs operational health and AI conformance diagnostics. |
| `neuralbrain install-agent` | Configures Antigravity, Claude Code/Desktop, Cursor, or project rules. |
| `neuralbrain init [project-id]` | Writes `.brainrc` in the current folder so every agent below it uses one `project_id` (defaults to the folder name; `--force` replaces an existing one). |
| `neuralbrain mcp` | Starts the stdio MCP server (`dist/mcp/server.js`). |

### NPM Scripts

| Command | Purpose |
|---|---|
| `npm run build` | Compiles TypeScript sources (`tsc`) into `dist/`. |
| `npm start` | Executes the compiled production service (`node dist/index.js`). |
| `npm run dev` | Runs development server with auto-reload (`nodemon` + `ts-node src/index.ts`). |
| `npm test` | Executes Jest test runner across unit, integration, and QA suites. |
| `npm run typecheck` | Validates TypeScript typing with `--noEmit` (0 errors required). |
| `npm run mcp` | Spawns the standalone stdio MCP server (`ts-node src/mcp/server.ts`). |
| `npm run doctor` | Runs operational health checks and AI conformance diagnostics (`brain doctor --ai`). |
| `npm run smoke` | Executes end-to-end integration verification against live service and Qdrant. |
| `npm run api-key:create` | Generates and persists a new authenticated client API key. |

---

## Web Operator Dashboard (`GET /dashboard`)

Accessible at `http://localhost:3737/dashboard`:
- **Security Constraints**: Zero `innerHTML` (built strictly via safe DOM manipulation), zero `localStorage` (session state in memory), strict Content Security Policy (CSP), dark command-center aesthetic. Authentication uses `HttpOnly` `brain_session` cookies signed with HMAC-SHA256 and bound to a key-version derived from the active API key's stored hash (so rotating or revoking a key immediately invalidates existing browser sessions).
- **7 Operational Tabs**:
  1. **Overview**: High-level store metrics across observations, trajectories, notes, sessions, and actions; dead-letter and queue depths.
  2. **Long Term**: Browse curated notes and lessons, inspect concept/file joins, and repair `scope = 'unknown'` records.
  3. **Short Term**: Inspect active/ended `Sessions` and manage the `Next Actions` queue.
  4. **Observations**: Inspect raw `Trajectories`, `Observations`, `Summaries` with click-through citations, and session replay timelines.
  5. **Graph**: Interactive Knowledge Graph explorer backed by `GET /dashboard/api/graph`.
  6. **Search & Inject**: Interactive dense + BM25 search simulation with RRF scores; live preview of `/inject` payload.
  7. **System & AI**: Visualise failure patterns, inspect dead-lettered payloads, and execute the AI conformance suite.

---

## Verified Test Coverage & Metrics

- **Automated Test Suite**: Jest unit, integration, and QA suites verified with `npm test` and 0 TypeScript compiler errors (`npm run typecheck`).
- **10,000 Observation Stress Test**: Verified under sustained load with 0 capacity rejections, full unbounded payloads preserved, partial batch success with dead-letter routing, and rate-limiting exemption verified.
- **In-Process ONNX Embedding**: `nomic-embed-text-v1.5` verified at 512 dimensions with Matryoshka LayerNorm/Slice/L2 math and asymmetric prefixes (`search_document: ` / `search_query: `).
- **Consolidation Verification Gate**: 8 mechanical checks verified via standard fixtures (`fx1-failure`, `fx2-success`, `fx3-sparse`), rejecting ungrounded claims, non-verbatim quotes, and forbidden speculative fields (`narrative`, `importance`, `confidence`, `strength`) with `422 Unprocessable Entity`.
- **Spool Reliability**: Client-side JSONL transport failure spool verified with 5 MB cap, 168h max age, deduplication, and flush recovery.
