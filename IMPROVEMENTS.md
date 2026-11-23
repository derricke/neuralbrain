# Neuralbrain Retrieval & Memory Quality Improvements (Zero-Extractor-LLM Roadmap)

> **Purpose:** Engineering roadmap to raise Neuralbrain's real-world memory retrieval accuracy and context efficiency across coding agents, assistants, and long-horizon evaluations (targeting **92%+ on LongMemEval** without adding a generative extractor LLM).
>
> **Architectural Guardrails (from `CLAUDE.md`):**
> - **Rule 1 (No LLM in the capture path):** All ingest-time processing must be deterministic (structural parsing, rule-based NLP, or local discriminative encoders/NER—never a generative LLM rewriting records).
> - **Rule 2 (SQLite is source of truth):** Raw `input` / `output` stay verbatim and unmutated in SQLite. Any condensed text, extracted dates, entities, or chunks are **additive and disposable** (Rule 6).
> - **Rule 3–7:** Never reject writes for capacity; preserve explicit scope; never filter by `agent_id`; keep `user_id` filtering opt-in.
> - **General-Purpose Discipline:** Every change must genuinely improve Neuralbrain across real coding and personal-assistant projects—**no benchmark-specific hacks or overfitting.**

---

## 1. Forensic Baseline Diagnosis

Analysis of all 500 questions in `~/Projects/memory-benchmarks/results/longmemeval/longmemeval_results_20261123_073612.json` (run `nb-full-longmemeval-v2`, `top_k=50`, `gpt-4o-mini` answerer & judge, raw zero-LLM observation mode):

### Baseline Score Breakdown (361 / 500 = 72.2%, 139 fails)

| Category | Score | Correct / Total | Real Fails (excl. judge tag quirk*) |
|---|---:|---:|---:|
| `single-session-user` | 87.1% | 61 / 70 | 6 (3 judge tag misses) |
| `single-session-assistant` | 85.7% | 48 / 56 | 5 (3 judge tag misses) |
| `knowledge-update` | 74.4% | 58 / 78 | 18 (2 judge tag misses) |
| `temporal-reasoning` | 70.7% | 94 / 133 | 37 (2 judge tag misses) |
| `multi-session` | 63.9% | 85 / 133 | 48 |
| `single-session-preference` | 50.0% | 15 / 30 | 15 |
| **Overall** | **72.2%** | **361 / 500** | **129 real fails (~74.2% true)** |

*\*Diagnostic note (benchmark artifact, do NOT modify benchmark to fix): On 10 of 139 fails, the `gpt-4o-mini` judge wrote `Final verdict: yes` inside `</judge_thinking>` rather than after the closing tag. True baseline brain accuracy is ~74.2%.*

### Where the 139 Failures Actually Came From

| Failure Bucket | Count | % of Fails | Evidence |
|---|---:|---:|---|
| **All GT turns already retrieved in top-50** | **110** | **79.1%** | Top-50 recall across all 470 non-abstention Qs is already **95.7% (450/470)**! Top-10 is 78.5%, Top-20 is 87.0%, Top-30 is 91.9%. **74 of the 110** had all GT turns in top-10. |
| **Abstention (`*_abs`) fails** | **14** | **10.1%** | Only 16/30 (53.3%) passed. Returning 50 low-relevance items with flat RRF scores induces hallucinations. |
| **Partial GT retrieval** | **13** | **9.4%** | 10 `multi-session`, 2 `temporal-reasoning`, 1 `single-session-preference`. In **12 / 15** partial/zero misses, another turn from the **same session** was already in top-50. |
| **Zero GT retrieved** | **2** | **1.4%** | Both are pure-temporal queries (`"four weeks ago"` — `eac54add`, `6e984302`). |

### Four Structural Root Causes in Neuralbrain

1. **Token Bloat & Assistant Verbosity (83% of retrieved tokens are `kind='response'`)**:
   - Top-50 averages **45,059 chars (~11,265 tokens)** per query.
   - `kind='prompt'` (`User:`): 12,876 slots, avg **295 chars** (~17% of tokens) — holds **94% of all GT turns** (837/891; 100% of `knowledge-update`, `temporal-reasoning`, `single-session-preference`; 99.7% of `multi-session`; 97% of `single-session-user`).
   - `kind='response'` (`Assistant:`): 11,972 slots (48% of slots!), avg **1,547 chars** (~83% of tokens; 5,060 hit `MAX_OBS_RECORD_CHARS = 2000`) — only dominant in `single-session-assistant` (91% assistant GT).
   - Effects:
     - Drowns 160-char user preferences in 45K chars of generic assistant numbered lists (`single-session-preference` = 50%).
     - Exhausts reader output budgets inside `<mem_thinking>` (**17/500 empty generated answers**, 11 failed).
     - Steals **17–32 of 50 slots** on `multi-session` queries, crowding out 4th/5th user turns.
     - Blind `slice(0, 2000)` in `truncateObsField()` (`src/learning/search.ts:44-47`) cuts off answers past char 2,000 (caused 3 failed GT turns).

