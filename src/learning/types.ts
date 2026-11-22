import type { MatchTier } from '../lib/scope';

export type EmbedTier = 'none' | 'local' | 'local-gpu' | 'remote' | 'vendor';
export type GenerativeTier = 'none' | 'agent' | 'remote' | 'vendor';
export type VendorName = 'openai' | 'anthropic' | 'google';

export interface ResolvedEmbedderRecipe {
  embed_tier: EmbedTier;
  embed_model: string;
  embed_model_id: string;
  embed_dim: number;
  doc_prefix: string;
  query_prefix: string;
  pooling: string;
  normalize: number;
}

export interface StoreMetaRecord {
  id: number;
  schema_version: number;
  embed_tier: string;
  embed_model: string;
  embed_model_id: string | null;
  embed_dim: number;
  doc_prefix: string;
  query_prefix: string;
  pooling: string;
  normalize: number;
  qdrant_alias: string;
  set_at: number;
}

export type MemoryRecordType =
  | 'note'
  | 'trajectory'
  | 'observation'
  | 'summary'
  | 'entity'
  | 'action';

export interface SearchRequest {
  q: string;
  /** Record types to search (replaces legacy `grains`). Defaults to ['note', 'trajectory']. */
  record_types?: MemoryRecordType[];
  /** @deprecated Use `record_types` instead. */
  grains?: MemoryRecordType[];
  scope?: 'project' | 'global' | 'unknown';
  project_id?: string;
  include_global?: boolean;
  include_ancestors?: boolean;
  include_children?: boolean;
  include_history?: boolean;
  user_id?: string;
  after?: string;
  before?: string;
  as_of?: string;
  temporal_bias?: 'none' | 'recent' | 'upcoming';
  filters?: {
    type?: string[];
    file_path?: string;
    task_type?: string;
    kind?: string;
    agent?: string;
    success?: boolean;
    note_ref?: string;
    task_ref?: string;
    entity_type?: string;
    memory_layer?: 'semantic' | 'procedural';
    user_id?: string;
  };
  /** Include summary_sources provenance entries on summary results (default false). */
  include_sources?: boolean;
  /** Maximum number of source entries to return per summary when include_sources is true (default 20). */
  sources_limit?: number;
  /** Offset into summary sources for pagination when include_sources is true (default 0). */
  sources_offset?: number;
  limit?: number;
}

export interface SearchSummarySource {
  summary_id?: string;
  claim_id?: string | null;
  record_id: string;
  record_type: string;
  title?: string;
  kind?: string;
  tool_name?: string | null;
  file_path?: string | null;
  failed?: boolean;
  preview?: string | null;
}

export interface SearchResultItem {
  id: string;
  record_type: MemoryRecordType;
  score: number;
  project_id?: string | null;
  match_tier?: MatchTier;
  matched_entities?: string[];
  record: Record<string, any>;
  sources?: SearchSummarySource[];
  sources_total?: number;
  sources_has_more?: boolean;
  claims?: Array<{
    id: string;
    summary_id?: string;
    text: string;
    ordinal: number;
  }>;
}

export interface SearchResponse {
  results: SearchResultItem[];
  mode: 'hybrid' | 'bm25';
  degraded?: string;
}

export type AgentProvider = string;

export type TrajectoryEmbeddingRow = {
  id: string;
  swarm_id?: string;
  project_id?: string | null;
  provider?: AgentProvider;
  model?: string;
  description: string;
  result: string | null;
  /** NULL means the outcome is unknown (e.g. a swept rollup), not failed. */
  success: number | null;
  embedding: Buffer | null;
};

export type AgentRecommendation = {
  provider: AgentProvider;
  model: string;
  trajectoryId: string;
  distance: number;
  score: number;
};

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

export interface LearningEngineOptions {
  dimension?: number;
  maxElements?: number;
  embedder?: EmbeddingProvider;
}
