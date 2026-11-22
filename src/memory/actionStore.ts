import { randomUUID } from 'crypto';
import { getDb } from '../lib/db';
import { redactOptional, redactSecrets } from '../lib/redactSecrets';
import { computeNextOccurrence, normalizeUtcIso, validateRecurrence } from '../lib/recurrence';
import {
  buildHierarchicalScopeSql,
  classifyMatchTier,
  MatchTier,
  resolveScope,
  ScopeValue,
} from '../lib/scope';
import { transaction } from '../lib/sqlite';
import { enqueueForEmbedding } from './embedQueueStore';

export type ActionStatus = 'ready' | 'blocked' | 'in_progress' | 'done' | 'dismissed';
export type ActionPriority = 'low' | 'normal' | 'high' | 'urgent';

export const ACTION_COLUMNS =
  'id, session_id, scope, project_id, user_id, agent_id, title, description, status, priority, blocked_reason, files_json, due_at, remind_at, recurrence, last_reminded_at, snooze_until, parent_action_id, created_at, updated_at, resolved_at, resolved_by_session_id';

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
  user_id: string | null;
  agent_id: string | null;
  title: string;
  description: string | null;
  status: ActionStatus;
  priority: ActionPriority;
  blocked_reason: string | null;
  files_json: string | null;
  due_at: string | null;
  remind_at: string | null;
  recurrence: string | null;
  last_reminded_at: string | null;
  snooze_until: string | null;
  parent_action_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by_session_id: string | null;
  match_tier?: MatchTier;
  overdue?: boolean;
  next_occurrence?: ActionRecord;
}

export interface CreateActionInput {
  id?: string;
  session_id?: string | null;
  sessionId?: string | null;
  scope?: ScopeValue;
  project_id?: string | null;
  projectId?: string | null;
  user_id?: string | null;
  userId?: string | null;
  agent_id?: string | null;
  agentId?: string | null;
  title: string;
  description?: string | null;
  status?: ActionStatus;
  priority?: ActionPriority;
  blocked_reason?: string | null;
  blockedReason?: string | null;
  files?: string[];
  files_json?: string | null;
  due_at?: string | Date | null;
  dueAt?: string | Date | null;
  remind_at?: string | Date | null;
  remindAt?: string | Date | null;
  recurrence?: string | null;
  last_reminded_at?: string | Date | null;
  lastRemindedAt?: string | Date | null;
  snooze_until?: string | Date | null;
  snoozeUntil?: string | Date | null;
  parent_action_id?: string | null;
  parentActionId?: string | null;
}

export interface UpdateActionPatch {
  scope?: ScopeValue;
  project_id?: string | null;
  projectId?: string | null;
  user_id?: string | null;
  userId?: string | null;
  agent_id?: string | null;
  agentId?: string | null;
  title?: string;
  description?: string | null;
  status?: ActionStatus;
  priority?: ActionPriority;
  blocked_reason?: string | null;
  blockedReason?: string | null;
  files?: string[];
  files_json?: string | null;
  due_at?: string | Date | null;
  dueAt?: string | Date | null;
  remind_at?: string | Date | null;
  remindAt?: string | Date | null;
  recurrence?: string | null;
  last_reminded_at?: string | Date | null;
  lastRemindedAt?: string | Date | null;
  snooze_until?: string | Date | null;
  snoozeUntil?: string | Date | null;
  parent_action_id?: string | null;
  parentActionId?: string | null;
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

function pickField<T>(camel: T | undefined, snake: T | undefined): T | undefined {
  return camel !== undefined ? camel : snake;
}

function normalizeRecurrenceInput(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw makeSchemaError('recurrence must be a string');
  }
  if (raw.trim() === '') return null;
  const validated = validateRecurrence(raw);
  if (!validated.ok) {
    throw makeSchemaError(validated.error);
  }
  return validated.normalized;
}

function parseValidDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

const PRIORITY_ORDER_SQL = `
  CASE priority
    WHEN 'urgent' THEN 0
    WHEN 'high' THEN 1
    WHEN 'normal' THEN 2
    WHEN 'low' THEN 3
    ELSE 4
  END ASC
`;

