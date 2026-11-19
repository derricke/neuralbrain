import { randomUUID } from 'crypto';
import { getDb } from '../lib/db';
import { redactOptional, redactSecrets } from '../lib/redactSecrets';
import { resolveScope, ScopeValue } from '../lib/scope';

export type ActionStatus = 'ready' | 'blocked' | 'in_progress' | 'done' | 'dismissed';
export type ActionPriority = 'low' | 'normal' | 'high' | 'urgent';

const VALID_STATUSES = new Set<ActionStatus>([
  'ready',
  'blocked',
  'in_progress',
  'done',
  'dismissed',
]);

const VALID_PRIORITIES = new Set<ActionPriority>([
  'low',
  'normal',
  'high',
  'urgent',
]);

export interface ActionRecord {
  id: string;
  session_id: string | null;
  scope: ScopeValue;
  project_id: string | null;
  title: string;
  description: string | null;
  status: ActionStatus;
  priority: ActionPriority;
  blocked_reason: string | null;
  files_json: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by_session_id: string | null;
}

export interface CreateActionInput {
  id?: string;
  session_id?: string | null;
  sessionId?: string | null;
  scope?: ScopeValue;
  project_id?: string | null;
  projectId?: string | null;
  title: string;
  description?: string | null;
  status?: ActionStatus;
  priority?: ActionPriority;
  blocked_reason?: string | null;
  blockedReason?: string | null;
  files?: string[];
  files_json?: string | null;
}

export interface UpdateActionPatch {
  scope?: ScopeValue;
  project_id?: string | null;
  projectId?: string | null;
  title?: string;
  description?: string | null;
  status?: ActionStatus;
  priority?: ActionPriority;
  blocked_reason?: string | null;
  blockedReason?: string | null;
  files?: string[];
  files_json?: string | null;
  resolved_by_session_id?: string | null;
  resolvedBySessionId?: string | null;
}

function makeSchemaError(message: string): Error {
  const err = new Error(message);
  (err as any).code = 'SCHEMA_INVALID';
  return err;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw makeSchemaError(`${field} must be a string`);
  }
  return value.trim() || null;
}

/**
 * Create a new next-action record with explicit 3-state scope validation.
 */
