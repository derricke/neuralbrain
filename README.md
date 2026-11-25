# Neuralbrain

A memory service for all agents. It runs on your machine, stores everything in SQLite, and talks to Claude Code, Claude Desktop, Antigravity and Cursor over HTTP and MCP.

It started as the memory subsystem of NeuralSwarm, my agent orchestrator. That version was scoped to swarms, roles and LLM providers. This one is scoped to projects, notes and tasks, so any agent can use it.

# Benchmarks
| Benchmark | Score (`top_50`) | Avg Tokens | Latency p50 / p95 | 
| --- | :---: | ---: | ---: |
| LoCoMo Full (1,540 Qs) | 89.9% | ~2.3K | 59ms / 82ms |
| LongMemEval Full (500 Qs) |	72.2% | ~11.3K | 33.9ms / 43.6ms |


## Why I built it

Most memory tools for agents break in the same four ways:

- **They run an LLM on every write.** The summariser hallucinates into the records. Turn compression off to stop it, and the store stops growing.
- **They guess scope.** Records get written with no project, and nothing tells "forgot to say" apart from "applies everywhere". A backfill can't recover that, and filtering by project returns nothing.
- **They drop data.** A per-session cap is meant to be relieved by consolidation. When consolidation is off, everything past the cap is thrown away.
- **You can't fix them.** There's no way to repair a record with SQL, and the health check says "6/10 passing" and "all checks passing" in the same run.

Each of those became a rule here.

## The rules