2. **Missing Event Timestamps (`observations` has no `event_at`, returns ingestion wall-clock `created_at`)**:
   - **25,000 / 25,000** retrieved memories returned `created_at = 2026-11-23` (ingestion time) instead of the actual event date.
   - **113 / 500 questions** came back **scrambled out of chronological order**, and all 50 memories were grouped under one fake date heading.
   - Directly breaks `knowledge-update` (reversing old vs. new state) and `temporal-reasoning` (wrong order/intervals), and renders Neuralbrain's own `after`/`before`/`temporal_bias` filters blind to actual observation dates.

3. **Unresolved Relative Dates & No Temporal Query Parsing**:
   - **30 / 33** non-abstention `temporal-reasoning` fails contain relative time words (`"today"`, `"yesterday"`, `"last Saturday"`, `"two weeks ago"`) in the GT turns.
   - Neither BM25 nor dense embeddings map `"four weeks ago"` to a date range—explaining the only 2 zero-retrieval failures in all 500 questions.

4. **Retrieval Engine Under-Uses Neuralbrain's Own Architecture in Zero-LLM Mode**:
   - `buildSafeFtsQuery()` (`src/learning/search.ts:85-92`) joins **all tokens including English stopwords** (`i`, `the`, `a`, `to`, `of`, `how`, `many`, `did`, `my`) with `OR`—almost every observation matches FTS5, and long verbose responses pick up spurious BM25 wins.
   - **Signal 3 (Entity-Graph RRF)** in `hybridSearch()` (`src/learning/search.ts:1098-1170`) is **100% idle** in zero-LLM mode because nothing populates `entities` or `entity_edges` on observation capture.
   - `RRF_K = 60` compresses rank scores (avg rank-1 `0.0371` vs rank-50 `0.0167`, only `2.23x` spread) with no cross-encoder reranking and no noise floor.
   - `embedWorker.ts` computes one vector over up to 8,000 chars of `prompt: \ninput: ...`, diluting side-facts (`"By the way..."`) inside multi-sentence turns.

---

## 2. Real-World vs. Benchmark Audit (Design Guardrails)

Before implementing any item below, check its general-purpose classification so we never introduce benchmark-tuned hacks into Neuralbrain:

| # | Improvement | Real-World Brain Value | Coding-Agent Benefit | Overfitting Guardrail |
|---|---|---|---|---|
| 1 | `event_at` on `observations` | **Essential** | Fixes offline spool flush timestamps (`spool.ts` buffers up to 168h), log imports, and `after`/`before` queries | Keep general ISO-8601 + Unix epoch support |
| 2 | `condensed_text` + query-focused snippet windowing | **Essential** | Stops 10KB stack traces / `git diff` / verbose essays from blowing agent context & replaces blind `slice(0, 2000)` | Never mutate raw `input`/`output`; expose both raw and snippet/condensed views via API option |
| 3 | Relative-date anchoring + temporal query parser | **High** | Enables `"what failed yesterday?"`, `"changes last week"`, `"deployed last Tuesday"` | Use standard date parsing (`chrono-node`), never dataset-specific phrasing |
| 4 | Density/length-normalized kind weighting | **High (if general)** | Stops verbose assistant essays from outranking concise prompts or tool outputs | **Guardrail:** Do NOT hardcode "suppress `response`"—coding agents need `tool_call` outputs and root-cause `response`s! Weight by information density + configurable/intent-aware `kind` weights |
| 5 | FTS5 stopword removal + two-tier `AND`/`NEAR`→`OR` + BM25 column weights | **Essential** | Pure search-engine bugfix; dramatically sharper keyword/symbol/error recall | Standard English stopword list; preserve code identifiers/symbols |
| 6 | Turn-pair (`pair_id`, `turn_index`) + session neighbor expansion + dedup | **Essential** | Links `prompt` → `tool_call` → `response` in coding sessions and pulls sibling turns on hit | Works identically for coding sessions and chat transcripts |
| 7 | Zero-LLM entity extraction + linguistic signal tags (wakes up Signal 3 RRF) | **High** | Auto-populates `entities`/`entity_edges` for files, packages, services, people, prefs, stack switches with zero LLM | Keep entity types & preference/update cues universal (coding + general), never LongMemEval-specific |
| 8 | Sub-document / passage-level multi-vector indexing in Qdrant | **Essential** | Solves `MAX_LOCAL_EMBED_CHARS = 8000` cliff & mean-pooling dilution on long tool outputs, docs, and prompts | Keep single SQLite row; chunk vectors point back to `record_id` |
| 9 | Local cross-encoder reranker (Infinity GPU / ONNX) | **Essential** | Massive precision lift for all queries (~15–40ms on GPU), zero generative LLM | Opt-in via `BRAIN_RERANK` tier (mirroring `BRAIN_EMBED` tier matrix) |
| 10 | Relevance score floor + `max_tokens` budget in `POST /search` | **Essential** | Stops injecting garbage memories into coding agents when nothing matches; caps context cost | Configurable `min_score` + `max_tokens` params with safe defaults |
| 11 | Multi-clause / multi-entity query fan-out | **Moderate–High (if general)** | Helps compound queries (`"compare auth.ts and session.ts"`, `"between deploy X and rollback Y"`) | **Guardrail:** General syntax/entity splitting ONLY—**do NOT** add dataset-specific rules like `"how old" -> inject "birthday"` |
| 12 | Stronger embeddings + clean embed text / sparse-dense (`BGE-M3`) | **Essential** | Strips noisy `prompt:\ninput:` wrapper tokens; better code + prose semantics | Keep `store_meta` loud mismatch checks intact |
| 13 | Deterministic chronological entity/topic timeline clustering | **High** | Shows how a bug, config, or architectural decision evolved (`earlier -> latest`) | Additive `timeline_clusters` metadata in `SearchResponse` |

