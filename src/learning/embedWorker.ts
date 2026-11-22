import { QdrantClient } from '@qdrant/js-client-rest';
import crypto from 'crypto';
import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { getProjectAncestors } from '../lib/scope';
import {
  claimEmbedQueue,
  clearEmbedQueueTarget,
  enqueueForEmbedding,
  getPendingEmbedCount,
  markEmbedDone,
  markEmbedFailed,
  recoverStaleRunningEmbeds,
  releaseEmbedClaim,
  type EmbedRecordType,
} from '../memory/embedQueueStore';
import {
  EmbeddingConfigurationError,
  buildTrajectoryEmbeddingText,
  embedDocument,
  resolveEmbedderRecipe,
  serializeEmbedding,
} from './embedding';
import { commitStoreMeta, getStoreMeta, verifyOrCreateStoreMeta } from './storeMeta';
import { transaction } from '../lib/sqlite';

export interface DrainOptions {
  target?: string;
  batchSize?: number;
  maxBatches?: number;
  client?: QdrantClient;
  skipSqliteBlobUpdate?: boolean;
  onVectorsComputed?: (vectors: Array<{ id: string; record_type: EmbedRecordType; blob: Buffer }>) => void;
}

export interface ReembedStatus {
  status: 'idle' | 'running' | 'completed' | 'failed';
  collection: string | null;
  total: number;
  processed: number;
  failed: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
}

let activeReembedStatus: ReembedStatus = {
  status: 'idle',
  collection: null,
  total: 0,
  processed: 0,
  failed: 0,
  started_at: null,
  completed_at: null,
  error: null,
};

export function getReembedStatus(): ReembedStatus {
  return { ...activeReembedStatus };
}

/** How long a status probe waits for Qdrant before reporting it offline. */
export const QDRANT_PROBE_TIMEOUT_MS = 2000;

/**
 * Status-only check: is Qdrant answering? Used by /health and the dashboard.
 *
 * It uses its own client with a short request timeout. The shared client keeps
 * the library default (300 s), which is right for real work but made /health
 * hang for ~10 s whenever Qdrant was unreachable without refusing the
 * connection (e.g. a docker-mode Qdrant whose port is not published). A health
 * check that hangs is worse than one that says "offline".
 */
export async function probeQdrant(timeoutMs: number = QDRANT_PROBE_TIMEOUT_MS): Promise<'ok' | 'offline'> {
  const url = process.env.QDRANT_URL || 'http://localhost:6333';
  const apiKey = process.env.QDRANT_API_KEY?.trim() || undefined;
  try {
    const client = new QdrantClient({ url, apiKey, checkCompatibility: false, timeout: timeoutMs });
    const collections = await client.getCollections();
    return collections ? 'ok' : 'offline';
  } catch {
    return 'offline';
  }
}

