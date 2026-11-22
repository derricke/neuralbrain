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
 *     Hierarchical subprojects use '/' to separate segments (e.g.
 *     'acme/socials/calendar').
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

export const PROJECT_ID_MAX_LENGTH = 256;

/** Lowercase alphanumerics plus dot, underscore and hyphen (per segment). */
const PROJECT_ID_ALLOWED = /^[a-z0-9._-]+$/;

/** Windows drive prefix like C:/ or d:/ */
const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:\//;

export type ProjectIdResult =
  | { ok: true; projectId: string }
  | { ok: false; error: string };

function pathRejectionError(trimmed: string): ProjectIdResult {
  return {
    ok: false,
    error:
      `project_id '${trimmed}' looks like a path. Send a stable identifier ` +
      `(e.g. 'neuralbrain' or 'acme/app'), not a filesystem path: use the project root ` +
      `folder name (from .brainrc, else the git repo root; the main repo for a worktree), ` +
      `never a subfolder, so all agents come up with the same id.`,
  };
}

export function normalizeProjectId(raw: unknown): ProjectIdResult {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'project_id must be a string' };
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, error: 'project_id must not be empty' };
  }

  // Reject filesystem paths rather than deriving. See rule 2 in the header.
  if (
    trimmed.startsWith('/') ||
    trimmed.includes('\\') ||
    WINDOWS_DRIVE_PREFIX.test(trimmed) ||
    trimmed.startsWith('~') ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../')
  ) {
    return pathRejectionError(trimmed);
  }

  // Trim trailing slashes and collapse consecutive slashes into single '/'
  const cleaned = trimmed.replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  if (cleaned === '') {
    return pathRejectionError(trimmed);
  }

  const rawSegments = cleaned.split('/');
  const normalizedSegments: string[] = [];

  for (const rawSeg of rawSegments) {
    const seg = rawSeg.trim().toLowerCase().replace(/\s+/g, '-');
    if (seg === '') {
      return {
        ok: false,
        error: `project_id '${trimmed}' contains an empty path segment.`,
      };
    }
    if (seg === '.' || seg === '..') {
      return pathRejectionError(trimmed);
    }
    if (!PROJECT_ID_ALLOWED.test(seg)) {
      return {
        ok: false,
        error:
          `project_id '${trimmed}' contains unsupported characters. Allowed after ` +
          `normalisation: lowercase letters, digits, '.', '_' and '-' (with '/' separating hierarchy segments).`,
      };
    }
    normalizedSegments.push(seg);
  }

  const normalized = normalizedSegments.join('/');

  if (normalized.length > PROJECT_ID_MAX_LENGTH) {
    return {
      ok: false,
      error: `project_id must be ${PROJECT_ID_MAX_LENGTH} characters or fewer (got ${normalized.length})`,
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

/**
 * Returns every ancestor prefix from root down to the project itself.
 * e.g. 'acme/socials/calendar' -> ['acme', 'acme/socials', 'acme/socials/calendar'].
 */
export function getProjectAncestors(projectId: string): string[] {
  const norm = normalizeProjectId(projectId);
  const clean = norm.ok
    ? norm.projectId
    : projectId.trim().replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  if (!clean) return [];

  const parts = clean.split('/').filter(Boolean);
  const ancestors: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    ancestors.push(parts.slice(0, i + 1).join('/'));
  }
  return ancestors;
}

/**
 * Exact ASCII B-tree index range scan bounds for strict descendants of `projectId`.
 * '/' is ASCII 47 and '0' is ASCII 48, so `project_id >= '${id}/' AND project_id < '${id}0'`
 * matches all children without LIKE wildcard issues and uses B-tree indexes directly.
 */
export function getProjectChildRange(projectId: string): { gte: string; lt: string } {
  const norm = normalizeProjectId(projectId);
  const clean = norm.ok ? norm.projectId : projectId.trim().replace(/\/+$/, '');
  return { gte: `${clean}/`, lt: `${clean}0` };
}

export type MatchTier = 'exact' | 'ancestor' | 'child' | 'global' | 'unknown';

export function classifyMatchTier(
  rowScope: string,
  rowProjectId: string | null | undefined,
  queryProjectId?: string | null
): { match_tier: MatchTier; ancestor_distance?: number } {
  if (rowScope === 'global') {
    return { match_tier: 'global' };
  }
  if (rowScope !== 'project' || !rowProjectId) {
    return { match_tier: 'unknown' };
  }
  if (!queryProjectId || !queryProjectId.trim()) {
    return { match_tier: 'exact' };
  }

  const queryRes = normalizeProjectId(queryProjectId);
  const rowRes = normalizeProjectId(rowProjectId);
  const queryNorm = queryRes.ok ? queryRes.projectId : queryProjectId.trim();
  const rowNorm = rowRes.ok ? rowRes.projectId : rowProjectId.trim();

  if (rowNorm === queryNorm) {
    return { match_tier: 'exact' };
  }
  if (queryNorm.startsWith(`${rowNorm}/`)) {
    const ancestorDistance = queryNorm.split('/').length - rowNorm.split('/').length;
    return { match_tier: 'ancestor', ancestor_distance: ancestorDistance };
  }
  if (rowNorm.startsWith(`${queryNorm}/`)) {
    return { match_tier: 'child' };
  }
  return { match_tier: 'exact' };
}

export interface HierarchicalScopeSqlOptions {
  tableAlias?: string;
  scope?: string;
  projectId?: string | null;
  includeAncestors?: boolean;
  includeChildren?: boolean;
  includeGlobal?: boolean;
  userId?: string | null;
}

export function buildHierarchicalScopeSql(options: HierarchicalScopeSqlOptions): {
  clause: string;
  params: unknown[];
  normalizedProjectId: string | null;
} {
  const includeAncestors = options.includeAncestors ?? true;
  const includeChildren = options.includeChildren ?? false;
  const includeGlobal = options.includeGlobal ?? true;

  const prefix = options.tableAlias ? `${options.tableAlias}.` : '';
  const colScope = `${prefix}scope`;
  const colProject = `${prefix}project_id`;
  const colUser = `${prefix}user_id`;

  let normalizedProjectId: string | null = null;
  if (typeof options.projectId === 'string' && options.projectId.trim() !== '') {
    const norm = normalizeProjectId(options.projectId);
    normalizedProjectId = norm.ok ? norm.projectId : options.projectId.trim();
  }

  const cleanUserId =
    typeof options.userId === 'string' && options.userId.trim() !== ''
      ? options.userId.trim()
      : null;

  const params: unknown[] = [];
  let scopeClause: string;

  if (options.scope === 'unknown') {
    scopeClause = `${colScope} = 'unknown'`;
  } else if (options.scope === 'global') {
    scopeClause = `${colScope} = 'global'`;
  } else if (normalizedProjectId !== null) {
    const projParts: string[] = [];
    if (includeAncestors) {
      const ancestors = getProjectAncestors(normalizedProjectId);
      const placeholders = ancestors.map(() => '?').join(', ');
      projParts.push(`${colProject} IN (${placeholders})`);
      params.push(...ancestors);
    } else {
      projParts.push(`${colProject} = ?`);
      params.push(normalizedProjectId);
    }

    if (includeChildren) {
      const range = getProjectChildRange(normalizedProjectId);
      projParts.push(`(${colProject} >= ? AND ${colProject} < ?)`);
      params.push(range.gte, range.lt);
    }

    const projExpr = projParts.join(' OR ');
    const projectBranch = `(${colScope} = 'project' AND (${projExpr}))`;
    scopeClause = includeGlobal
      ? `(${projectBranch} OR ${colScope} = 'global')`
      : projectBranch;
  } else if (options.scope === 'project') {
    scopeClause = includeGlobal
      ? `(${colScope} = 'project' OR ${colScope} = 'global')`
      : `${colScope} = 'project'`;
  } else {
    scopeClause = includeGlobal ? `${colScope} = 'global'` : '1 = 0';
  }

  if (cleanUserId !== null) {
    const wrapped =
      scopeClause.startsWith('(') && scopeClause.endsWith(')')
        ? scopeClause
        : `(${scopeClause})`;
    params.push(cleanUserId);
    return {
      clause: `${wrapped} AND ${colUser} = ?`,
      params,
      normalizedProjectId,
    };
  }

  return {
    clause: scopeClause,
    params,
    normalizedProjectId,
  };
}
