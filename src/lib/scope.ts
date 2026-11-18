/**
 * Project identity.
 *
 * Rule 4 makes *scope* explicit. This module makes *identity* deterministic,
 * which is the other half: without it `MyProject`, `myproject` and
 * `My Project` are three different projects, two clients naming the same
 * project differently get silently split memory, and nothing reports it.
 *
 * Two rules, and the second matters more than it looks:
 *
 *  1. Normalise what is unambiguous — case and surrounding whitespace, and
 *     internal whitespace to '-'. These are spellings of one name.
 *
 *  2. REJECT what would require a guess. A filesystem path is the obvious
 *     case: turning '/home/user/Projects/Foo' into 'foo' is inference, it
 *     silently collides with any other repo basenamed 'Foo', and it breaks the
 *     moment a repo moves. Rule 4 says never guess — so the writer is told to
 *     send an id rather than having one derived for them. Hints say to use
 *     the project root folder name (.brainrc, else the git repo root — the
 *     main repo for a worktree), never a subfolder, so all agents come up with
 *     the same id.
 *
 * The normalised form is what gets stored and what is returned, so a client can
 * see what it actually wrote.
 */

export const PROJECT_ID_MAX_LENGTH = 128;

/** Lowercase alphanumerics plus dot, underscore and hyphen. */
const PROJECT_ID_ALLOWED = /^[a-z0-9._-]+$/;

export type ProjectIdResult =
  | { ok: true; projectId: string }
  | { ok: false; error: string };

export function normalizeProjectId(raw: unknown): ProjectIdResult {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'project_id must be a string' };
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, error: 'project_id must not be empty' };
  }

  // Reject rather than derive. See rule 2 in the header.
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return {
      ok: false,
      error:
        `project_id '${trimmed}' looks like a path. Send a stable identifier ` +
        `(e.g. 'neuralbrain'), not a filesystem path: use the project root ` +
        `folder name (from .brainrc, else the git repo root; the main repo for a worktree), ` +
        `never a subfolder, so all agents come up with the same id.`,
    };
  }

  const normalized = trimmed.toLowerCase().replace(/\s+/g, '-');

  if (normalized.length > PROJECT_ID_MAX_LENGTH) {
    return {
      ok: false,
      error: `project_id must be ${PROJECT_ID_MAX_LENGTH} characters or fewer (got ${normalized.length})`,
    };
  }

  if (!PROJECT_ID_ALLOWED.test(normalized)) {
    return {
      ok: false,
      error:
        `project_id '${trimmed}' contains unsupported characters. Allowed after ` +
        `normalisation: lowercase letters, digits, '.', '_' and '-'.`,
    };
  }

  return { ok: true, projectId: normalized };
}

export type ScopeValue = 'project' | 'global' | 'unknown';

/**
 * Resolve scope and project_id together. They are a pair: `project` requires an
 * id, and the other two forbid one, which is also what the table CHECK
 * constraints enforce.
 *
 * Scope defaults to 'unknown' when the writer says nothing — never 'global'.
 * Defaulting to global would put every unlabelled record into every project's
 * injection — a louder version of the unscoped-records problem many memory
 * systems have.
 */
export function resolveScope(
  rawScope: unknown,
  rawProjectId: unknown
): { ok: true; scope: ScopeValue; projectId: string | null } | { ok: false; error: string } {
  let scope: ScopeValue = 'unknown';

  if (rawScope !== undefined && rawScope !== null) {
    if (rawScope === 'project' || rawScope === 'global' || rawScope === 'unknown') {
      scope = rawScope;
    } else {
      return {
        ok: false,
        error: `Invalid scope '${String(rawScope)}'. Must be 'project', 'global', or 'unknown'`,
      };
    }
  }

  if (scope === 'project') {
    const result = normalizeProjectId(rawProjectId);
    if (!result.ok) {
      return { ok: false, error: `${result.error} (required when scope is 'project')` };
    }
    return { ok: true, scope, projectId: result.projectId };
  }

  if (rawProjectId !== undefined && rawProjectId !== null && rawProjectId !== '') {
    return { ok: false, error: `project_id must be null or omitted when scope is '${scope}'` };
  }

  return { ok: true, scope, projectId: null };
}