export function getQdrantClient(): QdrantClient | null {
  const url = process.env.QDRANT_URL || 'http://localhost:6333';
  const apiKey = process.env.QDRANT_API_KEY?.trim() || undefined;
  try {
    return new QdrantClient({ url, apiKey, checkCompatibility: false });
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'failed to construct QdrantClient');
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Qdrant only accepts unsigned integers or UUIDs as point IDs.
 * Map non-UUID record IDs (e.g. note_*, obs_*, sum_*) deterministically to a UUID
 * while storing the original record_id in the point payload.
 */
export function toQdrantPointId(recordId: string): string {
  if (UUID_RE.test(recordId)) return recordId;
  const hex = crypto.createHash('sha256').update(recordId).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Safely delete points from Qdrant by id.
 * Never throws — logs warnings on error or skips if Qdrant is unreachable / embedder tier is none.
 */
export async function deleteQdrantPoints(
  ids: string[],
  client?: QdrantClient | null
): Promise<void> {
  if (!ids || ids.length === 0) return;
  try {
    const recipe = resolveEmbedderRecipe();
    if (recipe.embed_tier === 'none') return;

    const qdrant = client !== undefined ? client : getQdrantClient();
    if (!qdrant) return;

    const collection = getStoreMeta()?.qdrant_alias || 'brain';
    await qdrant.delete(collection, {
      points: ids.map(toQdrantPointId),
    });
    logger.debug({ count: ids.length, collection }, 'deleted points from qdrant');
  } catch (err) {
    logger.warn(
      {
        count: ids.length,
        error: err instanceof Error ? err.message : String(err),
      },
      'failed to delete points from qdrant (ignored to preserve sqlite source of truth)'
    );
  }
}

const EMBEDDING_TABLE_BY_TYPE: Partial<Record<EmbedRecordType, string>> = {
  trajectory: 'trajectories',
  note: 'notes',
  summary: 'summaries',
  entity: 'entities',
  action: 'actions',
};

function toUnixSeconds(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed) {
      const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
        ? `${trimmed.replace(' ', 'T')}Z`
        : trimmed;
      const ms = Date.parse(iso);
      if (Number.isFinite(ms)) {
        return Math.floor(ms / 1000);
      }
    }
  }
  return Math.floor(Date.now() / 1000);
}

let isDrainRunning = false;

