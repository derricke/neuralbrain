# Architectural Divergences & Preserved Components

> **Context & Scope.** This document records what was preserved from the source repository, [NeuralSwarm](https://github.com/derricke/neuralswarm),
> what was decoupled, and every intentional divergence made from the legacy schema and architecture.
> "The copy did it this way" is never accepted as an engineering rationale; every divergence is recorded here
> with its underlying justification.

---

## 1. Known-Good Components Preserved

The trajectory storage model in NeuralSwarm's [`src/memory/trajectoryStore.ts`](https://github.com/derricke/neuralswarm/blob/main/src/memory/trajectoryStore.ts) was architecturally sound and its core patterns were preserved:

- **Structured Trajectory Records**: Typed fields rather than untyped freeform blobs.
- **Float32Array Vector Storage**: Direct binary storage of embedding vectors as SQLite BLOBs.
- **Decoupled Embedding Write**: Capture inserts the record first; the vector is computed and updated separately.
- **Transactional Retention**: Two-tier retention cycle (archive at 30 days, purge at 90 days) executed inside atomic transactions.

### Column Generalisations

To decouple from the NeuralSwarm orchestrator and generalize the service to support any coding agent:

| Legacy Field | Neuralbrain Field | Architectural Rationale |
|---|---|---|
| `swarmId` | `projectId` | Swarms and swarm runtimes are eliminated; projects are the primary boundary of isolation. |
| `agentId` | `agent` | Decoupled from orchestrator agent rows. Represents any caller identity (Claude Code, Antigravity, Cursor, etc.). |
| *(None)* | `noteRef` | Secondary reference linking trajectory outcomes directly to curated notes. |
| *(None)* | `taskType` | Structured category (e.g. `test`, `build`, `refactor`, `migration`) used to aggregate failure patterns. |

Core metrics — `description`, `result`, `success`, `retries`, and `durationMs` — retain their established semantic definitions.

---

## 2. Sanctioned Schema & Architectural Divergences

The table below lists every deliberate divergence from the extracted codebase, accompanied by the design rule that mandated the change.

| Component / Pattern | Extracted Implementation | Neuralbrain Implementation | Mandatory Reason & Design Rule |
|---|---|---|---|
| **Orchestrator Foreign Keys** | Foreign keys referencing `tasks`, `swarms`, and `swarm_jobs` across SQLite tables. | Completely eliminated. Zero external table dependencies. | Those orchestrator tables were not extracted. Legacy FKs existed at three distinct code sites (`db.ts:183-188`, `db.ts:400-405`, `db.ts:287-288`). Leaving any site active would cause table rebuilds to fail. |
| **Archive Scope Nullability** | `trajectory_archive.swarm_id` was declared `NOT NULL`. | `trajectory_archive.project_id` is explicitly nullable. | **Rule 4** permits unknown scope (`project_id = NULL`). Declaring the archive column `NOT NULL` caused 30-day retention jobs to crash on unassigned records, breaking the retention pipeline. |
| **Failure Patterns Storage** | Serialized JSON blob in a key-value row (`failure_patterns` table). | Normalized relational table with `UNIQUE(project_id, task_type, error)` and atomic SQL UPSERT. | **Rule 2**. A serialized blob is not queryable ("top failures for project X" required deserializing all rows). Concurrent updates suffered read-modify-write data loss. |
| **JSON Error Handling** | Swallowed errors with bare `catch (e) {}` blocks. | Explicit structured error logging and dead-letter routing. | Swallowing errors caused a single corrupted record to permanently disable push injection without diagnostic alerts. **Rule 2** mandates diagnosability. |
| **Vector Dimension Management** | Single hardcoded dimension variable; silent Qdrant shutdown on probe mismatch. | Store-wide identity pinned in `store_meta`; loud refusal of vector search on mismatch. | **Rule 2 & Rule 6**. Silent disabling of vector search led to undetected semantic retrieval degradation. Mismatches must loudly alert the operator while keeping BM25/SQL active. |
| **Qdrant Collection Lifecycle** | Attempted in-place collection migration. | Fresh collections provisioned with atomic alias cutover (`POST /maintenance/reembed`). | The live legacy collection was 3072-dim (`gemini-embedding-001`), with no sparse index, empty payload schema, and 0 indexed vectors. Atomic alias switching avoids mixed vector spaces. |
| **Capture Rate Limiting** | Strict rate limits (100 requests per 60s) applied universally across all endpoints. | `POST /capture/*` and `GET /health` endpoints explicitly exempted from rate limiting. | **Rule 3**. Automated hooks streaming tool calls easily exceed 100 req/min. Rejecting writes for capacity or burst traffic is strictly prohibited. |
| **Observation Storage Grain** | Per-session 500-observation cap, after which writes were rejected. | Uncapped observation ingestion with partial batch acceptance and dead-letter routing for malformed payloads. | **Rule 1 & Rule 3**. Artificial caps combined with disabled summarisation cause observations to be permanently dropped. |
| **Summarisation Pipeline** | Synchronous compression on the ingest path with LLM hallucination risk. | Asynchronous, derived consolidation via MCP or background workers passing an 8-check mechanical gate. | **Rule 1 & Rule 6**. Captures must never be corrupted by generative models. Summaries must remain additive, attributed, and disposable. |