1. **No LLM in the capture path.** Records are typed columns. Rollups are arithmetic: count the tool calls, sum the durations, take the first prompt as the description, mark it failed if a failure hook fired. Models are only allowed to write derived records (rule 6).
2. **SQLite is the source of truth. Qdrant is an index.** You can inspect and repair anything with SQL. If Qdrant goes away, it gets rebuilt from SQLite.
3. **Never reject a write for capacity.** No per-session caps, no rate limit on `/capture/*`. Backpressure is fine, rejection isn't. Dead letters are only for malformed payloads, never for volume or an outage.
4. **Scope is stated, never inferred.** Every record is `project` (with a `project_id`), `global` (on purpose) or `unknown` (the writer didn't say). Unknown records go to a repair queue on the dashboard. Nothing gets backfilled by guessing.
5. **Three grains, one schema.**
   - `observations`: tool calls and prompts, captured by hooks. High volume. Archived at 30 days, purged at 90.
   - `trajectories`: task attempts with arithmetic outcomes. Low volume, kept.
   - `notes`: facts, decisions, patterns, bugs, workflows, preferences and lessons. Written on purpose, edited by supersede, never auto-deleted.
6. **Derived records are extra.** A summary is a new row that cites its sources. It never changes the rows it came from, and you can delete every summary without breaking anything.

One more: **only the service opens the database for writing.** Not a script, not a test, not me with `sqlite3`. A direct write skips the embed queue, so the row lands in SQLite but never in Qdrant and silently drops out of search. It also skips failure-pattern counting, dead-letter routing and tracing. Repairs go through `POST /maintenance/*`, the dashboard or the CLI. Read-only inspection (`?mode=ro`) is fine when the service is stopped.

## How it fits together

```
   Agent / IDE (Claude Code, Antigravity, Cursor ...)
        │                         │
        │ stdio MCP               │ HTTP (hooks, with a local spool if the brain is down)
        ▼                         │
   MCP server (REST client,       │
   no database access)            │
        │ HTTP                    │
        ▼                         ▼
   ┌───────────────────────────────────────────────┐
   │ Neuralbrain service (port 3737)               │
   │   capture · sessions · actions · inject ·     │
   │   search · graph · consolidate · dashboard    │
   │                                               │
   │   SQLite (WAL)  ──embed queue──>  Qdrant      │
   └───────────────────────────────────────────────┘
```

Agents get memory two ways:

- **Push.** At task start, `GET /inject` hands the agent recent failure patterns, prior outcomes, open next actions, the last session summary, lessons and notes.
- **Pull.** Mid-task, `brain_search` runs dense vector search and BM25 together and merges them with reciprocal rank fusion.

The MCP server exposes 11 tools: `brain_search`, `brain_save`, `brain_recent_failures`, `brain_consolidate_candidates`, `brain_submit_summary`, `brain_action_add`, `brain_action_list`, `brain_action_update`, `brain_sessions`, `brain_session_end` and `brain_graph`.

## Requirements

- Node.js 24 or newer, and npm.
- Docker with Compose v2, for the `docker` and `qdrant-docker` modes.
- OpenSSL, only if you use `--https`.
- An NVIDIA GPU with nvidia-container-toolkit, only if you use `--gpu`.

## Install

### Quick start

```bash
npm install -g neuralbrain
neuralbrain install
```

Or in one step with npx:

```bash
npx neuralbrain install
```

npx runs from a temporary cache, so `install` puts a permanent copy in npm's global folder and runs the brain from there. Afterwards `neuralbrain` works in any shell.

To update, run `npm install -g neuralbrain@latest`, then `neuralbrain start`.

### From source

```bash
git clone https://github.com/derricke/neuralbrain.git
cd neuralbrain
npm install && npm run build
node dist/cli.js install
```

Install copies the package into npm's global folder (it packs the checkout and installs the tarball, rather than linking it), then starts the brain from that copy. After that you can move or delete the clone. To update, pull and run `node dist/cli.js install` again. Pass `--no-global` to skip the global copy and run straight from the checkout.

### What install does

It sets up `~/.neuralbrain/` (or `$BRAIN_HOME`) and asks which mode you want:

| Mode | What runs where |
|---|---|
| `docker` | Brain and Qdrant both in Docker Compose |
| `qdrant-docker` | Qdrant in Docker, brain as a Node daemon on the host |
| `local-only` | Brain on the host, no Qdrant, `BRAIN_EMBED=none` (SQLite and BM25 only) |

The in-process embedder (`@huggingface/transformers`) is an optional dependency. Docker mode doesn't need it on the host. When the brain runs on the host with `BRAIN_EMBED=local` (the default for `qdrant-docker`), `neuralbrain start` installs it the first time if it's missing. On Linux, `npm install -g` leaves it out, because its native runtime's install script fails there.

Everything it creates lives in `~/.neuralbrain/`:

```
data/brain.db    the database
data/models/     cached embedding models
qdrant/          Qdrant storage (Docker modes)
spool/           requests queued while the brain was unreachable
.env             your config
mode             the mode you picked
brain.pid, brain.log   host daemon (qdrant-docker and local-only)
```

Config is read from `./.env.local`, `./.env`, `~/.neuralbrain/.env.local` and `~/.neuralbrain/.env`, in that order. Anything already set in the environment wins.

Install flags: `--mode`, `--agents-only`, `--api-url`, `--port`, `--https`, `--gpu`, `--yes`, `--no-global`, `--no-agents`.

- `--agents-only` installs the CLI globally and configures coding agents to talk to an existing/remote/WSL Brain (reads `BRAIN_API_URL` / `BRAIN_API_KEY` from `.env` or defaults to `http://127.0.0.1:3737`, with no local DB or Docker).

- `--https` (or `BRAIN_HTTPS=1`) generates a local certificate in `~/.neuralbrain/certs/` with OpenSSL and serves over HTTPS.
- `--gpu` sets `BRAIN_EMBED=local-gpu`. See [GPU embeddings](#gpu-embeddings).

### Running it

```bash
neuralbrain start          # start whatever mode you installed
neuralbrain stop
neuralbrain restart        # stop, wait for the port to free, start (docker rebuilds the image)
neuralbrain status         # BRAIN_HOME, mode, daemon PID, /health
neuralbrain logs
neuralbrain doctor         # health checks via the running service (--ai adds the AI conformance tests)
neuralbrain install-agent  # wire up your agents
neuralbrain init           # write .brainrc here: one project_id for this folder and below
neuralbrain mcp            # run the stdio MCP server
neuralbrain -v             # show CLI version (--version, version)
```

Check it's up:

```bash
curl http://127.0.0.1:3737/health
```

### Without the CLI

With Docker Compose:

```bash
cp .env.example .env
docker compose up -d --build
```

That starts `neuralbrain` on `127.0.0.1:3737` with `neuralbrain-qdrant` on the internal Docker network (in `qdrant-docker` mode, Qdrant is published on `127.0.0.1:6333`). Data goes to `~/.neuralbrain/data` and `~/.neuralbrain/qdrant` unless you set `BRAIN_DATA_DIR` or `BRAIN_QDRANT_DIR`.

On the host:

```bash
cp .env.example .env
npm run build
npm start        # or: npm run dev
```

For vector search, start Qdrant (`npm run qdrant:start`) and leave `BRAIN_EMBED=local`. If you don't want Qdrant, set `BRAIN_EMBED=none` and you get SQL and BM25 only.

### API key

If `BRAIN_API_KEY` is set, the service registers it on startup. Change it and restart, and the stored key is updated; re-run `install-agent` so your agents pick it up.

If it's not set, open the dashboard at <http://127.0.0.1:3737/dashboard> and click **Claim First API Key**. To make more keys:

```bash
npm run api-key:create
```

## Connecting agents

```bash
npm run install-agent
```

It finds Antigravity, Claude Code, Claude Desktop and Cursor and adds the MCP server and lifecycle hooks to each. It reads `BRAIN_API_KEY` and `BRAIN_API_URL` from `.env` so you don't have to pass keys on the command line. It's safe to re-run: it merges into existing MCP configs without touching your other servers, doesn't duplicate hooks, and keeps what it writes to `AGENTS.md` / `CLAUDE.md` between `<!-- neuralbrain:start -->` and `<!-- neuralbrain:end -->`.

By default it configures everything globally:

- Antigravity: `~/.gemini/config/plugins/neuralbrain` and `mcp_config.json`
- Claude Code: `~/.claude/settings.json`
- Claude Desktop: `claude_desktop_config.json`
- Cursor: `~/.cursor/mcp.json`

Other options:

```bash
# one repo only: .claude/settings.local.json, .cursor/mcp.json, .brainrc, AGENTS.md/CLAUDE.md
npm run install-agent -- --project-dir /path/to/repo

# only some agents
npm run install-agent -- --target claude,antigravity

# show what would change without writing anything
npm run install-agent -- --dry-run
```

### Brain on another machine

On the server, set `HOST=0.0.0.0`. On your workstation, point `.env` at it and run `install-agent`:

```dotenv
BRAIN_API_URL=https://brain.example.lan
BRAIN_API_KEY=your-key
```

## AI settings

There are two separate settings, because they fail differently.

`BRAIN_AI` controls the generative side (consolidation). It defaults to `agent`, which means the host agent writes summaries over MCP and the brain needs no model of its own. A generative model can only ever produce derived rows, which are attributed and disposable, so a fallback here is harmless.

`BRAIN_EMBED` controls embeddings. It defaults to `local`: `nomic-embed-text-v1.5` running in-process on ONNX at 512 dimensions. There's no fallback. A different model is a different vector space, so if your config doesn't match what the store was built with, vector search shuts off and tells you why, SQL and BM25 keep working, and you fix it with `POST /maintenance/reembed`.

| Tier | `BRAIN_AI` | `BRAIN_EMBED` |
|---|---|---|
| `none` | off | SQL and BM25 only |
| `agent` | **default**, host agent over MCP | n/a, agents can't produce vectors |
| `local` | n/a, no chat models in the Node process | **default**, in-process ONNX |
| `local-gpu` | n/a | GPU sidecar container |
| `remote` | OpenAI-compatible endpoint (Ollama, LM Studio, vLLM) | same |
| `vendor` | OpenAI, Anthropic or Google with an API key | same |

`BRAIN_ENDPOINT` is shared by both. Set `BRAIN_EMBED_ENDPOINT` to send embeddings somewhere else, for example a GPU box on your LAN:

```dotenv
BRAIN_AI=agent
BRAIN_EMBED=remote
BRAIN_EMBED_ENDPOINT=http://gpu-server.lan:11434/v1
BRAIN_EMBED_MODEL=nomic-embed-text
```

### GPU embeddings

`local-gpu` runs nomic in a separate `embedder-gpu` container (`michaelf34/infinity:latest`, port 7997), so you don't need Ollama or LM Studio.

```dotenv
BRAIN_EMBED=local-gpu
BRAIN_EMBED_MODEL=nomic
BRAIN_EMBED_DIM=512
```

- You need an NVIDIA GPU, working drivers (`nvidia-smi`) and `nvidia-container-toolkit`. To check Docker can see the GPU, run this. If it prints your GPU table, you're good:

  ```bash
  docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
  ```

- It only works in `docker` and `qdrant-docker` modes, where `neuralbrain start` brings up the `gpu` Compose profile. In `local-only` you run the server yourself and set `BRAIN_GPU_ENDPOINT`.
- The first start pulls the image and downloads the model. Expect 30 to 120 seconds and 1 to 2 GB of VRAM.
- Switching between `local` and `local-gpu` needs a re-embed.

More detail, including `BRAIN_GPU_PORT`, `BRAIN_GPU_IMAGE` and `BRAIN_GPU_ENGINE`, is in [docs/EMBEDDER.md](docs/EMBEDDER.md).

### Re-embedding

If Qdrant is empty or recreated, the embed queue refills it from SQLite on its own. To force a full re-index:

```bash
curl -X POST http://127.0.0.1:3737/maintenance/reembed \
  -H "Authorization: Bearer $BRAIN_API_KEY"
```

It builds a new collection and swaps an alias when it's done, so search never sees a mix of old and new vectors.

## Dashboard

<http://127.0.0.1:3737/dashboard> has seven tabs:

1. **Overview**: counts for every table, dead-letter and embed-queue depth, scope breakdown.
2. **Long Term**: notes and lessons, their concepts and files, and the queue for fixing `unknown` scope.
3. **Short Term**: sessions and the next-actions queue.
4. **Observations**: raw trajectories, observations, summaries with links to their sources, and session replay.
5. **Graph**: notes, concepts, files, sessions, actions and summaries as a graph.
6. **Search & Inject**: run a search and see the dense, BM25 and fused scores; preview what `/inject` would send.
7. **System & AI**: failure patterns, dead letters, and the AI conformance tests.

It doesn't use `innerHTML` or `localStorage`, and it runs under a strict CSP. Login is an `HttpOnly` cookie tied to the current API key, so rotating or revoking the key logs out every browser session.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | compile to `dist/` |
| `npm start` | run the compiled service |
| `npm run dev` | run with auto-reload |
| `npm test` | Jest unit, integration and QA suites |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run mcp` | stdio MCP server |
| `npm run install-agent` | wire up agents |
| `npm run doctor` | health checks (`-- --ai` adds the AI conformance tests) |
| `npm run smoke` | end-to-end check against a live service and Qdrant |
| `npm run api-key:create` | make a new API key |

## Docs

- [docs/API.md](docs/API.md): HTTP endpoints
- [docs/MCP.md](docs/MCP.md): MCP tools
- [docs/SCHEMA.md](docs/SCHEMA.md): SQLite schema and Qdrant payloads
- [docs/EMBEDDER.md](docs/EMBEDDER.md): embedders, Matryoshka truncation, benchmarks, re-embed cutover
- [docs/CONSOLIDATION.md](docs/CONSOLIDATION.md) and [docs/CONTRACTS.md](docs/CONTRACTS.md): how summaries are produced and checked
- [docs/DIVERGENCES.md](docs/DIVERGENCES.md): where this differs from NeuralSwarm and why
- [.env.example](.env.example): every setting, with comments

## License

MIT with the Commons Clause. You can use, change and share it, but you can't sell it. See [LICENSE](LICENSE).

## Contributing

Issues and PRs are welcome. Use TypeScript, add Jest tests, and run `npm test` and `npm run typecheck` before you open a PR.

On npm 10 with an NVIDIA GPU, run `ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm install`. Otherwise onnxruntime-node's install script tries to download a CUDA add-on the brain never uses.