function appendScopeAndUserFilters(
  conditions: string[],
  params: unknown[],
  filters?: {
    projectId?: string;
    includeAncestors?: boolean;
    includeChildren?: boolean;
    includeGlobal?: boolean;
    userId?: string;
  }
): string | null {
  const projectId = typeof filters?.projectId === 'string' ? filters.projectId.trim() || null : null;
  const includeGlobal = filters?.includeGlobal !== false;

  if (projectId) {
    const scopeSql = buildHierarchicalScopeSql({
      projectId,
      includeAncestors: filters?.includeAncestors ?? true,
      includeChildren: filters?.includeChildren ?? false,
      includeGlobal,
      userId: filters?.userId,
    });
    conditions.push(scopeSql.clause);
    params.push(...scopeSql.params);
    return scopeSql.normalizedProjectId;
  }

  if (filters?.includeGlobal === false) {
    conditions.push("scope != 'global'");
  }
  if (typeof filters?.userId === 'string' && filters.userId.trim() !== '') {
    conditions.push('user_id = ?');
    params.push(filters.userId.trim());
  }
  return null;
}

/**
 * Create a new next-action record with explicit 3-state scope validation.
 */
export function createAction(input: CreateActionInput): ActionRecord {
  const rawProject = pickField(input.projectId, input.project_id);
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

  const customId = optionalString(input.id, 'id');
  const id = customId || `act_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const sessionId = optionalString(pickField(input.sessionId, input.session_id), 'session_id');
  const userId = optionalString(pickField(input.userId, input.user_id), 'user_id');
  const agentId = optionalString(pickField(input.agentId, input.agent_id), 'agent_id');
  const title = redactSecrets(input.title.trim());
  const description = redactOptional(optionalString(input.description, 'description'));
  const blockedReason = redactOptional(
    optionalString(pickField(input.blockedReason, input.blocked_reason), 'blocked_reason')
  );
  const filesJson = Array.isArray(input.files)
    ? JSON.stringify(input.files)
    : input.files_json ?? null;
  const dueAt = normalizeUtcIso(pickField(input.dueAt, input.due_at), 'due_at');
  const remindAt = normalizeUtcIso(pickField(input.remindAt, input.remind_at), 'remind_at');
  const recurrence = normalizeRecurrenceInput(input.recurrence);
  const lastRemindedAt = normalizeUtcIso(
    pickField(input.lastRemindedAt, input.last_reminded_at),
    'last_reminded_at'
  );
  const snoozeUntil = normalizeUtcIso(
    pickField(input.snoozeUntil, input.snooze_until),
    'snooze_until'
  );
  const parentActionId = optionalString(
    pickField(input.parentActionId, input.parent_action_id),
    'parent_action_id'
  );

  const isResolved = status === 'done' || status === 'dismissed';
  const db = getDb();

  return transaction(db, () => {
    db.prepare(
      `
      INSERT INTO actions (
        id, session_id, scope, project_id, user_id, agent_id, title, description,
        status, priority, blocked_reason, files_json,
        due_at, remind_at, recurrence, last_reminded_at, snooze_until, parent_action_id,
        resolved_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
      )
      `
    ).run(
      id,
      sessionId,
      scoped.scope,
      scoped.projectId,
      userId,
      agentId,
      title,
      description,
      status,
      priority,
      blockedReason,
      filesJson,
      dueAt,
      remindAt,
      recurrence,
      lastRemindedAt,
      snoozeUntil,
      parentActionId,
      isResolved ? 1 : 0
    );

    enqueueForEmbedding(id, 'action');
    return getAction(id)!;
  })();
}

export function getAction(id: string): ActionRecord | undefined {
  const db = getDb();
  return db.prepare(`SELECT ${ACTION_COLUMNS} FROM actions WHERE id = ?`).get(id) as
    | ActionRecord
    | undefined;
}

export function listActions(filters?: {
  projectId?: string;
  includeAncestors?: boolean;
  includeChildren?: boolean;
  includeGlobal?: boolean;
  userId?: string;
  status?: string | string[];
  sessionId?: string;
  dueOnly?: boolean;
  before?: string;
  limit?: number;
}): ActionRecord[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  const queryProjectId = appendScopeAndUserFilters(conditions, params, filters);

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

  const beforeIso = filters?.before !== undefined ? normalizeUtcIso(filters.before, 'before') : null;
  if (filters?.dueOnly === true) {
    const cutoffIso = beforeIso ?? new Date().toISOString();
    conditions.push("status IN ('ready', 'in_progress')");
    conditions.push('((remind_at IS NOT NULL AND remind_at <= ?) OR (due_at IS NOT NULL AND due_at <= ?))');
    params.push(cutoffIso, cutoffIso);
    conditions.push('(snooze_until IS NULL OR snooze_until <= ?)');
    params.push(cutoffIso);
  } else if (beforeIso !== null) {
    conditions.push('((due_at IS NOT NULL AND due_at <= ?) OR (remind_at IS NOT NULL AND remind_at <= ?))');
    params.push(beforeIso, beforeIso);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters?.limit ?? 50;
  params.push(limit);

  const rows = db
    .prepare(
      `
      SELECT ${ACTION_COLUMNS} FROM actions
      ${whereClause}
      ORDER BY
        ${PRIORITY_ORDER_SQL},
        created_at DESC,
        rowid DESC
      LIMIT ?
      `
    )
    .all(...params) as ActionRecord[];

  return rows.map((row) => ({
    ...row,
    match_tier: classifyMatchTier(row.scope, row.project_id, queryProjectId).match_tier,
  }));
}

/**
 * Return due or reminded open actions ('ready' or 'in_progress') not snoozed past cutoff.
 */
export function getDueActions(filters?: {
  projectId?: string;
  includeAncestors?: boolean;
  includeChildren?: boolean;
  includeGlobal?: boolean;
  userId?: string;
  before?: string;
  unremindedOnly?: boolean;
  cooldownMs?: number;
  limit?: number;
}): ActionRecord[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  const queryProjectId = appendScopeAndUserFilters(conditions, params, filters);

  const nowIso = new Date().toISOString();
  const beforeIso = filters?.before !== undefined ? normalizeUtcIso(filters.before, 'before') : null;
  const cutoffIso = beforeIso ?? nowIso;

  conditions.push("status IN ('ready', 'in_progress')");
  conditions.push('((remind_at IS NOT NULL AND remind_at <= ?) OR (due_at IS NOT NULL AND due_at <= ?))');
  params.push(cutoffIso, cutoffIso);
  conditions.push('(snooze_until IS NULL OR snooze_until <= ?)');
  params.push(cutoffIso);

  if (filters?.unremindedOnly === true) {
    if (filters.cooldownMs !== undefined && filters.cooldownMs !== null) {
      if (
        typeof filters.cooldownMs !== 'number' ||
        !Number.isFinite(filters.cooldownMs) ||
        filters.cooldownMs < 0
      ) {
        throw makeSchemaError('cooldownMs must be a non-negative finite number');
      }
      const cooldownCutoffIso = new Date(Date.now() - filters.cooldownMs).toISOString();
      conditions.push('(last_reminded_at IS NULL OR last_reminded_at <= ?)');
      params.push(cooldownCutoffIso);
    } else {
      conditions.push('last_reminded_at IS NULL');
    }
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const limit = filters?.limit ?? 50;
  params.push(limit);

  const rows = db
    .prepare(
      `
      SELECT ${ACTION_COLUMNS} FROM actions
      ${whereClause}
      ORDER BY
        COALESCE(remind_at, due_at) ASC,
        ${PRIORITY_ORDER_SQL},
        created_at DESC,
        rowid DESC
      LIMIT ?
      `
    )
    .all(...params) as ActionRecord[];

  return rows.map((row) => ({
    ...row,
    match_tier: classifyMatchTier(row.scope, row.project_id, queryProjectId).match_tier,
    overdue: Boolean(row.due_at && row.due_at <= nowIso),
  }));
}

/**
 * Return open ('ready' or 'in_progress') actions for a project (plus ancestors and global by default).
 */
export function getReadyActions(params?: {
  projectId?: string;
  includeAncestors?: boolean;
  includeChildren?: boolean;
  includeGlobal?: boolean;
  userId?: string;
  limit?: number;
}): ActionRecord[] {
  return listActions({
    projectId: params?.projectId,
    includeAncestors: params?.includeAncestors ?? true,
    includeChildren: params?.includeChildren ?? false,
    includeGlobal: params?.includeGlobal ?? true,
    userId: params?.userId,
    status: ['ready', 'in_progress'],
    limit: params?.limit ?? 10,
  });
}

/**
 * Update an action record. Automatically sets resolved_at when status becomes
 * 'done' or 'dismissed', spawns the next occurrence when completing a recurring
 * action, and always updates updated_at inside a single transaction.
 */
export function updateAction(
  id: string,
  patch: UpdateActionPatch
): ActionRecord | undefined {
  const db = getDb();

  return transaction(db, () => {
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

    const rawUser = pickField(patch.userId, patch.user_id);
    const nextUserId = rawUser !== undefined ? optionalString(rawUser, 'user_id') : existing.user_id;

    const rawAgent = pickField(patch.agentId, patch.agent_id);
    const nextAgentId =
      rawAgent !== undefined ? optionalString(rawAgent, 'agent_id') : existing.agent_id;

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

    const rawBlockedReason = pickField(patch.blockedReason, patch.blocked_reason);
    const nextBlockedReason =
      rawBlockedReason !== undefined
        ? redactOptional(optionalString(rawBlockedReason, 'blocked_reason'))
        : existing.blocked_reason;

    const nextFilesJson = Array.isArray(patch.files)
      ? JSON.stringify(patch.files)
      : patch.files_json !== undefined
      ? optionalString(patch.files_json, 'files_json')
      : existing.files_json;

    const rawDueAt = pickField(patch.dueAt, patch.due_at);
    const nextDueAt =
      rawDueAt !== undefined ? normalizeUtcIso(rawDueAt, 'due_at') : existing.due_at;

    const rawRemindAt = pickField(patch.remindAt, patch.remind_at);
    const nextRemindAt =
      rawRemindAt !== undefined ? normalizeUtcIso(rawRemindAt, 'remind_at') : existing.remind_at;

    const nextRecurrence =
      patch.recurrence !== undefined
        ? normalizeRecurrenceInput(patch.recurrence)
        : existing.recurrence;

    const rawLastRemindedAt = pickField(patch.lastRemindedAt, patch.last_reminded_at);
    const nextLastRemindedAt =
      rawLastRemindedAt !== undefined
        ? normalizeUtcIso(rawLastRemindedAt, 'last_reminded_at')
        : existing.last_reminded_at;

    const rawSnoozeUntil = pickField(patch.snoozeUntil, patch.snooze_until);
    const nextSnoozeUntil =
      rawSnoozeUntil !== undefined
        ? normalizeUtcIso(rawSnoozeUntil, 'snooze_until')
        : existing.snooze_until;

    const rawParentActionId = pickField(patch.parentActionId, patch.parent_action_id);
    const nextParentActionId =
      rawParentActionId !== undefined
        ? optionalString(rawParentActionId, 'parent_action_id')
        : existing.parent_action_id;

    const rawResolvedBy = pickField(patch.resolvedBySessionId, patch.resolved_by_session_id);
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

    db.prepare(
      `
      UPDATE actions
      SET scope = ?,
          project_id = ?,
          user_id = ?,
          agent_id = ?,
          title = ?,
          description = ?,
          status = ?,
          priority = ?,
          blocked_reason = ?,
          files_json = ?,
          due_at = ?,
          remind_at = ?,
          recurrence = ?,
          last_reminded_at = ?,
          snooze_until = ?,
          parent_action_id = ?,
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
      nextUserId,
      nextAgentId,
      nextTitle,
      nextDescription,
      nextStatus,
      nextPriority,
      nextBlockedReason,
      nextFilesJson,
      nextDueAt,
      nextRemindAt,
      nextRecurrence,
      nextLastRemindedAt,
      nextSnoozeUntil,
      nextParentActionId,
      nextResolvedBy,
      shouldSetResolvedAt ? 1 : 0,
      shouldClearResolvedAt ? 1 : 0,
      id
    );

    const textOrRankChanged =
      nextTitle !== existing.title ||
      nextDescription !== existing.description ||
      nextBlockedReason !== existing.blocked_reason ||
      nextStatus !== existing.status ||
      nextPriority !== existing.priority;

    if (textOrRankChanged) {
      enqueueForEmbedding(id, 'action');
    }

    let nextOccurrence: ActionRecord | undefined;
    if (nextStatus === 'done' && existing.status !== 'done' && nextRecurrence) {
      const now = new Date();
      const dueDate = parseValidDate(nextDueAt);
      const remindDate = parseValidDate(nextRemindAt);
      let spawnedDueAt: string | null = null;
      let spawnedRemindAt: string | null = null;

      if (dueDate && remindDate) {
        const leadMs = dueDate.getTime() - remindDate.getTime();
        const nextDue = computeNextOccurrence(nextRecurrence, dueDate);
        spawnedDueAt = nextDue.toISOString();
        spawnedRemindAt = new Date(nextDue.getTime() - leadMs).toISOString();
      } else if (dueDate) {
        spawnedDueAt = computeNextOccurrence(nextRecurrence, dueDate).toISOString();
      } else if (remindDate) {
        spawnedRemindAt = computeNextOccurrence(nextRecurrence, remindDate).toISOString();
      } else {
        spawnedDueAt = computeNextOccurrence(nextRecurrence, now).toISOString();
      }

      const spawnedId = `act_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      db.prepare(
        `
        INSERT INTO actions (
          id, session_id, scope, project_id, user_id, agent_id, title, description,
          status, priority, blocked_reason, files_json,
          due_at, remind_at, recurrence, last_reminded_at, snooze_until, parent_action_id
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?,
          'ready', ?, NULL, ?,
          ?, ?, ?, NULL, NULL, ?
        )
        `
      ).run(
        spawnedId,
        existing.session_id,
        nextScope,
        nextProjectId,
        nextUserId,
        nextAgentId,
        nextTitle,
        nextDescription,
        nextPriority,
        nextFilesJson,
        spawnedDueAt,
        spawnedRemindAt,
        nextRecurrence,
        existing.id
      );

      enqueueForEmbedding(spawnedId, 'action');
      nextOccurrence = getAction(spawnedId)!;
    }

    const updated = getAction(id)!;
    return nextOccurrence ? { ...updated, next_occurrence: nextOccurrence } : updated;
  })();
}

/**
 * Evaluate due unreminded actions and, unless dryRun is true, stamp last_reminded_at.
 */
export function checkReminders(options?: {
  projectId?: string;
  includeAncestors?: boolean;
  includeChildren?: boolean;
  includeGlobal?: boolean;
  userId?: string;
  before?: string;
  cooldownMs?: number;
  dryRun?: boolean;
  limit?: number;
}): { checked_at: string; reminders: ActionRecord[]; marked_count: number } {
  const db = getDb();

  return transaction(db, () => {
    const nowIso = new Date().toISOString();
    const reminders = getDueActions({
      projectId: options?.projectId,
      includeAncestors: options?.includeAncestors,
      includeChildren: options?.includeChildren,
      includeGlobal: options?.includeGlobal,
      userId: options?.userId,
      before: options?.before,
      unremindedOnly: true,
      cooldownMs: options?.cooldownMs,
      limit: options?.limit,
    });

    if (options?.dryRun || reminders.length === 0) {
      return {
        checked_at: nowIso,
        reminders,
        marked_count: 0,
      };
    }

    const CHUNK_SIZE = 500;
    const ids = reminders.map((r) => r.id);
    let markedCount = 0;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const res = db
        .prepare(
          `UPDATE actions SET last_reminded_at = ?, updated_at = datetime('now') WHERE id IN (${placeholders})`
        )
        .run(nowIso, ...chunk);
      markedCount += res.changes;
    }

    const stamped = reminders.map((r) => ({
      ...r,
      last_reminded_at: nowIso,
    }));

    return {
      checked_at: nowIso,
      reminders: stamped,
      marked_count: markedCount,
    };
  })();
}

/**
 * Acknowledge delivered reminders by stamping last_reminded_at on the specified action IDs.
 */
export function ackReminders(
  ids: string[],
  remindedAt?: string
): { updated: number; reminded_at: string } {
  if (!Array.isArray(ids)) {
    throw makeSchemaError('ids must be an array of action IDs');
  }

  const cleanIds = Array.from(
    new Set(ids.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean))
  );
  const remindedAtIso =
    (remindedAt !== undefined ? normalizeUtcIso(remindedAt, 'reminded_at') : null) ??
    new Date().toISOString();

  if (cleanIds.length === 0) {
    return { updated: 0, reminded_at: remindedAtIso };
  }

  const db = getDb();
  const updated = transaction(db, () => {
    const CHUNK_SIZE = 500;
    let total = 0;
    for (let i = 0; i < cleanIds.length; i += CHUNK_SIZE) {
      const chunk = cleanIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const res = db
        .prepare(
          `UPDATE actions SET last_reminded_at = ?, updated_at = datetime('now') WHERE id IN (${placeholders})`
        )
        .run(remindedAtIso, ...chunk);
      total += res.changes;
    }
    return total;
  })();

  return { updated, reminded_at: remindedAtIso };
}
