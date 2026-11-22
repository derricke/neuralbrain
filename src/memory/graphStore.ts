import { randomUUID } from 'crypto';
import { getDb } from '../lib/db';
import { redactOptional, redactSecrets } from '../lib/redactSecrets';
import {
  buildHierarchicalScopeSql,
  classifyMatchTier,
  MatchTier,
  normalizeProjectId,
  resolveScope,
  ScopeValue,
} from '../lib/scope';
import { Database, transaction } from '../lib/sqlite';
import { enqueueForEmbedding } from './embedQueueStore';

export const STANDARD_ENTITY_TYPES = [
  'brand',
  'person',
  'asset',
  'metric',
  'document',
  'tool',
] as const;

export const STANDARD_EDGE_RELATIONS = [
  'part_of',
  'depends_on',
  'references',
  'owns',
  'produced_by',
  'blocks',
  'related_to',
] as const;

export type GraphNodeType =
  | 'note'
  | 'lesson'
  | 'concept'
  | 'file'
  | 'session'
  | 'action'
  | 'summary'
  | 'observation'
  | 'entity'
  | 'trajectory';

/**
 * Edge relation type. Includes standard structural relations
 * ('has_concept' | 'touches_file' | 'supersedes' | 'from_session' | 'cites_source'),
 * standard entity relations ('part_of' | 'depends_on' | 'references' | 'owns' | 'produced_by' | 'blocks' | 'related_to'),
 * and custom domain-agnostic relation strings.
 */
export type GraphEdgeType = string;

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  scope?: string | null;
  project_id?: string | null;
  entity_type?: string | null;
  external_ref?: string | null;
  match_tier?: MatchTier;
  user_id?: string | null;
  agent_id?: string | null;
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: GraphEdgeType;
  meta?: Record<string, unknown>;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
  };
}

export interface KnowledgeGraphOptions {
  projectId?: string;
  scope?: string;
  includeAncestors?: boolean;
  includeChildren?: boolean;
  includeGlobal?: boolean;
  depth?: number;
  nodeId?: string;
  entityType?: string;
  relation?: string;
  userId?: string;
  limit?: number;
}