---

## 3. Detailed Implementation Blueprint

### Tier 1 — Highest-Impact Schema, Temporal & Condensation Fixes

#### 1. First-Class Event Timestamps (`event_at`) on `observations`
- **Problem:** `observations` only has `created_at INTEGER NOT NULL DEFAULT (unixepoch())` (`src/lib/db.ts:184`). When observations arrive in batches, from an offline spool (`src/lib/spool.ts`), or from historical imports, `created_at` reflects DB insertion time rather than when the event happened. `RECORD_SPECS.observation.temporalExpr` (`src/learning/search.ts:461`) uses `o.created_at`.
- **Changes:**
  - `src/lib/db.ts`: Add nullable `event_at TEXT` (normalized UTC ISO-8601, matching `notes.event_at`) to `observations` and `observations_archive` via `alignObservationsSchema()` + index `CREATE INDEX IF NOT EXISTS idx_obs_event_at ON observations(scope, project_id, event_at)`.
  - `src/memory/observationStore.ts`: Accept optional `event_at` / `eventAt` (ISO-8601 string or Unix epoch seconds) in `validateObservationItem()`, normalize via `normalizeUtcIso()` (`src/lib/recurrence.ts`), and persist it. Also continue honoring explicit numeric `created_at` when provided.
  - `src/learning/embedWorker.ts`: Store `event_at` (ISO string and/or `event_at_ts` integer) in Qdrant point payload for observations + create integer payload index in `createQdrantCollectionWithIndexes()`.
  - `src/learning/search.ts`:
    - Update `RECORD_SPECS.observation.temporalExpr` to:
      `COALESCE(${a}.event_at, strftime('%Y-%m-%dT%H:%M:%fZ', ${a}.created_at, 'unixepoch'))`
    - Update `getCandidateCreatedMs()` (`src/learning/search.ts:891-897`) to prefer `c.record.event_at` for observations as well as notes.
- **Verification:** Unit tests verifying `event_at` persistence, `after`/`before` filtering on `event_at`, and chronological ordering when observations are ingested out of order or in same-second batches.

#### 2. Zero-LLM Extractive Condensation (`condensed_text`) + Query-Focused Snippet Extraction
- **Problem:** `search.ts` currently returns `truncateObsField(row.input)` and `truncateObsField(row.output)` using a blind `value.slice(0, 2000)` (`src/learning/search.ts:23,44-47`). This causes two opposite bugs simultaneously:
  1. Verbose assistant responses and tool dumps bloat context to ~11.3K tokens per 50 results.
  2. Crucial details appearing past character 2,000 (e.g., the bottom of a long assistant recommendation or stack trace) are silently truncated away.
- **Changes:**
  - **Ingest-time additive column (`src/lib/db.ts`, `src/memory/observationStore.ts`):**
    - Add nullable `condensed_text TEXT` to `observations` (and `observations_archive`). Raw `input`/`output` remain 100% untouched.
    - Build a zero-dependency deterministic condenser (`src/lib/condenser.ts`):
      - Split text into sentences / code-or-list blocks.
      - Strip pure boilerplate/filler lines (greetings, markdown HR/headers with no content, generic disclaimers like *"I hope this helps!"*, *"Feel free to ask..."*).
      - Score sentences deterministically by information density: entity/proper-noun density, numeric/date/path/code-token density, first-person factual/preference verb cues, and lead-sentence position; deduplicate near-identical sentences.
      - For concise `prompt` turns (<500 chars), preserve 100% of substantive sentences verbatim; for verbose `response` or `tool_call` outputs (>400 chars), produce a crisp extractive condensation (~200–400 chars) preserving all named entities, numbers, file paths, errors, and core recommendations.
  - **Search-time Query-Focused Extractive Window (`src/learning/search.ts`, `src/learning/types.ts`):**
    - Add optional `snippet_mode?: 'raw' | 'condensed' | 'query_focused'` (plus `max_record_chars?: number`) to `SearchRequest`.
    - In `query_focused` mode, instead of `slice(0, 2000)` on full `input`/`output` from SQLite:
      - Split the **full untruncated** `input`/`output` into sentences/lines.
      - Score each sentence against the query's non-stopword tokens (BM25/TF-IDF overlap + exact entity/number/date match bonus; optionally reuse chunk cosine scores from Item #8).
      - Return the top 2–4 highest-scoring sentences (±1 adjacent context sentence) up to `max_record_chars` (e.g. 400–600 chars for `response`, full text up to 1,000 chars for `prompt`), with `[...]` markers for omitted spans.
      - Attach as `snippet` on `SearchResultItem` (or opt-in compact `record`) so callers get the exact matching passage even if it occurred at char 4,500 of a 6,000-char observation!