export async function drainEmbedQueue(
  options?: DrainOptions
): Promise<{ processed: number; failed: number; remaining: number }> {
  const target = options?.target || 'live';

  // Yield/skip non-reembed drains (e.g. 'live') while a full re-embed is running
  // so they don't compete for the embedder or Qdrant with startReembed().
  if (
    activeReembedStatus.status === 'running' &&
    target !== activeReembedStatus.collection
  ) {
    return { processed: 0, failed: 0, remaining: 0 };
  }

  if (isDrainRunning) {
    return { processed: 0, failed: 0, remaining: 0 };
  }

  isDrainRunning = true;
  try {
    const batchSize = options?.batchSize || 32;
    const maxBatches = options?.maxBatches || 1;
    const qdrant = options?.client ?? getQdrantClient();
    const qdrantConfigured = Boolean(options?.client || process.env.QDRANT_URL?.trim());
    const skipSqliteBlobUpdate = options?.skipSqliteBlobUpdate ?? target !== 'live';

    recoverStaleRunningEmbeds(target);

    const recipe = resolveEmbedderRecipe();
    const db = getDb();

    let totalProcessed = 0;
    let totalFailed = 0;

  let embedderUnavailable = false;
  for (let batchIdx = 0; batchIdx < maxBatches; batchIdx++) {
    if (embedderUnavailable) break;
    const items = claimEmbedQueue(target, batchSize);
    if (items.length === 0) {
      break;
    }

    const qdrantPointsToUpsert: Array<{ id: string; vector: number[]; payload: Record<string, any> }> = [];
    const pendingQdrantDone: Array<{ record_id: string; record_type: EmbedRecordType }> = [];
    const computedBlobs: Array<{ id: string; record_type: EmbedRecordType; blob: Buffer }> = [];

    for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
      const item = items[itemIdx];
      try {
        let text = '';
        let payload: Record<string, any> = {};

        switch (item.record_type) {
          case 'observation': {
            const obs = db
              .prepare('SELECT * FROM observations WHERE id = ?')
              .get(item.record_id) as any;
            if (!obs) {
              markEmbedDone(item.record_id, item.record_type, target);
              totalProcessed++;
              continue;
            }
            text = [
              obs.kind === 'prompt' ? 'prompt: ' : obs.kind === 'response' ? 'response: ' : 'tool: ',
              obs.tool_name || '',
              obs.file_path ? ` file: ${obs.file_path}` : '',
              obs.input ? `\ninput: ${obs.input}` : '',
              obs.output ? `\noutput: ${obs.output}` : '',
            ].join('');
            payload = {
              record_type: 'observation',
              scope: obs.scope,
              project_id: obs.project_id,
              project_ancestors: obs.project_id ? getProjectAncestors(obs.project_id) : [],
              user_id: obs.user_id ?? null,
              kind: obs.kind,
              type: null,
              task_type: null,
              note_ref: obs.note_ref,
              task_ref: obs.task_ref,
              file_path: obs.file_path,
              agent: obs.agent,
              success: obs.failed === 0,
              created_at: obs.created_at,
              text,
            };
            break;
          }
          case 'trajectory': {
            const traj = db
              .prepare('SELECT * FROM trajectories WHERE id = ?')
              .get(item.record_id) as any;
            if (!traj) {
              markEmbedDone(item.record_id, item.record_type, target);
              totalProcessed++;
              continue;
            }
            text = buildTrajectoryEmbeddingText({
              description: traj.description,
              result: traj.result,
              provider: traj.agent,
              model: traj.agent,
              // NULL means the outcome is unknown; it is not a failure.
              success: traj.success === null || traj.success === undefined ? null : traj.success === 1,
            });
            payload = {
              record_type: 'trajectory',
              scope: traj.scope,
              project_id: traj.project_id,
              project_ancestors: traj.project_id ? getProjectAncestors(traj.project_id) : [],
              user_id: traj.user_id ?? null,
              kind: null,
              type: null,
              task_type: traj.task_type,
              note_ref: traj.note_ref,
              task_ref: traj.task_ref,
              file_path: null,
              agent: traj.agent,
              success: traj.success === null || traj.success === undefined ? null : traj.success === 1,
              created_at: traj.created_at,
              text,
            };
            break;
          }
          case 'note': {
            const note = db
              .prepare('SELECT * FROM notes WHERE id = ?')
              .get(item.record_id) as any;
            if (!note) {
              markEmbedDone(item.record_id, item.record_type, target);
              totalProcessed++;
              continue;
            }
            text = `${note.title}\n\n${note.content}`;
            payload = {
              record_type: 'note',
              scope: note.scope,
              project_id: note.project_id,
              project_ancestors: note.project_id ? getProjectAncestors(note.project_id) : [],
              user_id: note.user_id ?? null,
              kind: null,
              type: note.type,
              task_type: null,
              note_ref: null,
              task_ref: null,
              file_path: null,
              agent: note.author,
              success: null,
              created_at: note.created_at,
              text,
            };
            break;
          }
          case 'summary': {
            const summary = db
              .prepare('SELECT * FROM summaries WHERE id = ?')
              .get(item.record_id) as any;
            if (!summary) {
              markEmbedDone(item.record_id, item.record_type, target);
              totalProcessed++;
              continue;
            }
            const claims = db
              .prepare('SELECT text FROM summary_claims WHERE summary_id = ? ORDER BY ordinal ASC')
              .all(item.record_id) as Array<{ text: string }>;
            text = claims.map((c) => c.text).join('\n');
            payload = {
              record_type: 'summary',
              scope: summary.scope,
              project_id: summary.project_id,
              project_ancestors: summary.project_id ? getProjectAncestors(summary.project_id) : [],
              user_id: summary.user_id ?? null,
              kind: summary.kind,
              type: null,
              task_type: null,
              note_ref: null,
              task_ref: null,
              file_path: null,
              agent: summary.producer_model || summary.producer_tier,
              success: summary.outcome === 'success',
              created_at: summary.created_at,
              text,
            };
            break;
          }
          case 'entity': {
            const entity = db
              .prepare('SELECT * FROM entities WHERE id = ?')
              .get(item.record_id) as any;
            if (!entity) {
              markEmbedDone(item.record_id, item.record_type, target);
              totalProcessed++;
              continue;
            }
            text = [entity.entity_type, entity.name, entity.description, entity.external_ref]
              .filter(Boolean)
              .join('\n');
            payload = {
              record_type: 'entity',
              scope: entity.scope,
              project_id: entity.project_id,
              project_ancestors: entity.project_id ? getProjectAncestors(entity.project_id) : [],
              user_id: entity.user_id ?? null,
              entity_type: entity.entity_type,
              kind: null,
              type: null,
              task_type: null,
              note_ref: null,
              task_ref: null,
              file_path: null,
              agent: null,
              success: null,
              created_at: entity.created_at,
              text,
            };
            break;
          }
          case 'action': {
            const action = db
              .prepare('SELECT * FROM actions WHERE id = ?')
              .get(item.record_id) as any;
            if (!action) {
              markEmbedDone(item.record_id, item.record_type, target);
              totalProcessed++;
              continue;
            }
            text = [action.title, action.description, action.blocked_reason]
              .filter(Boolean)
              .join('\n');
            payload = {
              record_type: 'action',
              scope: action.scope,
              project_id: action.project_id,
              project_ancestors: action.project_id ? getProjectAncestors(action.project_id) : [],
              user_id: action.user_id ?? null,
              kind: action.status,
              type: action.priority,
              task_type: null,
              note_ref: null,
              task_ref: null,
              file_path: null,
              agent: null,
              success: null,
              created_at: toUnixSeconds(action.created_at),
              text,
            };
            break;
          }
        }

        let queuedForQdrant = false;
        if (recipe.embed_tier !== 'none') {
          const vector = await embedDocument(text);
          const blob = serializeEmbedding(vector);

          const blobTable = EMBEDDING_TABLE_BY_TYPE[item.record_type];
          if (blobTable) {
            if (!skipSqliteBlobUpdate) {
              db.prepare(`UPDATE ${blobTable} SET embedding = ? WHERE id = ?`).run(
                blob,
                item.record_id
              );
            } else if (options?.onVectorsComputed) {
              computedBlobs.push({ id: item.record_id, record_type: item.record_type, blob });
            }
          }

          if (qdrant && vector.length > 0) {
            qdrantPointsToUpsert.push({
              id: toQdrantPointId(item.record_id),
              vector,
              payload: { ...payload, record_id: item.record_id },
            });
            pendingQdrantDone.push({ record_id: item.record_id, record_type: item.record_type });
            queuedForQdrant = true;
          }
        }

        if (!queuedForQdrant) {
          markEmbedDone(item.record_id, item.record_type, target);
          totalProcessed++;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (err instanceof EmbeddingConfigurationError) {
          // The embedder itself is unavailable (e.g. the optional local embedder
          // is not installed). No record is at fault: put this item and the rest
          // of the batch back to pending and stop until it is fixed.
          for (const pending of items.slice(itemIdx)) {
            releaseEmbedClaim(pending.record_id, pending.record_type, target, errorMsg);
          }
          logger.error({ target, error: errorMsg }, 'embedder unavailable; queue left pending');
          embedderUnavailable = true;
          break;
        }
        logger.error(
          {
            recordId: item.record_id,
            record_type: item.record_type,
            target,
            error: errorMsg,
          },
          'error embedding record'
        );
        markEmbedFailed(item.record_id, item.record_type, target, errorMsg);
        totalFailed++;
      }

      // Yield to the event loop between embeddings so HTTP health/dashboard requests stay responsive
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // [CR-09] Bulk upsert all computed points for this batch to Qdrant in a single roundtrip
    if (qdrant && qdrantPointsToUpsert.length > 0) {
      const targetCollection =
        target === 'live' ? getStoreMeta()?.qdrant_alias || 'brain' : target;
      let upsertSucceeded = false;
      let upsertErrMsg = '';
      try {
        await qdrant.upsert(targetCollection, {
          points: qdrantPointsToUpsert,
        });
        upsertSucceeded = true;
      } catch (qdrantErr: any) {
        // If collection was not created yet (e.g. freshly started Qdrant container), create it and retry once
        upsertErrMsg = qdrantErr instanceof Error ? qdrantErr.message : String(qdrantErr);
        if (recipe.embed_dim > 0 && (qdrantErr?.status === 404 || upsertErrMsg.toLowerCase().includes('not found'))) {
          try {
            await createQdrantCollectionWithIndexes(qdrant, targetCollection, recipe.embed_dim);
            await qdrant.upsert(targetCollection, {
              points: qdrantPointsToUpsert,
            });
            upsertSucceeded = true;
          } catch (retryErr) {
            upsertErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            logger.warn(
              {
                collection: targetCollection,
                error: upsertErrMsg,
              },
              'qdrant batch upsert retry after collection creation failed'
            );
          }
        } else {
          // Qdrant being unreachable is an index lag, not a database failure (Rule 2)
          logger.warn(
            {
              collection: targetCollection,
              count: qdrantPointsToUpsert.length,
              error: upsertErrMsg,
            },
            'qdrant batch upsert skipped or failed'
          );
        }
      }

      if (upsertSucceeded || !qdrantConfigured) {
        for (const p of pendingQdrantDone) {
          markEmbedDone(p.record_id, p.record_type, target);
          totalProcessed++;
        }
        if (options?.onVectorsComputed && computedBlobs.length > 0) {
          options.onVectorsComputed(computedBlobs);
        }
      } else {
        for (const p of pendingQdrantDone) {
          markEmbedFailed(p.record_id, p.record_type, target, upsertErrMsg || 'Qdrant upsert failed');
          totalFailed++;
        }
      }
    } else if (options?.onVectorsComputed && computedBlobs.length > 0) {
      options.onVectorsComputed(computedBlobs);
    }
  }

    const remaining = getPendingEmbedCount(target);
    return { processed: totalProcessed, failed: totalFailed, remaining };
  } finally {
    isDrainRunning = false;
  }
}

export async function ensureInitialEmbeddingsSync(options?: {
  client?: QdrantClient;
}): Promise<{ synced: boolean; enqueued: number; reason?: string }> {
  const recipe = resolveEmbedderRecipe();
  if (recipe.embed_tier === 'none' || recipe.embed_dim === 0) {
    return { synced: false, enqueued: 0, reason: 'embed_tier is none' };
  }

  const qdrant = options?.client ?? getQdrantClient();
  if (!qdrant) {
    return { synced: false, enqueued: 0, reason: 'qdrant client unavailable' };
  }

  try {
    const targetCollection = getStoreMeta()?.qdrant_alias || 'brain';
    const collections = await qdrant.getCollections();
    const collectionExists = collections.collections.some((c) => c.name === targetCollection);

    if (!collectionExists) {
      await createQdrantCollectionWithIndexes(qdrant, targetCollection, recipe.embed_dim);
      logger.info({ collection: targetCollection }, 'created initial Qdrant collection');
    }

    const info = await qdrant.getCollection(targetCollection);
    const pointCount = info.points_count ?? 0;

    const db = getDb();
    const noteCount = (
      db.prepare('SELECT count(*) as count FROM notes WHERE is_latest = 1').get() as { count: number }
    ).count;
    const pendingQueueCount = getPendingEmbedCount('live');

    if (pointCount === 0 && noteCount > 0 && pendingQueueCount === 0) {
      logger.info({ noteCount, pointCount }, 'auto-enqueuing unindexed notes for initial embedding');
      const noteRows = db.prepare('SELECT id FROM notes WHERE is_latest = 1').all() as Array<{ id: string }>;
      transaction(db, () => {
        for (const row of noteRows) {
          enqueueForEmbedding(row.id, 'note', 'live');
        }
      })();

      // Trigger asynchronous background drain
      drainEmbedQueue({ target: 'live', batchSize: 50, maxBatches: 10 }).catch((err) => {
        logger.error({ error: err instanceof Error ? err.message : String(err) }, 'initial embedding drain failed');
      });

      return { synced: true, enqueued: noteRows.length };
    }

    return {
      synced: false,
      enqueued: 0,
      reason: `pointCount=${pointCount}, noteCount=${noteCount}, pending=${pendingQueueCount}`,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: errorMsg }, 'ensureInitialEmbeddingsSync probe failed');
    return { synced: false, enqueued: 0, reason: errorMsg };
  }
}