export interface EntityRecord {
  id: string;
  scope: ScopeValue;
  project_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  entity_type: string;
  name: string;
  description: string | null;
  external_ref: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface UpsertEntityInput {
  id?: string;
  scope?: ScopeValue | string;
  project_id?: string | null;
  projectId?: string | null;
  user_id?: string | null;
  userId?: string | null;
  agent_id?: string | null;
  agentId?: string | null;
  entity_type?: string;
  entityType?: string;
  name: string;
  description?: string | null;
  external_ref?: string | null;
  externalRef?: string | null;
  metadata?: Record<string, unknown> | string | null;
  metadata_json?: string | null;
  metadataJson?: string | null;
}

export interface ListEntitiesFilters {
  projectId?: string;
  scope?: string;
  includeAncestors?: boolean;
  includeChildren?: boolean;
  includeGlobal?: boolean;
  entityType?: string;
  externalRef?: string;
  userId?: string;
  limit?: number;
}

export interface EntityEdgeRecord {
  id: string;
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  relation: string;
  metadata_json: string | null;
  created_at: number;
}

export interface LinkEntitiesInput {
  source_type?: string;
  sourceType?: string;
  source_id?: string;
  sourceId?: string;
  target_type?: string;
  targetType?: string;
  target_id?: string;
  targetId?: string;
  relation: string;
  metadata?: Record<string, unknown> | string | null;
  metadata_json?: string | null;
  metadataJson?: string | null;
}

export interface UnlinkEntitiesInput {
  id?: string;
  source_id?: string;
  sourceId?: string;
  target_id?: string;
  targetId?: string;
  relation?: string;
}

const ENTITY_COLUMNS =
  'id, scope, project_id, user_id, agent_id, entity_type, name, description, external_ref, metadata_json, created_at, updated_at';

const KNOWN_NODE_TABLES: Record<string, string> = {
  entity: 'entities',
  note: 'notes',
  lesson: 'notes',
  action: 'actions',
  session: 'sessions',
  summary: 'summaries',
  trajectory: 'trajectories',
  observation: 'observations',
};

const SYNTHETIC_EDGE_TYPES = new Set([
  'has_concept',
  'touches_file',
  'supersedes',
  'from_session',
  'cites_source',
]);

function makeError(code: string, message: string): Error {
  const err = new Error(message);
  (err as { code?: string }).code = code;
  return err;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw makeError('SCHEMA_INVALID', `${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function serializeMetadata(input: {
  metadata?: Record<string, unknown> | string | null;
  metadata_json?: string | null;
  metadataJson?: string | null;
}): string | null {
  const rawJson = input.metadata_json !== undefined ? input.metadata_json : input.metadataJson;
  if (rawJson !== undefined) {
    return redactOptional(optionalString(rawJson, 'metadata_json'));
  }
  if (input.metadata === undefined || input.metadata === null) {
    return null;
  }
  if (typeof input.metadata === 'string') {
    return redactOptional(optionalString(input.metadata, 'metadata'));
  }
  if (typeof input.metadata === 'object' && !Array.isArray(input.metadata)) {
    return redactSecrets(JSON.stringify(input.metadata));
  }
  throw makeError('SCHEMA_INVALID', 'metadata must be an object, JSON string, or null');
}

function tryParseJson(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw };
  }
}

function clampLimit(raw?: number, defaultLimit = 80, maxLimit = 200): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return defaultLimit;
  }
  return Math.min(Math.floor(raw), maxLimit);
}

function clampDepth(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 1;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(3, Math.max(1, Math.floor(n)));
}

function parseOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const norm = value.trim().toLowerCase();
    if (norm === 'true' || norm === '1') return true;
    if (norm === 'false' || norm === '0') return false;
  }
  return undefined;
}

/**
 * Create or update a persistent entity node with explicit Rule 4 scope,
 * secret redaction, deduplication on (scope/project_id, entity_type, lower(name)),
 * and atomic embed_queue enqueueing. Never returns the embedding BLOB.
 */
export function upsertEntity(input: UpsertEntityInput): EntityRecord {
  const scoped = resolveScope(input.scope, input.projectId ?? input.project_id);
  if (!scoped.ok) {
    throw makeError('SCHEMA_INVALID', scoped.error);
  }

  const rawEntityType = input.entity_type !== undefined ? input.entity_type : input.entityType;
  const entityType = optionalString(rawEntityType, 'entity_type');
  if (!entityType) {
    throw makeError('SCHEMA_INVALID', 'entity_type is required and cannot be empty');
  }

  const rawName = optionalString(input.name, 'name');
  if (!rawName) {
    throw makeError('SCHEMA_INVALID', 'name is required and cannot be empty');
  }
  const name = redactSecrets(rawName);

  const description = redactOptional(optionalString(input.description, 'description'));
  const rawExternalRef =
    input.external_ref !== undefined ? input.external_ref : input.externalRef;
  const externalRef = redactOptional(optionalString(rawExternalRef, 'external_ref'));
  const metadataJson = serializeMetadata(input);
  const userId = optionalString(
    input.user_id !== undefined ? input.user_id : input.userId,
    'user_id'
  );
  const agentId = optionalString(
    input.agent_id !== undefined ? input.agent_id : input.agentId,
    'agent_id'
  );
  const providedId = optionalString(input.id, 'id');

  const db = getDb();
  const dedupScopeKey = scoped.projectId ?? `__SCOPE__:${scoped.scope}`;

  return transaction(db, () => {
    let existing: EntityRecord | undefined;
    if (providedId) {
      existing = db
        .prepare(`SELECT ${ENTITY_COLUMNS} FROM entities WHERE id = ?`)
        .get(providedId) as EntityRecord | undefined;
    }
    if (!existing) {
      existing = db
        .prepare(
          `
          SELECT ${ENTITY_COLUMNS}
          FROM entities
          WHERE COALESCE(project_id, '__SCOPE__:' || scope) = ?
            AND entity_type = ?
            AND lower(name) = lower(?)
          LIMIT 1
          `
        )
        .get(dedupScopeKey, entityType, name) as EntityRecord | undefined;
    }

    let entityId: string;
    if (existing) {
      entityId = existing.id;
      db.prepare(
        `
        UPDATE entities
        SET scope = ?,
            project_id = ?,
            entity_type = ?,
            name = ?,
            description = COALESCE(?, description),
            external_ref = COALESCE(?, external_ref),
            metadata_json = COALESCE(?, metadata_json),
            user_id = COALESCE(?, user_id),
            agent_id = COALESCE(?, agent_id),
            updated_at = unixepoch()
        WHERE id = ?
        `
      ).run(
        scoped.scope,
        scoped.projectId,
        entityType,
        name,
        description,
        externalRef,
        metadataJson,
        userId,
        agentId,
        entityId
      );
    } else {
      entityId = providedId || `ent_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      db.prepare(
        `
        INSERT INTO entities (
          id, scope, project_id, user_id, agent_id, entity_type, name,
          description, external_ref, metadata_json, embedding
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `
      ).run(
        entityId,
        scoped.scope,
        scoped.projectId,
        userId,
        agentId,
        entityType,
        name,
        description,
        externalRef,
        metadataJson
      );
    }

    enqueueForEmbedding(entityId, 'entity');
    return db
      .prepare(`SELECT ${ENTITY_COLUMNS} FROM entities WHERE id = ?`)
      .get(entityId) as EntityRecord;
  })();
}

/**
 * Retrieve an entity by ID without returning its embedding BLOB.
 */
export function getEntity(id: string): EntityRecord | undefined {
  const db = getDb();
  return db
    .prepare(`SELECT ${ENTITY_COLUMNS} FROM entities WHERE id = ?`)
    .get(id) as EntityRecord | undefined;
}

/**
 * List entities with optional hierarchical project scoping, user filtering,
 * entity_type, and external_ref filters. Never filters on agent_id.
 */
export function listEntities(
  filters?: ListEntitiesFilters
): Array<EntityRecord & { match_tier?: MatchTier }> {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  const hasProjectId = typeof filters?.projectId === 'string' && filters.projectId.trim() !== '';
  const hasScope = typeof filters?.scope === 'string' && filters.scope.trim() !== '';
  let normalizedQueryProjectId: string | null = null;

  if (hasProjectId || hasScope) {
    const scopeSql = buildHierarchicalScopeSql({
      scope: hasScope ? filters!.scope : undefined,
      projectId: hasProjectId ? filters!.projectId : undefined,
      includeAncestors: filters?.includeAncestors ?? true,
      includeChildren: filters?.includeChildren ?? false,
      includeGlobal: filters?.includeGlobal ?? (hasProjectId ? true : false),
      userId: filters?.userId,
    });
    conditions.push(scopeSql.clause);
    params.push(...scopeSql.params);
    normalizedQueryProjectId = scopeSql.normalizedProjectId;
  } else {
    if (filters?.includeGlobal === false) {
      conditions.push("scope != 'global'");
    }
    if (typeof filters?.userId === 'string' && filters.userId.trim() !== '') {
      conditions.push('user_id = ?');
      params.push(filters.userId.trim());
    }
  }

  if (typeof filters?.entityType === 'string' && filters.entityType.trim() !== '') {
    conditions.push('entity_type = ?');
    params.push(filters.entityType.trim());
  }

  if (typeof filters?.externalRef === 'string' && filters.externalRef.trim() !== '') {
    conditions.push('external_ref = ?');
    params.push(filters.externalRef.trim());
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = clampLimit(filters?.limit, 50, 200);
  params.push(limit);

  const rows = db
    .prepare(
      `
      SELECT ${ENTITY_COLUMNS}
      FROM entities
      ${whereClause}
      ORDER BY updated_at DESC, created_at DESC, rowid DESC
      LIMIT ?
      `
    )
    .all(...params) as EntityRecord[];

  return rows.map((row) => ({
    ...row,
    match_tier: classifyMatchTier(row.scope, row.project_id, normalizedQueryProjectId).match_tier,
  }));
}

function resolveNodeType(db: Database, id: string): string | null {
  if (db.prepare('SELECT 1 FROM entities WHERE id = ?').get(id)) return 'entity';
  const noteRow = db.prepare('SELECT type FROM notes WHERE id = ?').get(id) as
    | { type: string }
    | undefined;
  if (noteRow) return noteRow.type === 'lesson' ? 'lesson' : 'note';
  if (db.prepare('SELECT 1 FROM actions WHERE id = ?').get(id)) return 'action';
  if (db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)) return 'session';
  if (db.prepare('SELECT 1 FROM summaries WHERE id = ?').get(id)) return 'summary';
  if (db.prepare('SELECT 1 FROM trajectories WHERE id = ?').get(id)) return 'trajectory';
  if (db.prepare('SELECT 1 FROM observations WHERE id = ?').get(id)) return 'observation';
  return null;
}

