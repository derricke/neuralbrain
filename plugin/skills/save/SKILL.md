---
name: save
description: Save a durable memory note or imperative lesson to neuralbrain with explicit scope, concepts, and file paths. Use when the user says "save this", "remember this", "note that", "learn this", corrects your approach, or settles a decision or bug root cause.
argument-hint: "[fact, decision, or lesson to save]"
user-invocable: true
---

The user wants to persist a memory or lesson in neuralbrain: $ARGUMENTS

## Quick start

Saving a project decision/fact:

```json
brain_save {
  "type": "architecture",
  "title": "Cursor pagination for audit list",
  "content": "Use cursor pagination in db/list.ts; offset scans degraded past 100k rows.",
  "scope": "project",
  "project_id": "my-project",
  "concepts": ["cursor-pagination", "offset-scan-limit"],
  "files": ["src/db/list.ts"]
}
```

Saving a lesson (rule from a correction or gotcha):

```json
brain_save {
  "type": "lesson",
  "title": "Run vitest with --run in CI",
  "content": "Always invoke vitest with --run in CI or scripts; bare vitest enters watch mode and hangs.",
  "scope": "global",
  "concepts": ["vitest", "ci-hang"]
}
```

## Why

Notes are never auto-deleted and never carry `importance` or `confidence` scores. Retrieval quality depends on choosing the right `type`, explicit `scope`, specific `concepts`, and preserving the reason or consequence.

## Workflow

1. Decide whether this is a **general memory** (`fact`, `architecture`, `pattern`, `workflow`, `bug`, `preference`) or a **lesson** (`lesson` — a behavioral rule from a correction, gotcha, or repeated mistake).
2. Distill the record:
   - **Memory**: Concise `title` + `content` with both the conclusion and the reason.
   - **Lesson**: One imperative rule (what to do or avoid, trigger situation, and consequence). Strip incident storytelling.
   - Redact all API keys, tokens, passwords, and credentials.
3. Set `scope` explicitly (never guess or default):
   - `"project"` with canonical `project_id` (from `.brainrc`, else the git repo root folder name — main repo for worktrees — lowercase; never a subfolder or filesystem path; if ambiguous use `"unknown"`).
   - `"global"` strictly for universal cross-project truths.
   - `"unknown"` when scope is genuinely unclear.
4. Add 2–5 specific lowercased `concepts` and real repo-relative `files`. If updating an older note, pass `supersedes: "<old_note_id>"`.
5. Call `brain_save`, then echo the saved `type`, `scope`, `title`, and `concepts` so the user can verify or veto.

## Anti-patterns

WRONG: Save with `scope: "global"` because you didn't check `.brainrc`, or use generic tags like `["code", "notes"]`.

RIGHT: Use explicit `scope: "project"` + canonical `project_id` (or `"unknown"` if unsure) and specific concepts like `["jwt-refresh", "token-revocation"]`.

## Checklist

- Explicit `scope` provided (`project`, `global`, or `unknown`); `project_id` is the project root folder slug, not a subfolder or path.
- Lessons are framed as imperative rule + trigger + consequence.
- No secrets or credentials in `title` or `content`.
- 2–5 specific `concepts` and real `files` included; `supersedes` used for updates.

## See also

- `search`: retrieve saved notes and lessons.
- `handoff`: capture end-of-session Next Actions and handoff summaries.

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) if `brain_save` is unavailable.