export async function createQdrantCollectionWithIndexes(
  client: QdrantClient,
  collectionName: string,
  vectorDim: number
): Promise<void> {
  await client.createCollection(collectionName, {
    vectors: {
      size: vectorDim,
      distance: 'Cosine',
    },
  });

  const keywordFields = [
    'scope',
    'project_id',
    'project_ancestors',
    'user_id',
    'entity_type',
    'record_type',
    'kind',
    'type',
    'task_type',
    'note_ref',
    'task_ref',
    'file_path',
    'agent',
  ];

  for (const field of keywordFields) {
    try {
      await client.createPayloadIndex(collectionName, {
        field_name: field,
        field_schema: 'keyword',
      });
    } catch (err) {
      logger.warn({ collectionName, field, error: err }, 'failed to create keyword index');
    }
  }

  try {
    await client.createPayloadIndex(collectionName, {
      field_name: 'success',
      field_schema: 'bool',
    });
  } catch (err) {
    logger.warn({ collectionName, field: 'success', error: err }, 'failed to create bool index');
  }

  try {
    await client.createPayloadIndex(collectionName, {
      field_name: 'created_at',
      field_schema: 'integer',
    });
  } catch (err) {
    logger.warn({ collectionName, field: 'created_at', error: err }, 'failed to create integer index');
  }
}