- **Impact:** Cuts average top-50 payload from **~11,265 tokens → ~2,000–3,000 tokens** while eliminating tail-truncation data loss.

#### 3. Deterministic Relative-Date Anchoring (Ingest) + Temporal Query Window Parser (Search)
- **Problem:** Relative dates inside observations (`"yesterday"`, `"last Saturday"`, `"two weeks ago"`) drift in meaning when read months later, and queries containing temporal windows (`"four weeks ago"`, `"in the past two weeks"`, `"last month"`, `"in March"`) do not constrain or boost `event_at` during search.
- **Changes:**
  - **Ingest-time anchoring (`src/lib/temporal.ts`):**
    - Using a deterministic date parser (e.g., `chrono-node` or a clean zero-dep rule engine anchored to `event_at ?? created_at`), detect explicit relative expressions (`today`, `yesterday`, `tomorrow`, `last <weekday>`, `this past <weekday>`, `N days/weeks/months ago`, `last week/month`).
    - Store resolved annotations in `resolved_dates_json TEXT` on `observations` and inline them into `condensed_text` / search snippets as non-destructive annotations (e.g., `yesterday [2022-11-17]`, `last Saturday [2023-05-20]`), leaving raw `input`/`output` verbatim.
  - **Search-time temporal intent parser (`src/lib/temporal.ts`, `src/learning/search.ts`):**
    - Add optional `reference_date?: string` (ISO-8601, defaults to `new Date().toISOString()`) to `SearchRequest`.
    - Deterministically parse temporal spans from `q` relative to `reference_date`:
      - Point-in-past windows (`"four weeks ago"` → `reference_date - 28d ± 7d`).
      - Trailing windows (`"in the past two weeks"`, `"last month"`, `"past 3 months"` → `[start - grace, reference_date]`).
      - Calendar references (`"in March"`, `"in February 2023"` → `[2023-03-01, 2023-03-31]`).
    - **Crucial design choice — Soft Temporal Boost + Auxiliary Window Recall (NOT a brittle hard filter):**
      - Run a dedicated lightweight SQLite query fetching records within the parsed `[winStart, winEnd]` window and add them to the candidate pool (this recovers zero-lexical-overlap temporal queries like *"milestone I mentioned four weeks ago"*).
      - Apply a smooth Gaussian/step multiplier in `computeTemporalMultiplier()` for candidates inside the parsed window so in-window matches rise without discarding out-of-window context needed for multi-hop comparisons.

#### 4. Information-Density & Intent-Aware Kind Weighting (`prompt` vs `response` vs `tool_call`)
- **Problem:** A 2,000-char verbose `response` naturally accumulates more BM25 token matches and broad semantic overlap than a crisp 180-char `prompt`, allowing assistant essays to take 48% of slots and 83% of tokens.
- **Changes (`src/learning/search.ts`, `src/learning/types.ts`):**
  - Support optional `kind_weights?: Partial<Record<'prompt' | 'response' | 'tool_call', number>>` and `max_kind_share?: Partial<Record<'prompt' | 'response' | 'tool_call', number>>` in `SearchRequest`.
  - Add **length-normalized information density damping** for verbose boilerplate turns: observations with very low unique-content-word / total-char ratio or high generic-list ratio receive a mild ranking damper unless they have high exact-query coverage.
  - Add lightweight **deterministic query-intent routing** (opt-in or default-gentle):
    - Detect explicit assistant-recall cues (`"did you suggest/recommend/say/mention/tell/give"`, `"your recipe/advice/list/explanation"`) → boost `kind='response'`.
    - Detect tool/error/file cues (file paths, stack-trace terms, `"error"`, `"failed"`, `"command"`) → boost `kind='tool_call'`.
    - Otherwise apply a gentle preference multiplier for user-authored `kind='prompt'` (e.g., `1.15x`) and deduplicate paired `response` echo turns so verbose responses don't crowd out distinct user facts.
- **Guardrail:** Never hard-block `response` or `tool_call`; keep weights mild and overrideable per caller.

---

### Tier 2 — Retrieval Engine, Graph Activation & Multi-Vector Indexing