function resolveAndValidateEndpoint(
  db: Database,
  explicitType: string | null,
  id: string,
  role: 'source' | 'target'
): string {
  if (!explicitType) {
    const resolved = resolveNodeType(db, id);
    if (!resolved) {
      throw makeError('NOT_FOUND', `${role} record '${id}' not found`);
    }
    return resolved;
  }

  const knownTable = KNOWN_NODE_TABLES[explicitType];
  if (knownTable) {
    const exists = db.prepare(`SELECT 1 FROM ${knownTable} WHERE id = ?`).get(id);
    if (!exists) {
      throw makeError('NOT_FOUND', `${role} ${explicitType} '${id}' not found`);
    }
  }
  return explicitType;
}

/**
 * Create or update a directed relational edge between any two graph nodes
 * (including cross-subproject links). Auto-resolves source_type/target_type
 * when omitted and verifies internal endpoints exist.
 */
export function linkEntities(input: LinkEntitiesInput): EntityEdgeRecord {
  const sourceId = optionalString(
    input.source_id !== undefined ? input.source_id : input.sourceId,
    'source_id'
  );
  if (!sourceId) {
    throw makeError('SCHEMA_INVALID', 'source_id is required and cannot be empty');
  }

  const targetId = optionalString(
    input.target_id !== undefined ? input.target_id : input.targetId,
    'target_id'
  );
  if (!targetId) {
    throw makeError('SCHEMA_INVALID', 'target_id is required and cannot be empty');
  }

  const relation = optionalString(input.relation, 'relation');
  if (!relation) {
    throw makeError('SCHEMA_INVALID', 'relation is required and cannot be empty');
  }

  const explicitSourceType = optionalString(
    input.source_type !== undefined ? input.source_type : input.sourceType,
    'source_type'
  );
  const explicitTargetType = optionalString(
    input.target_type !== undefined ? input.target_type : input.targetType,
    'target_type'
  );
  const metadataJson = serializeMetadata(input);

  const db = getDb();
  return transaction(db, () => {
    const sourceType = resolveAndValidateEndpoint(db, explicitSourceType, sourceId, 'source');
    const targetType = resolveAndValidateEndpoint(db, explicitTargetType, targetId, 'target');
    const id = `edge_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

    db.prepare(
      `
      INSERT INTO entity_edges (
        id, source_type, source_id, target_type, target_id, relation, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_type, source_id, target_type, target_id, relation) DO UPDATE SET
        metadata_json = COALESCE(excluded.metadata_json, entity_edges.metadata_json)
      `
    ).run(id, sourceType, sourceId, targetType, targetId, relation, metadataJson);

    return db
      .prepare(
        `
        SELECT id, source_type, source_id, target_type, target_id, relation, metadata_json, created_at
        FROM entity_edges
        WHERE source_type = ? AND source_id = ? AND target_type = ? AND target_id = ? AND relation = ?
        `
      )
      .get(sourceType, sourceId, targetType, targetId, relation) as EntityEdgeRecord;
  })();
}

/**
 * Remove matching edges from entity_edges by edge id, source_id, and/or target_id
 * (optionally narrowed by relation).
 */
export function unlinkEntities(input: UnlinkEntitiesInput): { deleted: number } {
  const id = optionalString(input.id, 'id');
  const sourceId = optionalString(
    input.source_id !== undefined ? input.source_id : input.sourceId,
    'source_id'
  );
  const targetId = optionalString(
    input.target_id !== undefined ? input.target_id : input.targetId,
    'target_id'
  );
  const relation = optionalString(input.relation, 'relation');

  if (!id && !sourceId && !targetId) {
    throw makeError(
      'SCHEMA_INVALID',
      'At least one of id, source_id, or target_id is required to unlink edges'
    );
  }

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (id) {
    conditions.push('id = ?');
    params.push(id);
  }
  if (sourceId) {
    conditions.push('source_id = ?');
    params.push(sourceId);
  }
  if (targetId) {
    conditions.push('target_id = ?');
    params.push(targetId);
  }
  if (relation) {
    conditions.push('relation = ?');
    params.push(relation);
  }

  const db = getDb();
  const res = db
    .prepare(`DELETE FROM entity_edges WHERE ${conditions.join(' AND ')}`)
    .run(...params);
  return { deleted: res.changes };
}

/**
 * Parse and bound HTTP query parameters for knowledge graph endpoints.
 */
export function parseGraphQuery(query: Record<string, unknown>): KnowledgeGraphOptions {
  const rawProjectId = query.project_id ?? query.projectId;
  const projectId =
    typeof rawProjectId === 'string' && rawProjectId.trim() !== ''
      ? rawProjectId.trim()
      : undefined;
  const scope =
    typeof query.scope === 'string' && query.scope.trim() !== ''
      ? query.scope.trim()
      : undefined;

  const includeAncestors =
    parseOptionalBool(query.include_ancestors ?? query.includeAncestors) ?? true;
  const includeChildren =
    parseOptionalBool(query.include_children ?? query.includeChildren) ?? false;
  const includeGlobal =
    parseOptionalBool(query.include_global ?? query.includeGlobal) ?? false;

  const rawNodeId = query.node_id ?? query.nodeId;
  const nodeId =
    typeof rawNodeId === 'string' && rawNodeId.trim() !== '' ? rawNodeId.trim() : undefined;

  const rawEntityType = query.entity_type ?? query.entityType;
  const entityType =
    typeof rawEntityType === 'string' && rawEntityType.trim() !== ''
      ? rawEntityType.trim()
      : undefined;

  const relation =
    typeof query.relation === 'string' && query.relation.trim() !== ''
      ? query.relation.trim()
      : undefined;

  const rawUserId = query.user_id ?? query.userId;
  const userId =
    typeof rawUserId === 'string' && rawUserId.trim() !== '' ? rawUserId.trim() : undefined;

  const rawLimit = query.limit;
  const parsedLimit =
    rawLimit !== undefined && rawLimit !== null && rawLimit !== ''
      ? parseInt(String(rawLimit), 10)
      : undefined;

  return {
    projectId,
    scope,
    includeAncestors,
    includeChildren,
    includeGlobal,
    depth: clampDepth(query.depth),
    nodeId,
    entityType,
    relation,
    userId,
    limit: clampLimit(parsedLimit),
  };
}

interface NoteSeedRow {
  id: string;
  scope: string;
  project_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  type: string;
  title: string;
  version: number;
  supersedes: string | null;
  is_latest: number;
  event_at: string | null;
  valid_from: string | null;
  valid_until: string | null;
  created_at: number;
}

interface SessionSeedRow {
  id: string;
  scope: string;
  project_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  agent_name: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
}

interface ActionSeedRow {
  id: string;
  session_id: string | null;
  scope: string;
  project_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  title: string;
  status: string;
  priority: string;
  due_at: string | null;
  remind_at: string | null;
  recurrence: string | null;
  created_at: string;
}

interface SummarySeedRow {
  id: string;
  scope: string;
  project_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  kind: string;
  outcome: string | null;
  producer_tier: string;
  verified: number;
  created_at: number;
}

interface TrajectorySeedRow {
  id: string;
  scope: string;
  project_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  task_type: string | null;
  agent: string | null;
  description: string;
  success: number | null;
  rollup_source: string | null;
  created_at: number;
}

interface ObservationSeedRow {
  id: string;
  scope: string;
  project_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  kind: string;
  tool_name: string | null;
  file_path: string | null;
  failed: number;
  created_at: number;
}

function noteToGraphNode(note: NoteSeedRow, queryProjectId: string | null): GraphNode {
  return {
    id: note.id,
    type: note.type === 'lesson' ? 'lesson' : 'note',
    label: note.title,
    scope: note.scope,
    project_id: note.project_id,
    match_tier: classifyMatchTier(note.scope, note.project_id, queryProjectId).match_tier,
    user_id: note.user_id,
    agent_id: note.agent_id,
    meta: {
      noteType: note.type,
      version: note.version,
      is_latest: note.is_latest,
      event_at: note.event_at,
      valid_from: note.valid_from,
      valid_until: note.valid_until,
      created_at: note.created_at,
    },
  };
}

function sessionToGraphNode(s: SessionSeedRow, queryProjectId: string | null): GraphNode {
  return {
    id: s.id,
    type: 'session',
    label: s.agent_name ? `${s.agent_name} (${s.status})` : s.id,
    scope: s.scope,
    project_id: s.project_id,
    match_tier: classifyMatchTier(s.scope, s.project_id, queryProjectId).match_tier,
    user_id: s.user_id,
    agent_id: s.agent_id,
    meta: {
      status: s.status,
      agent_name: s.agent_name,
      started_at: s.started_at,
      ended_at: s.ended_at,
    },
  };
}

function actionToGraphNode(a: ActionSeedRow, queryProjectId: string | null): GraphNode {
  return {
    id: a.id,
    type: 'action',
    label: a.title,
    scope: a.scope,
    project_id: a.project_id,
    match_tier: classifyMatchTier(a.scope, a.project_id, queryProjectId).match_tier,
    user_id: a.user_id,
    agent_id: a.agent_id,
    meta: {
      status: a.status,
      priority: a.priority,
      due_at: a.due_at,
      remind_at: a.remind_at,
      recurrence: a.recurrence,
      created_at: a.created_at,
    },
  };
}

function summaryToGraphNode(sum: SummarySeedRow, queryProjectId: string | null): GraphNode {
  return {
    id: sum.id,
    type: 'summary',
    label: `${sum.kind} (${sum.outcome ?? 'unknown'})`,
    scope: sum.scope,
    project_id: sum.project_id,
    match_tier: classifyMatchTier(sum.scope, sum.project_id, queryProjectId).match_tier,
    user_id: sum.user_id,
    agent_id: sum.agent_id,
    meta: {
      kind: sum.kind,
      outcome: sum.outcome,
      producer_tier: sum.producer_tier,
      verified: sum.verified,
      created_at: sum.created_at,
    },
  };
}

function entityToGraphNode(ent: EntityRecord, queryProjectId: string | null): GraphNode {
  const parsedMeta = tryParseJson(ent.metadata_json);
  return {
    id: ent.id,
    type: 'entity',
    label: ent.name,
    scope: ent.scope,
    project_id: ent.project_id,
    entity_type: ent.entity_type,
    external_ref: ent.external_ref,
    match_tier: classifyMatchTier(ent.scope, ent.project_id, queryProjectId).match_tier,
    user_id: ent.user_id,
    agent_id: ent.agent_id,
    meta: {
      entity_type: ent.entity_type,
      description: ent.description,
      external_ref: ent.external_ref,
      ...(parsedMeta ? { metadata: parsedMeta } : {}),
      created_at: ent.created_at,
      updated_at: ent.updated_at,
    },
  };
}

function trajectoryToGraphNode(traj: TrajectorySeedRow, queryProjectId: string | null): GraphNode {
  const snippet = traj.description.length > 60 ? `${traj.description.slice(0, 57)}...` : traj.description;
  return {
    id: traj.id,
    type: 'trajectory',
    label: traj.task_type ? `${traj.task_type}: ${snippet}` : snippet,
    scope: traj.scope,
    project_id: traj.project_id,
    match_tier: classifyMatchTier(traj.scope, traj.project_id, queryProjectId).match_tier,
    user_id: traj.user_id,
    agent_id: traj.agent_id,
    meta: {
      task_type: traj.task_type,
      agent: traj.agent,
      success: traj.success,
      rollup_source: traj.rollup_source,
      created_at: traj.created_at,
    },
  };
}

function observationToGraphNode(obs: ObservationSeedRow, queryProjectId: string | null): GraphNode {
  return {
    id: obs.id,
    type: 'observation',
    label: obs.tool_name ? `${obs.kind}: ${obs.tool_name}` : obs.kind,
    scope: obs.scope,
    project_id: obs.project_id,
    match_tier: classifyMatchTier(obs.scope, obs.project_id, queryProjectId).match_tier,
    user_id: obs.user_id,
    agent_id: obs.agent_id,
    meta: {
      kind: obs.kind,
      tool_name: obs.tool_name,
      file_path: obs.file_path,
      failed: obs.failed,
      created_at: obs.created_at,
    },
  };
}

function userAllowed(rowUserId: string | null | undefined, filterUserId?: string): boolean {
  if (!filterUserId) return true;
  return rowUserId === null || rowUserId === undefined || rowUserId === filterUserId;
}

interface HydratedCollection {
  nodes: GraphNode[];
  notes: NoteSeedRow[];
  actions: ActionSeedRow[];
  summaries: SummarySeedRow[];
}

function hydrateNodesByIds(
  db: Database,
  targets: Array<{ id: string; typeHint?: string }>,
  queryProjectId: string | null,
  filterUserId?: string
): HydratedCollection {
  const nodes: GraphNode[] = [];
  const notes: NoteSeedRow[] = [];
  const actions: ActionSeedRow[] = [];
  const summaries: SummarySeedRow[] = [];
  if (targets.length === 0) return { nodes, notes, actions, summaries };

  const grouped = new Map<string, string[]>();
  const untypedIds: string[] = [];

  for (const t of targets) {
    if (!t.typeHint) {
      untypedIds.push(t.id);
      continue;
    }
    const bucket = t.typeHint === 'lesson' ? 'note' : t.typeHint;
    const list = grouped.get(bucket) ?? [];
    list.push(t.id);
    grouped.set(bucket, list);
  }

  for (const uid of untypedIds) {
    const resolved = resolveNodeType(db, uid);
    if (resolved) {
      const bucket = resolved === 'lesson' ? 'note' : resolved;
      const list = grouped.get(bucket) ?? [];
      list.push(uid);
      grouped.set(bucket, list);
    } else if (uid.startsWith('concept:')) {
      nodes.push({ id: uid, type: 'concept', label: uid.slice('concept:'.length) });
    } else if (uid.startsWith('file:')) {
      nodes.push({ id: uid, type: 'file', label: uid.slice('file:'.length) });
    } else {
      const edgeHint = db
        .prepare(
          `
          SELECT source_type AS ext_type FROM entity_edges WHERE source_id = ?
          UNION ALL
          SELECT target_type AS ext_type FROM entity_edges WHERE target_id = ?
          LIMIT 1
          `
        )
        .get(uid, uid) as { ext_type: string } | undefined;
      if (edgeHint && !KNOWN_NODE_TABLES[edgeHint.ext_type]) {
        nodes.push({
          id: uid,
          type: 'entity',
          label: uid,
          entity_type: edgeHint.ext_type,
          meta: { external_type: edgeHint.ext_type },
        });
      }
    }
  }

  const chunkedQuery = <T>(
    ids: string[],
    sqlBuilder: (placeholders: string) => string
  ): T[] => {
    const results: T[] = [];
    const CHUNK = 400;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      results.push(...(db.prepare(sqlBuilder(placeholders)).all(...slice) as T[]));
    }
    return results;
  };

  const entityIds = grouped.get('entity');
  if (entityIds?.length) {
    const rows = chunkedQuery<EntityRecord>(
      entityIds,
      (ph) => `SELECT ${ENTITY_COLUMNS} FROM entities WHERE id IN (${ph})`
    );
    for (const row of rows) {
      if (!userAllowed(row.user_id, filterUserId)) continue;
      nodes.push(entityToGraphNode(row, queryProjectId));
    }
  }

  const noteIds = grouped.get('note');
  if (noteIds?.length) {
    const rows = chunkedQuery<NoteSeedRow>(
      noteIds,
      (ph) =>
        `SELECT id, scope, project_id, user_id, agent_id, session_id, type, title, version, supersedes, is_latest, event_at, valid_from, valid_until, created_at FROM notes WHERE id IN (${ph})`
    );
    for (const row of rows) {
      if (!userAllowed(row.user_id, filterUserId)) continue;
      notes.push(row);
      nodes.push(noteToGraphNode(row, queryProjectId));
    }
  }

  const actionIds = grouped.get('action');
  if (actionIds?.length) {
    const rows = chunkedQuery<ActionSeedRow>(
      actionIds,
      (ph) =>
        `SELECT id, session_id, scope, project_id, user_id, agent_id, title, status, priority, due_at, remind_at, recurrence, created_at FROM actions WHERE id IN (${ph})`
    );
    for (const row of rows) {
      if (!userAllowed(row.user_id, filterUserId)) continue;
      actions.push(row);
      nodes.push(actionToGraphNode(row, queryProjectId));
    }
  }

  const sessionIds = grouped.get('session');
  if (sessionIds?.length) {
    const rows = chunkedQuery<SessionSeedRow>(
      sessionIds,
      (ph) =>
        `SELECT id, scope, project_id, user_id, agent_id, agent_name, status, started_at, ended_at FROM sessions WHERE id IN (${ph})`
    );
    for (const row of rows) {
      if (!userAllowed(row.user_id, filterUserId)) continue;
      nodes.push(sessionToGraphNode(row, queryProjectId));
    }
  }

  const summaryIds = grouped.get('summary');
  if (summaryIds?.length) {
    const rows = chunkedQuery<SummarySeedRow>(
      summaryIds,
      (ph) =>
        `SELECT id, scope, project_id, user_id, agent_id, kind, outcome, producer_tier, verified, created_at FROM summaries WHERE id IN (${ph})`
    );
    for (const row of rows) {
      if (!userAllowed(row.user_id, filterUserId)) continue;
      summaries.push(row);
      nodes.push(summaryToGraphNode(row, queryProjectId));
    }
  }

  const trajectoryIds = grouped.get('trajectory');
  if (trajectoryIds?.length) {
    const rows = chunkedQuery<TrajectorySeedRow>(
      trajectoryIds,
      (ph) =>
        `SELECT id, scope, project_id, user_id, agent_id, session_id, task_type, agent, description, success, rollup_source, created_at FROM trajectories WHERE id IN (${ph})`
    );
    for (const row of rows) {
      if (!userAllowed(row.user_id, filterUserId)) continue;
      nodes.push(trajectoryToGraphNode(row, queryProjectId));
    }
  }

  const observationIds = grouped.get('observation');
  if (observationIds?.length) {
    const rows = chunkedQuery<ObservationSeedRow>(
      observationIds,
      (ph) =>
        `SELECT id, scope, project_id, user_id, agent_id, session_id, kind, tool_name, file_path, failed, created_at FROM observations WHERE id IN (${ph})`
    );
    for (const row of rows) {
      if (!userAllowed(row.user_id, filterUserId)) continue;
      nodes.push(observationToGraphNode(row, queryProjectId));
    }
  }

  for (const [typeHint, ids] of grouped.entries()) {
    if (KNOWN_NODE_TABLES[typeHint]) continue;
    for (const id of ids) {
      if (typeHint === 'concept') {
        nodes.push({ id, type: 'concept', label: id.replace(/^concept:/, '') });
      } else if (typeHint === 'file') {
        nodes.push({ id, type: 'file', label: id.replace(/^file:/, '') });
      } else {
        nodes.push({
          id,
          type: 'entity',
          label: id,
          entity_type: typeHint,
          meta: { external_type: typeHint },
        });
      }
    }
  }

  return { nodes, notes, actions, summaries };
}

/**
 * Build a scoped knowledge graph from notes, concepts, files, sessions,
 * actions, summaries, entities, trajectories, observations, and entity_edges
 * stored in SQLite, with hierarchical scoping and 1..3 hop cross-subproject BFS.
 */
export function getKnowledgeGraph(options: KnowledgeGraphOptions = {}): KnowledgeGraph {
  const db = getDb();
  const limit = clampLimit(options.limit);
  const depth = clampDepth(options.depth);
  const projectId =
    typeof options.projectId === 'string' && options.projectId.trim() !== ''
      ? options.projectId.trim()
      : undefined;
  const scope =
    typeof options.scope === 'string' && options.scope.trim() !== ''
      ? options.scope.trim()
      : undefined;
  const includeAncestors = options.includeAncestors ?? true;
  const includeChildren = options.includeChildren ?? false;
  const includeGlobal = options.includeGlobal ?? false;
  const nodeId =
    typeof options.nodeId === 'string' && options.nodeId.trim() !== ''
      ? options.nodeId.trim()
      : undefined;
  const entityType =
    typeof options.entityType === 'string' && options.entityType.trim() !== ''
      ? options.entityType.trim()
      : undefined;
  const relationFilter =
    typeof options.relation === 'string' && options.relation.trim() !== ''
      ? options.relation.trim()
      : undefined;
  const userId =
    typeof options.userId === 'string' && options.userId.trim() !== ''
      ? options.userId.trim()
      : undefined;

  let normalizedProjectId: string | null = null;
  if (projectId) {
    const norm = normalizeProjectId(projectId);
    normalizedProjectId = norm.ok ? norm.projectId : projectId;
  }

  let where = '';
  let params: unknown[] = [];

  if (projectId !== undefined || scope !== undefined) {
    const scopeSql = buildHierarchicalScopeSql({
      scope,
      projectId,
      includeAncestors,
      includeChildren,
      includeGlobal,
      userId,
    });
    where = `WHERE ${scopeSql.clause}`;
    params = scopeSql.params;
    normalizedProjectId = scopeSql.normalizedProjectId;
  } else if (userId !== undefined) {
    where = 'WHERE user_id = ?';
    params = [userId];
  }

  const nodeMap = new Map<string, GraphNode>();
  const edgeKeys = new Set<string>();
  const edges: GraphEdge[] = [];
  const maxNodes = limit * 6;
  const maxEdges = limit * 10;

  const addNode = (node: GraphNode): boolean => {
    if (nodeMap.has(node.id)) return true;
    if (nodeMap.size >= maxNodes) return false;
    nodeMap.set(node.id, node);
    return true;
  };

  const addEdge = (
    source: string,
    target: string,
    type: GraphEdgeType,
    meta?: Record<string, unknown>
  ): boolean => {
    if (edges.length >= maxEdges) return false;
    if (!nodeMap.has(source) || !nodeMap.has(target)) return false;
    const key = `${source}\0${type}\0${target}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push(meta ? { source, target, type, meta } : { source, target, type });
    }
    return true;
  };

  let seedNoteRows: NoteSeedRow[] = [];
  let seedActionRows: ActionSeedRow[] = [];
  let seedSummaryRows: SummarySeedRow[] = [];
  const allNoteRows = new Map<string, NoteSeedRow>();
  const allActionRows = new Map<string, ActionSeedRow>();
  const allSummaryRows = new Map<string, SummarySeedRow>();

  if (nodeId) {
    const hydratedSeed = hydrateNodesByIds(
      db,
      [{ id: nodeId }],
      normalizedProjectId,
      userId
    );
    for (const node of hydratedSeed.nodes) {
      addNode(node);
    }
    seedNoteRows = hydratedSeed.notes;
    seedActionRows = hydratedSeed.actions;
    seedSummaryRows = hydratedSeed.summaries;
    for (const n of hydratedSeed.notes) allNoteRows.set(n.id, n);
    for (const a of hydratedSeed.actions) allActionRows.set(a.id, a);
    for (const s of hydratedSeed.summaries) allSummaryRows.set(s.id, s);
  } else {
    seedNoteRows = db
      .prepare(
        `
        SELECT id, scope, project_id, user_id, agent_id, session_id, type, title,
               version, supersedes, is_latest, event_at, valid_from, valid_until, created_at
        FROM notes
        ${where}
        ORDER BY updated_at DESC
        LIMIT ?
        `
      )
      .all(...params, limit) as NoteSeedRow[];

    for (const note of seedNoteRows) {
      allNoteRows.set(note.id, note);
      addNode(noteToGraphNode(note, normalizedProjectId));
    }

    const sessionRows = db
      .prepare(
        `
        SELECT id, scope, project_id, user_id, agent_id, agent_name, status, started_at, ended_at
        FROM sessions
        ${where}
        ORDER BY started_at DESC
        LIMIT ?
        `
      )
      .all(...params, limit) as SessionSeedRow[];

    for (const s of sessionRows) {
      addNode(sessionToGraphNode(s, normalizedProjectId));
    }

    seedActionRows = db
      .prepare(
        `
        SELECT id, session_id, scope, project_id, user_id, agent_id, title, status,
               priority, due_at, remind_at, recurrence, created_at
        FROM actions
        ${where}
        ORDER BY created_at DESC
        LIMIT ?
        `
      )
      .all(...params, limit) as ActionSeedRow[];

    for (const a of seedActionRows) {
      allActionRows.set(a.id, a);
      addNode(actionToGraphNode(a, normalizedProjectId));
    }

    seedSummaryRows = db
      .prepare(
        `
        SELECT id, scope, project_id, user_id, agent_id, kind, outcome, producer_tier, verified, created_at
        FROM summaries
        ${where}
        ORDER BY created_at DESC
        LIMIT ?
        `
      )
      .all(...params, limit) as SummarySeedRow[];

    for (const sum of seedSummaryRows) {
      allSummaryRows.set(sum.id, sum);
      addNode(summaryToGraphNode(sum, normalizedProjectId));
    }

    const entityConditions: string[] = [];
    const entityParams: unknown[] = [...params];
    if (where) {
      entityConditions.push(where.replace(/^WHERE\s+/i, ''));
    }
    if (entityType) {
      entityConditions.push('entity_type = ?');
      entityParams.push(entityType);
    }
    const entityWhere =
      entityConditions.length > 0 ? `WHERE ${entityConditions.join(' AND ')}` : '';

    const entityRows = db
      .prepare(
        `
        SELECT ${ENTITY_COLUMNS}
        FROM entities
        ${entityWhere}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?
        `
      )
      .all(...entityParams, limit) as EntityRecord[];

    for (const ent of entityRows) {
      addNode(entityToGraphNode(ent, normalizedProjectId));
    }
  }

  // Multi-hop BFS traversal over entity_edges (1..depth hops across any subproject)
  let frontier = Array.from(nodeMap.keys());
  const visited = new Set<string>(frontier);

  for (let hop = 1; hop <= depth; hop++) {
    if (frontier.length === 0 || nodeMap.size >= maxNodes || edges.length >= maxEdges) {
      break;
    }

    const hopEdges: EntityEdgeRecord[] = [];
    const seenEdgeIds = new Set<string>();
    const CHUNK = 400;

    for (let i = 0; i < frontier.length; i += CHUNK) {
      const slice = frontier.slice(i, i + CHUNK);
      const placeholders = slice.map(() => '?').join(',');
      const edgeSql = relationFilter
        ? `
          SELECT id, source_type, source_id, target_type, target_id, relation, metadata_json, created_at
          FROM entity_edges
          WHERE (source_id IN (${placeholders}) OR target_id IN (${placeholders}))
            AND relation = ?
          ORDER BY created_at DESC, id ASC
        `
        : `
          SELECT id, source_type, source_id, target_type, target_id, relation, metadata_json, created_at
          FROM entity_edges
          WHERE (source_id IN (${placeholders}) OR target_id IN (${placeholders}))
          ORDER BY created_at DESC, id ASC
        `;
      const edgeParams = relationFilter
        ? [...slice, ...slice, relationFilter]
        : [...slice, ...slice];
      const rows = db.prepare(edgeSql).all(...edgeParams) as EntityEdgeRecord[];
      for (const row of rows) {
        if (!seenEdgeIds.has(row.id)) {
          seenEdgeIds.add(row.id);
          hopEdges.push(row);
        }
      }
    }

    const toHydrate: Array<{ id: string; typeHint: string }> = [];
    const queuedForHydration = new Set<string>();

    for (const edge of hopEdges) {
      if (!nodeMap.has(edge.source_id) && !visited.has(edge.source_id) && !queuedForHydration.has(edge.source_id)) {
        queuedForHydration.add(edge.source_id);
        visited.add(edge.source_id);
        toHydrate.push({ id: edge.source_id, typeHint: edge.source_type });
      }
      if (!nodeMap.has(edge.target_id) && !visited.has(edge.target_id) && !queuedForHydration.has(edge.target_id)) {
        queuedForHydration.add(edge.target_id);
        visited.add(edge.target_id);
        toHydrate.push({ id: edge.target_id, typeHint: edge.target_type });
      }
    }

    const nextFrontier: string[] = [];
    if (toHydrate.length > 0 && nodeMap.size < maxNodes) {
      const hydrated = hydrateNodesByIds(db, toHydrate, normalizedProjectId, userId);
      for (const node of hydrated.nodes) {
        if (!nodeMap.has(node.id) && addNode(node)) {
          nextFrontier.push(node.id);
        }
      }
      for (const n of hydrated.notes) allNoteRows.set(n.id, n);
      for (const a of hydrated.actions) allActionRows.set(a.id, a);
      for (const s of hydrated.summaries) allSummaryRows.set(s.id, s);
    }

    for (const edge of hopEdges) {
      addEdge(
        edge.source_id,
        edge.target_id,
        edge.relation,
        tryParseJson(edge.metadata_json)
      );
    }

    frontier = nextFrontier;
  }

  // Synthesized structural edges (preserve exact { source, target, type } shape)
  const allowEdgeType = (edgeType: string): boolean =>
    !relationFilter || relationFilter === edgeType;

  if (seedNoteRows.length > 0 && (!relationFilter || SYNTHETIC_EDGE_TYPES.has(relationFilter))) {
    const seedNoteIds = seedNoteRows.map((n) => n.id);
    const placeholders = seedNoteIds.map(() => '?').join(',');

    if (allowEdgeType('has_concept')) {
      const conceptRows = db
        .prepare(`SELECT note_id, concept FROM note_concepts WHERE note_id IN (${placeholders}) LIMIT ?`)
        .all(...seedNoteIds, maxNodes) as Array<{ note_id: string; concept: string }>;

      for (const row of conceptRows) {
        const conceptId = `concept:${row.concept}`;
        if (addNode({ id: conceptId, type: 'concept', label: row.concept })) {
          addEdge(row.note_id, conceptId, 'has_concept');
        }
      }
    }

    if (allowEdgeType('touches_file')) {
      const fileRows = db
        .prepare(`SELECT note_id, file_path FROM note_files WHERE note_id IN (${placeholders}) LIMIT ?`)
        .all(...seedNoteIds, maxNodes) as Array<{ note_id: string; file_path: string }>;

      for (const row of fileRows) {
        const fileId = `file:${row.file_path}`;
        if (addNode({ id: fileId, type: 'file', label: row.file_path })) {
          addEdge(row.note_id, fileId, 'touches_file');
        }
      }
    }
  }

  for (const note of allNoteRows.values()) {
    if (note.supersedes && allowEdgeType('supersedes')) {
      addEdge(note.id, note.supersedes, 'supersedes');
    }
    if (note.session_id && allowEdgeType('from_session')) {
      addEdge(note.id, note.session_id, 'from_session');
    }
  }

  for (const action of allActionRows.values()) {
    if (action.session_id && allowEdgeType('from_session')) {
      addEdge(action.id, action.session_id, 'from_session');
    }
  }

  if (allSummaryRows.size > 0 && allowEdgeType('cites_source')) {
    const summaryIds = Array.from(allSummaryRows.keys());
    const placeholders = summaryIds.map(() => '?').join(',');
    const sourceRows = db
      .prepare(
        `SELECT DISTINCT summary_id, record_id, record_type FROM summary_sources WHERE summary_id IN (${placeholders}) LIMIT ?`
      )
      .all(...summaryIds, maxNodes) as Array<{
      summary_id: string;
      record_id: string;
      record_type: string;
    }>;

    // Load cited observation nodes from seed summaries within the remaining node budget
    const seedSummaryIdSet = new Set(seedSummaryRows.map((s) => s.id));
    const remainingBudget = maxNodes - nodeMap.size;
    if (remainingBudget > 0 && seedSummaryIdSet.size > 0) {
      const citedObsIds = Array.from(
        new Set(
          sourceRows
            .filter(
              (r) =>
                seedSummaryIdSet.has(r.summary_id) &&
                r.record_type === 'observation' &&
                !nodeMap.has(r.record_id)
            )
            .map((r) => r.record_id)
        )
      ).slice(0, remainingBudget);

      if (citedObsIds.length > 0) {
        const obsPlaceholders = citedObsIds.map(() => '?').join(',');
        const obsRows = db
          .prepare(
            `SELECT id, scope, project_id, user_id, agent_id, session_id, kind, tool_name, file_path, failed, created_at FROM observations WHERE id IN (${obsPlaceholders}) LIMIT ?`
          )
          .all(...citedObsIds, remainingBudget) as ObservationSeedRow[];

        for (const obs of obsRows) {
          if (!userAllowed(obs.user_id, userId)) continue;
          addNode(observationToGraphNode(obs, normalizedProjectId));
        }
      }
    }

    for (const row of sourceRows) {
      addEdge(row.summary_id, row.record_id, 'cites_source');
    }
  }

  const nodes = Array.from(nodeMap.values());
  return {
    nodes,
    edges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
    },
  };
}