export function createAction(input: CreateActionInput): ActionRecord {
  const rawProject = input.projectId !== undefined ? input.projectId : input.project_id;
  const scoped = resolveScope(input.scope, rawProject);
  if (!scoped.ok) {
    throw makeSchemaError(scoped.error);
  }

  if (!input.title || typeof input.title !== 'string' || input.title.trim() === '') {
    throw makeSchemaError('title is required and cannot be empty');
  }

  const status: ActionStatus = input.status ?? 'ready';
  if (!VALID_STATUSES.has(status)) {
    throw makeSchemaError(
      `Invalid action status '${String(status)}'. Must be one of: ready, blocked, in_progress, done, dismissed`
    );
  }

  const priority: ActionPriority = input.priority ?? 'normal';
  if (!VALID_PRIORITIES.has(priority)) {
    throw makeSchemaError(
      `Invalid action priority '${String(priority)}'. Must be one of: low, normal, high, urgent`
    );
  }

  const db = getDb();
  const customId = optionalString(input.id, 'id');
  const id = customId || `act_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const rawSession = input.sessionId !== undefined ? input.sessionId : input.session_id;
  const sessionId = optionalString(rawSession, 'session_id');
  const title = redactSecrets(input.title.trim());
  const description = redactOptional(optionalString(input.description, 'description'));
  const rawBlockedReason =
    input.blockedReason !== undefined ? input.blockedReason : input.blocked_reason;
  const blockedReason = redactOptional(optionalString(rawBlockedReason, 'blocked_reason'));
  const filesJson = Array.isArray(input.files)
    ? JSON.stringify(input.files)
    : input.files_json ?? null;

  const isResolved = status === 'done' || status === 'dismissed';

  db.prepare(
    `
    INSERT INTO actions (
      id, session_id, scope, project_id, title, description,
      status, priority, blocked_reason, files_json, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END)
    `
  ).run(
    id,
    sessionId,
    scoped.scope,
    scoped.projectId,
    title,
    description,
    status,
    priority,
    blockedReason,
    filesJson,
    isResolved ? 1 : 0
  );

  return getAction(id)!;
}

export function getAction(id: string): ActionRecord | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as
    | ActionRecord
    | undefined;
}

export function listActions(filters?: {
  projectId?: string;
  includeGlobal?: boolean;
  status?: string | string[];
  sessionId?: string;
  limit?: number;
}): ActionRecord[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  const projectId = typeof filters?.projectId === 'string' ? filters.projectId.trim() || null : null;
  const includeGlobal = filters?.includeGlobal !== false;

  if (projectId) {
    if (includeGlobal) {
      conditions.push("((project_id = ? AND scope = 'project') OR scope = 'global')");
      params.push(projectId);
    } else {
      conditions.push("(project_id = ? AND scope = 'project')");
      params.push(projectId);
    }
  } else if (filters?.includeGlobal === false) {
    conditions.push("scope != 'global'");
  }

  if (filters?.status) {
    const statuses = Array.isArray(filters.status)
      ? filters.status
      : [filters.status];
    if (statuses.length > 0) {
      const placeholders = statuses.map(() => '?').join(',');
      conditions.push(`status IN (${placeholders})`);
      params.push(...statuses);
    }
  }

  if (typeof filters?.sessionId === 'string' && filters.sessionId.trim()) {
    conditions.push('session_id = ?');
    params.push(filters.sessionId.trim());
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters?.limit ?? 50;
  params.push(limit);

  return db
    .prepare(
      `
      SELECT * FROM actions
      ${whereClause}
      ORDER BY
        CASE priority
          WHEN 'urgent' THEN 0
          WHEN 'high' THEN 1
          WHEN 'normal' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END ASC,
        created_at DESC,
        rowid DESC
      LIMIT ?
      `
    )
    .all(...params) as ActionRecord[];
}

/**
 * Return open ('ready' or 'in_progress') actions for a project plus global actions.
 */
export function getReadyActions(params?: {
  projectId?: string;
  limit?: number;
}): ActionRecord[] {
  return listActions({
    projectId: params?.projectId,
    includeGlobal: true,
    status: ['ready', 'in_progress'],
    limit: params?.limit ?? 10,
  });
}

/**
 * Update an action record. Automatically sets resolved_at when status becomes
 * 'done' or 'dismissed', and always updates updated_at.
 */
export function updateAction(
  id: string,
  patch: UpdateActionPatch
): ActionRecord | undefined {
  const existing = getAction(id);
  if (!existing) return undefined;

  let nextScope = existing.scope;
  let nextProjectId = existing.project_id;
  if (
    patch.scope !== undefined ||
    patch.projectId !== undefined ||
    patch.project_id !== undefined
  ) {
    const rawScope = patch.scope !== undefined ? patch.scope : existing.scope;
    const rawProject =
      patch.projectId !== undefined
        ? patch.projectId
        : patch.project_id !== undefined
        ? patch.project_id
        : existing.project_id;
    const scoped = resolveScope(rawScope, rawProject);
    if (!scoped.ok) {
      throw makeSchemaError(scoped.error);
    }
    nextScope = scoped.scope;
    nextProjectId = scoped.projectId;
  }

  let nextTitle = existing.title;
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || patch.title.trim() === '') {
      throw makeSchemaError('title cannot be empty');
    }
    nextTitle = redactSecrets(patch.title.trim());
  }

  let nextStatus = existing.status;
  if (patch.status !== undefined) {
    if (!VALID_STATUSES.has(patch.status)) {
      throw makeSchemaError(
        `Invalid action status '${String(patch.status)}'. Must be one of: ready, blocked, in_progress, done, dismissed`
      );
    }
    nextStatus = patch.status;
  }

  let nextPriority = existing.priority;
  if (patch.priority !== undefined) {
    if (!VALID_PRIORITIES.has(patch.priority)) {
      throw makeSchemaError(
        `Invalid action priority '${String(patch.priority)}'. Must be one of: low, normal, high, urgent`
      );
    }
    nextPriority = patch.priority;
  }

  const nextDescription =
    patch.description !== undefined
      ? redactOptional(optionalString(patch.description, 'description'))
      : existing.description;

  const rawBlockedReason =
    patch.blockedReason !== undefined ? patch.blockedReason : patch.blocked_reason;
  const nextBlockedReason =
    rawBlockedReason !== undefined
      ? redactOptional(optionalString(rawBlockedReason, 'blocked_reason'))
      : existing.blocked_reason;

  const nextFilesJson = Array.isArray(patch.files)
    ? JSON.stringify(patch.files)
    : patch.files_json !== undefined
    ? optionalString(patch.files_json, 'files_json')
    : existing.files_json;

  const rawResolvedBy =
    patch.resolvedBySessionId !== undefined
      ? patch.resolvedBySessionId
      : patch.resolved_by_session_id;
  const nextResolvedBy =
    rawResolvedBy !== undefined
      ? optionalString(rawResolvedBy, 'resolved_by_session_id')
      : existing.resolved_by_session_id;

  const shouldSetResolvedAt =
    (nextStatus === 'done' || nextStatus === 'dismissed') &&
    existing.status !== 'done' &&
    existing.status !== 'dismissed';

  const shouldClearResolvedAt =
    nextStatus !== 'done' &&
    nextStatus !== 'dismissed' &&
    (existing.status === 'done' || existing.status === 'dismissed');

  const db = getDb();
  db.prepare(
    `
    UPDATE actions
    SET scope = ?,
        project_id = ?,
        title = ?,
        description = ?,
        status = ?,
        priority = ?,
        blocked_reason = ?,
        files_json = ?,
        resolved_by_session_id = ?,
        resolved_at = CASE
          WHEN ? = 1 THEN datetime('now')
          WHEN ? = 1 THEN NULL
          ELSE resolved_at
        END,
        updated_at = datetime('now')
    WHERE id = ?
    `
  ).run(
    nextScope,
    nextProjectId,
    nextTitle,
    nextDescription,
    nextStatus,
    nextPriority,
    nextBlockedReason,
    nextFilesJson,
    nextResolvedBy,
    shouldSetResolvedAt ? 1 : 0,
    shouldClearResolvedAt ? 1 : 0,
    id
  );

  return getAction(id)!;
}