#### 5. Fix FTS5 Query Construction & BM25 Column Weighting
- **Problem:** `buildSafeFtsQuery()` (`src/learning/search.ts:85-92`) emits `"tok1" OR "tok2" OR ...` for **every** alphanumeric token, including high-frequency stopwords (`i`, `the`, `a`, `to`, `of`, `in`, `for`, `how`, `many`, `did`, `my`, `you`). And `queryTypeFts()` (`src/learning/search.ts:666-674`) calls `-bm25(fts_observations)` with uniform column weights `(1, 1, 1, 1)`.
- **Changes (`src/learning/search.ts`, `src/lib/db.ts`):**
  - Add a curated English stopword filter in `buildSafeFtsQuery()` (with fallback to unfiltered tokens if all tokens were stopwords, and preserving code symbols/numbers/hyphenated identifiers).
  - Implement **two-tier FTS5 querying**:
    1. **Strict / phrase-proximity tier:** `AND` over top-IDF / rare content terms (or `NEAR("tok1" "tok2", 12)` for adjacent capitalized/content bigrams).
    2. **Relaxed tier:** `OR` over filtered content tokens.
    - Fuse strict-tier hits with a bonus (e.g. `1.5x` BM25 or separate rank boost) so documents matching *all* rare query entities cleanly outrank documents matching one common word.
  - Apply explicit column weights to `bm25()`:
    - `fts_observations`: `bm25(fts_observations, 0.0, 1.5, 1.5, 1.4, 0.8)` (`record_id`, `tool_name`, `file_path`, `input`, `output` — weighting `input`/tool/file above verbose `output`; adjust dynamically when query targets `response`).
    - `fts_notes`: `bm25(fts_notes, 0.0, 2.0, 1.0, 1.5)` (weighting `title` and `extra` concepts/files above body).
  - Optional: add `condensed_text` as an indexed column in `fts_observations` so concise summaries get crisp BM25 document-length normalization.

#### 6. Dialogue-Pair & Session-Coherence Schema (`turn_index`, `pair_id`) + Neighbor Expansion
- **Problem:** `observations` stores each `prompt` and `response` as isolated rows without turn sequence numbers or pair IDs. Retrieving a turn containing pronouns (*"that one"*, *"option 2"*) loses its partner, and retrieving 1 turn in a session fails to discover sibling turns from the same session (**12 of 15** partial retrieval misses had a sibling turn already in top-50!).
- **Changes:**
  - `src/lib/db.ts` & `src/memory/observationStore.ts`:
    - Add nullable `pair_id TEXT` and `turn_index INTEGER` columns to `observations` and `observations_archive` + index `CREATE INDEX IF NOT EXISTS idx_obs_session_turn ON observations(scope, project_id, session_id, turn_index)` and `idx_obs_pair ON observations(pair_id)`.
    - When `POST /capture/observations` receives a batch of observations in a single request without explicit `pair_id`, auto-assign consecutive `turn_index` (per session) and link adjacent `prompt` + `response` items with a shared `pair_id`.
  - `src/learning/search.ts`:
    - **Same-pair deduplication / bundling:** If both the `prompt` and `response` of a `pair_id` appear in candidates, keep the higher-scoring one as the primary slot and optionally attach a condensed 1-line partner preview (especially when the primary text contains unresolved anaphora like *"that"*, *"it"*, *"option 2"*, *"above"*), freeing a slot for another distinct memory!
    - **Session-sibling expansion (`expand_session_neighbors?: boolean`):** For top-K seed hits that have a `session_id`, fetch sibling observations in the same `session_id` (within `±3` turns or all user turns in that session), score them cheaply against the query (BM25 + dense/reranker), and promote any sibling exceeding a relevance threshold into the candidate set.

