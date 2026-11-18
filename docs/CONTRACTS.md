# The consolidation contract

Tested against a local model in both reasoning and non-reasoning configurations
with zero fabrication. Check it against your own model with `neuralbrain doctor --ai`,
which runs the [conformance fixtures](#conformance-fixtures) below.

The governing principle, learned the hard way:

> **A field that cannot be verified mechanically must not be generated at all** —
> not merely verified after the fact.

---

## The system prompt

Extraction, never composition. The bans are the load-bearing part.

```
You extract facts from a coding agent's tool-call log. You do not summarize,
interpret, or explain significance.

Output ONLY this JSON, no prose, no markdown fence:

{
  "files_touched": ["exact/path/from/log"],
  "error_verbatim": "exact error string copied character-for-character, or null",
  "claims": [
    {"text": "a statement restating only what the log literally shows",
     "source_ids": ["<id of each observation supporting it>"]}
  ]
}

HARD RULES — a violation makes the output invalid:
- Every string in "error_verbatim" and every path in "files_touched" MUST appear
  verbatim in the log. Copy, never paraphrase.
- "files_touched" means a path that appeared as a tool call's TARGET file_path.
  A path merely mentioned in command output does NOT count.
- Every claim MUST cite the ids of the observations supporting it.
- If the log does not state a cause, DO NOT supply one.
- If the log does not state why something matters, DO NOT say why it matters.
- No importance scores. No confidence scores. No narrative. No outcome.
```

**`outcome` is absent from the output** — it is computed from source rows, not
requested. Testing found a model answering `"success"` for a record with no
outcome at all; the gate cannot catch that, because `outcome` is not a quoted
string. The `files_touched` definition is explicit for the same reason: two
producers disagreed on whether a path in command output counts, and nothing
would have flagged the inconsistency.

---

## The verification gate

Runs on every submission, agent or model alike. No model involved — lookups and
substring checks.

| Check | Fails with |
|---|---|
| content non-empty | `empty_content` |
| `finish_reason != "length"` | `truncated` |
| parses as JSON, no fence, no prose | `unparseable` |
| matches the schema, no extra fields | `schema_invalid` |
| every `error_verbatim` is a substring of the source log | `not_verbatim` |
| every `files_touched` path is a substring of the source log | `not_verbatim` |
| every `source_ids` entry resolves to a real record in the lease | `citation_unresolved` |
| every claim has ≥1 source id | `citation_unresolved` |

Pass → store with `verified = 1`. Fail → `dead_letters` with the reason and the
producer, and **nothing is stored**.

`empty_content` and `truncated` are not hypothetical. Both were observed:
`200 OK`, `finish_reason: "stop"`, zero-length content, nothing thrown. A bare
`catch (e) {}` sees none of it, and a field-counting quality score would have
scored a truncated object highly for having `files_touched` populated.

---

## Computed, never generated

| Field | Source |
|---|---|
| `outcome` | `success` / `failure` from whether any source observation has `failed=1`; `unknown` if none record an outcome |
| `tool_call_count` | `COUNT(*)` over the lease's observations |
| `duration_ms` | `SUM(duration_ms)` |
| `failure_patterns.count` | UPSERT increment, `GROUP BY` for reads |
| `window_from` / `window_to` | `MIN`/`MAX(created_at)` |

Testing showed why this matters beyond correctness: on a log with the same error
in three separate runs, the model produced two true, properly cited claims and
omitted both facts that mattered — *that the error recurred three times*, and
*that an edit did not fix it*. For failure-pattern mining those are the entire
signal.

So: the model does not lie about counts, it **does not think to mention them**.
Arithmetic fields are the defence against omission, which no citation check can
detect.

---

## What the gate does not guarantee

**It proves every stored claim is supported. It does not prove the supported
claims were all stored.** Verification catches fabrication, not omission.

State this plainly in operator docs rather than implying more. Mitigation is the
computed fields above, where completeness is structural rather than a model's
discretion.

---

## Budget and the reasoning trap

Probe once at startup with a trivial prompt and read `reasoning_tokens` from the
real response. Size `max_tokens` from what the endpoint actually does.

**Do not trust a no-think flag.** On tested hardware neither
`chat_template_kwargs: {enable_thinking:false}` nor a `/no_think` suffix was
honoured — and memory tools commonly ship a "no-think" setting on the same
assumption. Measured, same model, same fixture:

| Config | reasoning tokens | result |
|---|---|---|
| reasoning, 1200 budget | 1945 | empty |
| reasoning, 6000 budget | 5820 | empty |
| reasoning, 12000 budget | 4844 | valid, 153 s |
| **non-reasoning build** | **0** | **valid, 4.3 s** |

A reasoning model is the wrong tool: extraction needs no reasoning, and reasoning
is what breaks it. Prefer a non-reasoning instruct build, and warn when
`reasoning_tokens > 0` that budgets must be sized accordingly.

---

## Conformance fixtures

Shipped, not scratch files. `brain doctor --ai` runs them against whatever is
configured.

| Fixture | Tests | Expected |
|---|---|---|
| rich failure log | extraction from a real error, repeated runs | `outcome: failure`, error verbatim, all claims cited |
| rich success log | counts and multi-file edits | `outcome: success`, 4 paths, counts correct |
| **single bare file read** | **the trap** | `outcome: unknown`, ~1 claim, **nothing invented** |

The sparse fixture is the one that matters. Models invent precisely when the log
says least, and running compression per-observation — the sparsest case
available — on the write path hits that case thousands of times. A model that writes a confident narrative for one
bare `Read` has failed, however good its output looks elsewhere.
