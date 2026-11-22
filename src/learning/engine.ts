import { QdrantClient } from '@qdrant/js-client-rest';
import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { resolveEmbedderRecipe } from './embedding';
import { getStoreMeta, verifyOrCreateStoreMeta, type StoreMetaVerificationResult } from './storeMeta';
import { hybridSearch } from './search';
import { drainEmbedQueue, getQdrantClient, startReembed } from './embedWorker';
import type { AgentRecommendation, EmbeddingProvider, LearningEngineOptions } from './types';

export class LearningEngine {
  private client: QdrantClient | null = null;
  private initialized = false;
  private verificationResult: StoreMetaVerificationResult | null = null;

  constructor(options?: LearningEngineOptions) {
    this.client = getQdrantClient();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.verificationResult = verifyOrCreateStoreMeta();
    this.initialized = true;

    logger.info(
      {
        match: this.verificationResult.match,
        embed_tier: this.verificationResult.recipe.embed_tier,
        embed_model_id: this.verificationResult.recipe.embed_model_id,
        embed_dim: this.verificationResult.recipe.embed_dim,
      },
      'learning engine initialized'
    );
  }

  getVerification(): StoreMetaVerificationResult {
    if (!this.verificationResult) {
      this.verificationResult = verifyOrCreateStoreMeta();
    }
    return this.verificationResult;
  }

  async rebuildFromDatabase(): Promise<void> {
    await startReembed();
  }

  async findSimilarTrajectories(
    projectIdOrSwarmId: string,
    task: string,
    limit = 5,
    onlySuccess = true
  ): Promise<AgentRecommendation[]> {
    const searchRes = await hybridSearch({
      q: task,
      record_types: ['trajectory'],
      project_id: projectIdOrSwarmId,
      filters: {
        success: onlySuccess ? true : undefined,
      },
      limit,
    });

    return searchRes.results.map((r) => ({
      provider: r.record.agent || 'unknown',
      model: r.record.agent || 'unknown',
      trajectoryId: r.id,
      distance: 1 - r.score,
      score: r.score,
    }));
  }

  async drainQueue(batchSize = 32): Promise<{ processed: number; failed: number; remaining: number }> {
    return drainEmbedQueue({ batchSize });
  }
}

let _engine: LearningEngine | null = null;

export function getLearningEngine(): LearningEngine {
  if (!_engine) {
    _engine = new LearningEngine();
  }
  return _engine;
}

export { deleteQdrantPoints } from './embedWorker';