#### 7. Activate Signal 3 of RRF: Zero-LLM Deterministic Entity & Signal Extraction
- **Problem:** `hybridSearch()` already has a complete 3-signal RRF pipeline (`Dense + FTS5 + Entity-Graph`, `src/learning/search.ts:1098-1170`), but in zero-LLM mode `entities` and `entity_edges` remain completely empty—leaving Signal 3 dead.
- **Changes:**
  - Create `src/learning/deterministicExtractor.ts` invoked asynchronously (e.g., inside `embedWorker.ts` or a lightweight post-capture hook so `POST /capture/observations` latency stays <5ms and Rule 3 capacity is never affected):
    - **Entity Extraction (zero generative LLM):**
      - *Tier A (zero-dep / JS NLP, <1ms):* Extract capitalized multi-word proper nouns, quoted titles (`"The Glass Menagerie"`, `'The Nightingale'`), file paths, package/tool/app names, and domain entities (`compromise` or deterministic POS/regex).
      - *Tier B (optional local ONNX/GPU discriminative NER):* Support **GLiNER** (`onnx-community/gliner_small-v2.1` or `gliner_medium-v2.1`) under a `BRAIN_NER=local|local-gpu|none` tier to extract typed entities (`person`, `place`, `organization`, `product`, `tool`, `event`, `topic`, `hobby`).
    - Upsert extracted entities into `entities` (reusing existing `idx_entities_dedup`) and insert `entity_edges` (`entity -> observation`, relation `'mentions'`).
    - **Verify Signal 3 path in `search.ts`:** `findEntitySeeds()` + `entity_edges` traversal already supports `target_type = 'observation'`! Add a small improvement in `search.ts`: weight multi-entity matches higher (an observation linked to **2+ matched query entities** should score higher than one linked to 1 generic entity) and ignore ultra-high-degree stop-entities (degree > 30% of project records).
  - **Deterministic Linguistic Signal Tagging (`obs_tags` or `signal_tags TEXT` JSON column on `observations`):**
    - Tag user sentences with zero-LLM linguistic cues (kept universal for both coding and personal memory):
      - `preference`: `"I prefer"`, `"always use"`, `"never use"`, `"I like/love/hate/avoid"`, `"skip the basics"`, `"my favorite"`, `"I usually"`.
      - `state_update`: `"switched to"`, `"migrated to"`, `"moved to"`, `"changed from"`, `"no longer"`, `"replaced"`, `"just started"`, `"now I"`, `"updated to"`.
      - `completed_action` vs `planned_action`: past-tense completion cues vs `"planning to"`, `"thinking of"`, `"might"`.
    - Boost `preference`-tagged observations when a query expresses recommendation/advice/style intent (`"recommend"`, `"suggest"`, `"tips"`, `"ideas"`, `"how should I"`).

