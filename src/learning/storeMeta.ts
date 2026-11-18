import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { resolveEmbedderRecipe } from './embedding';
import type { ResolvedEmbedderRecipe, StoreMetaRecord } from './types';

export interface StoreMetaVerificationResult {
  match: boolean;
  meta: StoreMetaRecord;
  recipe: ResolvedEmbedderRecipe;
  mismatchReason?: string;
}

export function getStoreMeta(): StoreMetaRecord | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM store_meta WHERE id = 1').get() as StoreMetaRecord | undefined;
}

export function verifyOrCreateStoreMeta(
  customRecipe?: ResolvedEmbedderRecipe
): StoreMetaVerificationResult {
  const recipe = customRecipe || resolveEmbedderRecipe();
  const db = getDb();

  let existing = getStoreMeta();

  if (!existing) {
    db.prepare(`
      INSERT INTO store_meta (
        id, schema_version, embed_tier, embed_model, embed_model_id,
        embed_dim, doc_prefix, query_prefix, pooling, normalize, qdrant_alias, set_at
      ) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'brain', unixepoch())
    `).run(
      recipe.embed_tier,
      recipe.embed_model,
      recipe.embed_model_id,
      recipe.embed_dim,
      recipe.doc_prefix,
      recipe.query_prefix,
      recipe.pooling,
      recipe.normalize
    );

    existing = getStoreMeta()!;
    logger.info(
      {
        embed_tier: recipe.embed_tier,
        embed_model_id: recipe.embed_model_id,
        embed_dim: recipe.embed_dim,
      },
      'store_meta initialized'
    );

    return {
      match: true,
      meta: existing,
      recipe,
    };
  }

  // If configured as 'none', we are deliberately running in bm25-only mode without error
  if (recipe.embed_tier === 'none') {
    return {
      match: true,
      meta: existing,
      recipe,
    };
  }

  // Compare both embed_model_id and embed_dim, as well as tier and prefixes
  const isMatch =
    existing.embed_tier === recipe.embed_tier &&
    existing.embed_model_id === recipe.embed_model_id &&
    existing.embed_dim === recipe.embed_dim &&
    existing.doc_prefix === recipe.doc_prefix &&
    existing.query_prefix === recipe.query_prefix;

  if (!isMatch) {
    const mismatchReason = `vector search unavailable: store_meta expects embed_model_id=${existing.embed_model_id} (dim=${existing.embed_dim}, tier=${existing.embed_tier}), but config resolved embed_model_id=${recipe.embed_model_id} (dim=${recipe.embed_dim}, tier=${recipe.embed_tier}). Run POST /maintenance/reembed to rebuild the index.`;

    logger.error(
      {
        expected: {
          embed_tier: existing.embed_tier,
          embed_model_id: existing.embed_model_id,
          embed_dim: existing.embed_dim,
        },
        resolved: {
          embed_tier: recipe.embed_tier,
          embed_model_id: recipe.embed_model_id,
          embed_dim: recipe.embed_dim,
        },
        reason: mismatchReason,
      },
      'store_meta mismatch detected'
    );

    return {
      match: false,
      meta: existing,
      recipe,
      mismatchReason,
    };
  }

  return {
    match: true,
    meta: existing,
    recipe,
  };
}

export function commitStoreMeta(
  recipe: ResolvedEmbedderRecipe,
  qdrantAlias = 'brain'
): StoreMetaRecord {
  const db = getDb();
  db.prepare(`
    INSERT INTO store_meta (
      id, schema_version, embed_tier, embed_model, embed_model_id,
      embed_dim, doc_prefix, query_prefix, pooling, normalize, qdrant_alias, set_at
    ) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      schema_version = 1,
      embed_tier = excluded.embed_tier,
      embed_model = excluded.embed_model,
      embed_model_id = excluded.embed_model_id,
      embed_dim = excluded.embed_dim,
      doc_prefix = excluded.doc_prefix,
      query_prefix = excluded.query_prefix,
      pooling = excluded.pooling,
      normalize = excluded.normalize,
      qdrant_alias = excluded.qdrant_alias,
      set_at = unixepoch()
  `).run(
    recipe.embed_tier,
    recipe.embed_model,
    recipe.embed_model_id,
    recipe.embed_dim,
    recipe.doc_prefix,
    recipe.query_prefix,
    recipe.pooling,
    recipe.normalize,
    qdrantAlias
  );

  return getStoreMeta()!;
}