export async function startReembed(options?: {
  newCollectionName?: string;
  client?: QdrantClient;
}): Promise<{ collection: string; processed: number; failed: number }> {
  // [CR-11] Concurrency guard to prevent parallel re-embedding runs
  if (activeReembedStatus.status === 'running') {
    logger.warn(
      { collection: activeReembedStatus.collection, processed: activeReembedStatus.processed },
      'startReembed called while a reembed process is already running'
    );
    return {
      collection: activeReembedStatus.collection || '',
      processed: activeReembedStatus.processed,
      failed: activeReembedStatus.failed,
    };
  }

  const newCollectionName =
    options?.newCollectionName || `brain_v_${Math.floor(Date.now() / 1000)}`;
  const qdrant = options?.client ?? getQdrantClient();
  const db = getDb();
  const recipe = resolveEmbedderRecipe();

  activeReembedStatus = {
    status: 'running',
    collection: newCollectionName,
    total: 0,
    processed: 0,
    failed: 0,
    started_at: Math.floor(Date.now() / 1000),
    completed_at: null,
    error: null,
  };

  try {
    // Collect active records
    const noteRows = db.prepare('SELECT id FROM notes WHERE is_latest = 1').all() as Array<{ id: string }>;
    const trajRows = db.prepare('SELECT id FROM trajectories').all() as Array<{ id: string }>;
    const obsRows = db.prepare('SELECT id FROM observations').all() as Array<{ id: string }>;
    const sumRows = db.prepare('SELECT id FROM summaries WHERE is_latest = 1').all() as Array<{ id: string }>;
    const entityRows = db.prepare('SELECT id FROM entities').all() as Array<{ id: string }>;
    const actionRows = db.prepare('SELECT id FROM actions').all() as Array<{ id: string }>;

    activeReembedStatus.total =
      noteRows.length +
      trajRows.length +
      obsRows.length +
      sumRows.length +
      entityRows.length +
      actionRows.length;

    // Enqueue to embed_queue with target = newCollectionName in a single atomic transaction (CR-11)
    transaction(db, () => {
      for (const r of noteRows) enqueueForEmbedding(r.id, 'note', newCollectionName);
      for (const r of trajRows) enqueueForEmbedding(r.id, 'trajectory', newCollectionName);
      for (const r of obsRows) enqueueForEmbedding(r.id, 'observation', newCollectionName);
      for (const r of sumRows) enqueueForEmbedding(r.id, 'summary', newCollectionName);
      for (const r of entityRows) enqueueForEmbedding(r.id, 'entity', newCollectionName);
      for (const r of actionRows) enqueueForEmbedding(r.id, 'action', newCollectionName);
    })();

    // Create new collection in Qdrant if reachable
    let qdrantCollectionReady = false;
    if (qdrant && recipe.embed_dim > 0) {
      try {
        await createQdrantCollectionWithIndexes(qdrant, newCollectionName, recipe.embed_dim);
        qdrantCollectionReady = true;
      } catch (qdrantErr) {
        logger.warn(
          { error: qdrantErr instanceof Error ? qdrantErr.message : String(qdrantErr) },
          'could not create qdrant collection for reembed'
        );
      }
    }

    // Wait for any in-flight 'live' drain to finish before draining the new collection
    while (isDrainRunning) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    // Drain queue for new collection until empty
    let processedTotal = 0;
    let failedTotal = 0;
    const deferredBlobs: Array<{ id: string; record_type: EmbedRecordType; blob: Buffer }> = [];

    while (true) {
      const { processed, failed, remaining } = await drainEmbedQueue({
        target: newCollectionName,
        batchSize: 50,
        maxBatches: 1,
        client: qdrant ?? undefined,
        skipSqliteBlobUpdate: true,
        onVectorsComputed: (blobs) => {
          deferredBlobs.push(...blobs);
        },
      });

      processedTotal += processed;
      failedTotal += failed;
      activeReembedStatus.processed = processedTotal;
      activeReembedStatus.failed = failedTotal;

      if (remaining === 0) break;
      if (processed === 0 && failed === 0) {
        throw new Error(`Reembed stalled for target '${newCollectionName}' with ${remaining} remaining items`);
      }
    }

    // Switch alias in Qdrant if reachable
    const meta = getStoreMeta();
    const aliasName = meta?.qdrant_alias || 'brain';

    if (qdrant && recipe.embed_dim > 0 && qdrantCollectionReady) {
      const collections = await qdrant.getCollections();
      const isRegularCollection = collections.collections.some((c) => c.name === aliasName);
      if (isRegularCollection) {
        // Cannot create an alias with the same name as an existing regular collection;
        // delete the old regular collection before creating the alias.
        await qdrant.deleteCollection(aliasName);
        await qdrant.updateCollectionAliases({
          actions: [
            {
              create_alias: {
                collection_name: newCollectionName,
                alias_name: aliasName,
              },
            },
          ],
        });
      } else {
        const aliasesRes = typeof (qdrant as any).getAliases === 'function'
          ? await (qdrant as any).getAliases().catch(() => null)
          : null;
        const hasAlias = aliasesRes?.aliases?.some((a: any) => a.alias_name === aliasName);
        const actions: any[] = [];
        if (hasAlias) {
          actions.push({ delete_alias: { alias_name: aliasName } });
        }
        actions.push({
          create_alias: {
            collection_name: newCollectionName,
            alias_name: aliasName,
          },
        });
        await qdrant.updateCollectionAliases({ actions });
      }
    }

    // Apply deferred SQLite embedding BLOB updates and store_meta atomically on success
    transaction(db, () => {
      for (const item of deferredBlobs) {
        const table = EMBEDDING_TABLE_BY_TYPE[item.record_type];
        if (table) {
          db.prepare(`UPDATE ${table} SET embedding = ? WHERE id = ?`).run(item.blob, item.id);
        }
      }
      commitStoreMeta(recipe, aliasName);
    })();

    activeReembedStatus.status = 'completed';
    activeReembedStatus.completed_at = Math.floor(Date.now() / 1000);

    return {
      collection: newCollectionName,
      processed: processedTotal,
      failed: failedTotal,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    clearEmbedQueueTarget(newCollectionName);
    activeReembedStatus.status = 'failed';
    activeReembedStatus.error = errorMsg;
    logger.error({ error: errorMsg }, 'reembed failed');
    throw error;
  }
}