#### 8. Sub-Document / Passage-Level Multi-Vector Indexing in Qdrant
- **Problem:** `embedWorker.ts` creates 1 vector per observation over up to 8,000 chars (`MAX_LOCAL_EMBED_CHARS`). In multi-sentence observations—especially casual side remarks (*"By the way, I'm also getting Architectural Digest..."*) or long tool outputs—mean pooling washes out secondary facts, causing ~7 of the 10 `multi-session` partial retrieval misses. Also, `embedWorker.ts:239-245` prepends noisy boilerplate (`prompt: \ninput: `, `response: \noutput: `) to the embedded text.
- **Changes (`src/learning/embedWorker.ts`, `src/learning/search.ts`):**
  - Clean the embedding input text: strip synthetic `prompt: \ninput: ` / `response: \noutput: ` wrapper tokens; embed clean content (`[YYYY-MM-DD] ...` + `tool_name`/`file_path` only when present).
  - For observations longer than ~280 chars:
    - Split into overlapping **1–2 sentence passage chunks** (target 150–300 chars, 1-sentence overlap; cap e.g. 16 chunks per observation so huge logs don't explode Qdrant).
    - Upsert each chunk to Qdrant with deterministic point ID `toQdrantPointId(`${obs.id}#c${idx}`)` and payload `{ record_id: obs.id, record_type: 'observation', chunk_idx: idx, chunk_start, chunk_end, ... }` (SQLite still stores the single verbatim observation row!).
    - In `search.ts`, query Qdrant with `limit: Math.max(limit * 4, 150)`, aggregate by `max(score)` per `record_id`, and **record the winning chunk span (`chunk_start`, `chunk_end`)** so Item #2's query-focused snippet extractor can jump straight to the exact winning sentence!
  - Update `deleteQdrantPoints()` / retention cleanup to delete by Qdrant payload filter `{ key: 'record_id', match: { any: ids } }` instead of point ID alone so all chunks are cleanly purged.

---

### Tier 3 — Local Discriminative Encoders & Precision Controls (Still Zero Extractor LLM)

#### 9. Local Cross-Encoder Reranker Stage (`BRAIN_RERANK`)
- **Problem:** Bi-encoder embeddings + BM25 struggle with taxonomic/semantic bridging (`"citrus fruits"` ↔ `"lime/lemon"`, `"health devices"` ↔ `"hearing aids"`, `"musical instruments"` ↔ `"Stratocaster/FG800"`, `"baked"` ↔ `"sourdough baguette"`), and unweighted `RRF_K = 60` flattens scores (`2.23x` spread between rank 1 and rank 50).
- **Changes (`src/learning/rerank.ts`, `src/learning/search.ts`, `docker-compose.yml`):**
  - Add a new capability tier **`BRAIN_RERANK=none|local|local-gpu|remote`** (default `none` for zero-RAM compatibility; `local-gpu` uses the existing Infinity GPU container's `/rerank` endpoint with **`BAAI/bge-reranker-v2-m3`** or **`jinaai/jina-reranker-v2-base-multilingual`**; `local` uses in-process ONNX `Xenova/ms-marco-MiniLM-L-6-v2`).
  - **Note:** A cross-encoder is a **discriminative encoder** (like the embedder), NOT a generative extractor LLM—zero hallucination, zero write-path cost, ~15–40ms on RTX 4070 for top-100 candidates.
  - Pipeline in `hybridSearch()`:
    1. Gather top `N = Math.max(limit * 3, 100)` candidates from 3-signal RRF (Dense + FTS5 + Entity-Graph + temporal window + session siblings).
    2. Score `(q, candidate_passage)` with the cross-encoder (using the winning chunk / condensed text so the cross-encoder sees crisp 150–400 char passages rather than 2,000-char truncated essays!).
    3. Blend calibrated reranker logit with hierarchy tier & temporal multipliers (`rerankScore * tierMult * temporalMult`).

#### 10. Calibrated Relevance Floor (`min_score`) + Token-Budgeted Retrieval (`max_tokens`)
- **Problem:** `hybridSearch()` always returns up to `limit` (50) rows regardless of relevance. On unanswerable/abstention queries (and off-topic coding searches), 50 weakly related memories flood the caller and induce hallucinations.
- **Changes (`src/learning/types.ts`, `src/learning/search.ts`):**
  - Add optional `min_score?: number` and `max_tokens?: number` (and `score_cliff_ratio?: number`) to `SearchRequest`.
  - When a cross-encoder is active (calibrated `0..1` relevance scores), drop tail results below `min_score` (e.g., `0.05`–`0.10`) or below `top1_score * score_cliff_ratio`, while optionally keeping a small fallback floor (`min_results`, default `0` or caller-configured) if desired.
  - When `max_tokens` is set, greedily pack results in descending relevance order (using condensed/snippet token estimate `Math.ceil(chars / 4)`) until the budget is met, returning `tokens_used` and `truncated_by_budget` metadata in `SearchResponse`.

#### 11. General Multi-Clause / Multi-Entity Query Decomposition in `search.ts` (Zero LLM)
- **Problem:** Cross-topic and comparison queries (`"How many days passed between finishing 'Book A' and attending Event B?"`, `"Compare auth middleware and session store"`) produce a single averaged query vector where the dominant entity crowds out the second half of the question.
- **Changes (`src/learning/search.ts`):**
  - Add a general deterministic query splitter (`src/lib/queryDecompose.ts`):
    - Trigger ONLY on clear multi-clause/multi-entity syntax:
      - Multiple quoted titles/identifiers (`'X'` and `'Y'`).
      - Explicit comparison / temporal-join conjunctions (`"between <A> and <B>"`, `"before <B>"`, `"after <B>"`, `"compared to"`, `"vs"`, `"when <clause B>"` when both clauses contain ≥2 content tokens).
      - Distinct extracted entities (≥2 unrelated proper nouns/files in `q`).
    - Run lightweight dense+FTS candidate retrieval for the full query AND each extracted sub-clause (cap at 3 sub-queries), then merge candidates via round-robin / max-score before reranking so **both halves** of a multi-hop query enter the rerank pool.
  - **Guardrail:** Keep splitting strictly syntactic/entity-based—do **not** hardcode benchmark-specific expansion templates (e.g., no hardcoded `"how old" -> "birthday"` hacks).

#### 12. Stronger Embedding Model + Hybrid Sparse-Dense Vectors (Qdrant Named Vectors)
- **Problem:** Default `nomic-embed-text-v1.5` at 512d Matryoshka (`src/learning/embedding.ts:116-119`) loses nuance on dense conversational + technical recall compared to full-dimension or modern multilingual/hybrid encoders.
- **Changes (`src/learning/embedding.ts`, `src/learning/embedWorker.ts`, `src/learning/search.ts`):**
  - Support full **768d** `nomic` (already configurable via `BRAIN_EMBED_DIM=768`, requires `POST /maintenance/reembed`).
  - Add first-class support for **`BAAI/bge-m3`** (1024d dense + optional learned lexical sparse weights via Qdrant named vectors) or **`Snowflake/snowflake-arctic-embed-m-v2.0`** / **`Qwen3-Embedding-0.6B`** on the `local-gpu` / `remote` tier.
  - Learned sparse vectors (SPLADE / BGE-M3 sparse) natively bridge lexical-semantic synonyms (`"citrus"` ↔ `"lemon"`, `"baking"` ↔ `"sourdough"`) inside Qdrant with zero LLM calls.

#### 13. Deterministic Chronological Conflict / Timeline Clustering in `SearchResponse`
- **Problem:** When a fact, config, or preference changes over time across multiple sessions (`4 engineers` on `2023-05-11` → `5 engineers` on `2023-10-24`; `6 oz` → `5 oz`), flat search lists hide which record supersedes which.
- **Changes (`src/learning/search.ts`, `src/learning/types.ts`):**
  - After final ranking, group results that share ≥1 high-IDF extracted entity (or `file_path`) and span ≥2 distinct `event_at` dates.
  - Attach deterministic, non-mutating sequence metadata to each clustered item (e.g. `timeline_group: { entity, position, total, is_latest_mention }`) and/or return an optional `timeline_clusters` array on `SearchResponse`.
  - Callers (coding agents, dashboards, adapters) can render clear `[Update 2/2 — latest]` markers without any LLM adjudication.

---

## 4. Phased Execution Plan & Expected Score Progression

Because the GPU and Qdrant containers (`nb-mb-gpu`, `nb-mb-qdrant`) are reusable across experiments, execute in **3 incremental stages** and benchmark after each stage:

### Stage A — Fast Search-Time & Timestamp Wins (No Re-Embed Required for First Test)
- Implement **#1 (`event_at` on `observations`)**, **#2b (query-focused snippet extraction in `search.ts`)**, **#3b (search-time temporal window parser + auxiliary SQLite window recall)**, **#4 (density-normalized kind weighting)**, and **#5 (FTS5 stopword removal + two-tier `AND`/`OR` + column weights)**.
- *Note:* Updating `event_at` on existing observations only requires backfilling/passing `event_at` (or re-ingesting with `event_at` set); snippets, FTS5, and temporal query parsing work immediately on existing vectors.
- **Projected score:** `72.2%` → **`~84–87%`** (largest jumps in `single-session-preference`, `knowledge-update`, `temporal-reasoning`, and elimination of all 17 empty answers).

### Stage B — Local Cross-Encoder Reranker + Precision Controls + Session Coherence
- Implement **#9 (`BRAIN_RERANK` with `BAAI/bge-reranker-v2-m3` via Infinity GPU)**, **#10 (`min_score` + `max_tokens` budget)**, **#6 (`pair_id`/`turn_index` + session neighbor expansion + pair dedup)**, and **#11 (general syntactic multi-clause fan-out)**.
- **Projected score:** `~86%` → **`~90–91%`** (major jumps in `multi-session`, abstention accuracy, and taxonomic bridging).

### Stage C — Zero-LLM Ingest Enrichment & Multi-Vector Chunking (Requires One Re-Ingest / Re-Embed)
- Implement **#2a (`condensed_text` column)**, **#3a (ingest-time relative-date anchoring)**, **#7 (deterministic entity extraction + `entities`/`entity_edges` to activate Signal 3 of RRF + universal preference/state-update tags)**, **#8 (sentence-level multi-vector chunking in Qdrant + clean embed text)**, **#12 (768d / `bge-m3` upgrade)**, and **#13 (chronological entity timeline clustering)**.
- **Projected score:** `~90–91%` → **`~92–94%+`**.

### Target Category Trajectory

| Category | Baseline | Stage A | Stage B | Stage C Target |
|---|---:|---:|---:|---:|
| `single-session-user` (70) | 87.1% | ~93% | ~96% | **96–98%** |
| `single-session-assistant` (56) | 85.7% | ~93% | ~95% | **95–97%** |
| `single-session-preference` (30) | 50.0% | ~83% | ~87% | **90–93%** |
| `knowledge-update` (78) | 74.4% | ~88% | ~91% | **92–95%** |
| `temporal-reasoning` (133) | 70.7% | ~84% | ~88% | **89–92%** |
| `multi-session` (133) | 63.9% | ~78% | ~86% | **89–92%** |
| **Overall (500)** | **72.2%** | **~85%** | **~90%** | **92–94%** |

---

## 5. Key Files Reference for the Next Agent

- **SQLite schema & FTS5 triggers:** `src/lib/db.ts` (`OBSERVATIONS_DDL`, `alignObservationsSchema`, `alignFtsSchema`)
- **Observation capture & validation:** `src/memory/observationStore.ts` (`validateObservationItem`, `captureObservations`)
- **Hybrid 3-signal RRF search:** `src/learning/search.ts` (`buildSafeFtsQuery`, `RECORD_SPECS`, `queryTypeFts`, `findEntitySeeds`, `computeTemporalMultiplier`, `hybridSearch`, `truncateObsField`)
- **Search types & API contract:** `src/learning/types.ts` (`SearchRequest`, `SearchResultItem`, `SearchResponse`)
- **Embedding & Qdrant worker:** `src/learning/embedWorker.ts` (`drainEmbedQueue`, `createQdrantCollectionWithIndexes`, `deleteQdrantPoints`, `startReembed`), `src/learning/embedding.ts` (`resolveEmbedderRecipe`, `MAX_LOCAL_EMBED_CHARS`)
- **Temporal utilities:** `src/lib/recurrence.ts` (`normalizeUtcIso`)
- **HTTP routes & MCP parity:** `src/app.ts`, `src/mcp/server.ts`, `src/routes/mcp.ts`
- **Benchmark adapter (caller side—only update to pass newly added brain API params like `event_at` / `session_id` / `snippet_mode`):** `~/Projects/memory-benchmarks/benchmarks/common/neuralbrain_client.py`
- **Verification commands:** `npm run typecheck && npm test` (strict `:memory:` / temp DB isolation; never open live `~/.neuralbrain/data/brain.db` directly).
