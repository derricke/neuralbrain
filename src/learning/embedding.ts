import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { logger } from '../lib/logger';
import { getDefaultModelCacheDir } from '../lib/brainHome';
import { embeddingVendorRejection } from '../ai/config';
import { redactUrl } from '../ai/vendors';
import type { EmbeddingProvider, ResolvedEmbedderRecipe } from './types';

export class EmbeddingConfigurationError extends Error {
  readonly code = 'embedding_configuration_error';

  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingConfigurationError';
  }
}

export function isEmbeddingConfigurationError(error: unknown): error is EmbeddingConfigurationError {
  return error instanceof EmbeddingConfigurationError;
}

export function matryoshkaTruncate(vec: number[], targetDim: number): number[] {
  if (!vec || vec.length === 0 || targetDim <= 0) return [];
  const d = vec.length;
  let sum = 0;
  for (let i = 0; i < d; i++) sum += vec[i];
  const mean = sum / d;
  let varSum = 0;
  for (let i = 0; i < d; i++) {
    const diff = vec[i] - mean;
    varSum += diff * diff;
  }
  const std = Math.sqrt(varSum / d + 1e-5);
  const target = Math.min(targetDim, d);
  const sliced = new Array<number>(target);
  let normSq = 0;
  for (let i = 0; i < target; i++) {
    const val = (vec[i] - mean) / std;
    sliced[i] = val;
    normSq += val * val;
  }
  const l2 = Math.sqrt(normSq);
  if (l2 > 0) {
    for (let i = 0; i < target; i++) {
      sliced[i] /= l2;
    }
  }
  return sliced;
}

export function l2Normalize(vec: number[]): number[] {
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) normSq += vec[i] * vec[i];
  const norm = Math.sqrt(normSq);
  if (norm === 0) return vec.slice();
  return vec.map((v) => v / norm);
}

/**
 * The embedder's model name for the `vendor` tier.
 *
 * This reads BRAIN_EMBED_MODEL, *not* BRAIN_VENDOR_MODEL. The two were briefly
 * the same variable, which could not work: BRAIN_VENDOR_MODEL is the generative
 * model for summarize/consolidate, so setting it to a chat model (say
 * `gpt-4o-mini`) silently re-pointed the embedder at a model that cannot embed —
 * and `store_meta` would then pin that as the store's embedder identity. One
 * variable, two meanings, failing quietly: exactly the class of bug this project
 * exists to remove.
 *
 * BRAIN_EMBED_MODEL already owns "which model" for every other embedder tier
 * (the tier chooses where, BRAIN_EMBED_MODEL chooses which), so the
 * vendor tier uses it too. The tier-specific keywords `nomic` and `minilm` are
 * in-process model names and are ignored here, falling through to the vendor
 * default.
 */
function resolveVendorEmbedModel(fallback: string): string {
  const configured = process.env.BRAIN_EMBED_MODEL?.trim();
  if (!configured) return fallback;
  const lower = configured.toLowerCase();
  if (lower === 'nomic' || lower === 'minilm') return fallback;
  return configured;
}

export function resolveEmbedderRecipe(): ResolvedEmbedderRecipe {
  const embedTierRaw = (process.env.BRAIN_EMBED || 'local').toLowerCase().trim();
  const embedModelRaw = (process.env.BRAIN_EMBED_MODEL || 'nomic').trim();
  const dimOverride = process.env.BRAIN_EMBED_DIM ? parseInt(process.env.BRAIN_EMBED_DIM, 10) : undefined;

  if (embedTierRaw === 'none') {
    return {
      embed_tier: 'none',
      embed_model: 'none',
      embed_model_id: 'none',
      embed_dim: 0,
      doc_prefix: '',
      query_prefix: '',
      pooling: 'mean',
      normalize: 1,
    };
  }

  if (embedTierRaw === 'local' || embedTierRaw === 'local-gpu') {
    const isMinilm = embedModelRaw.toLowerCase() === 'minilm';
    const isNomic = embedModelRaw.toLowerCase() === 'nomic' || embedModelRaw.toLowerCase().includes('nomic');

    let modelId: string;
    let defaultDim: number;
    let docPrefix = '';
    let queryPrefix = '';

    if (isMinilm) {
      modelId = 'Xenova/all-MiniLM-L6-v2';
      defaultDim = 384;
    } else if (isNomic) {
      modelId = 'nomic-ai/nomic-embed-text-v1.5';
      defaultDim = 512;
      docPrefix = 'search_document: ';
      queryPrefix = 'search_query: ';
    } else {
      modelId = embedModelRaw;
      defaultDim = 512;
      if (embedModelRaw.toLowerCase().includes('nomic')) {
        docPrefix = 'search_document: ';
        queryPrefix = 'search_query: ';
      }
    }

    return {
      embed_tier: embedTierRaw,
      embed_model: embedModelRaw,
      embed_model_id: modelId,
      embed_dim: dimOverride ?? defaultDim,
      doc_prefix: docPrefix,
      query_prefix: queryPrefix,
      pooling: 'mean',
      normalize: 1,
    };
  }

  if (embedTierRaw === 'remote') {
    const isMinilm = embedModelRaw.toLowerCase().includes('minilm');
    const isNomic = embedModelRaw.toLowerCase().includes('nomic');

    return {
      embed_tier: 'remote',
      embed_model: embedModelRaw,
      embed_model_id: embedModelRaw,
      embed_dim: dimOverride ?? (isMinilm ? 384 : 768),
      doc_prefix: isNomic ? 'search_document: ' : '',
      query_prefix: isNomic ? 'search_query: ' : '',
      pooling: 'mean',
      normalize: 1,
    };
  }

  if (embedTierRaw === 'vendor') {
    const vendor = (process.env.BRAIN_VENDOR || 'google').toLowerCase().trim();
    // Vendors split by capability: generative supports
    // openai, anthropic and google; the embedder supports openai and google.
    // Anthropic publishes no embeddings API, so this combination has to fail
    // here — at config time, where the operator can read it — and not at the
    // first embed call inside a worker.
    const vendorRejection = embeddingVendorRejection(vendor);
    if (vendorRejection) {
      throw new EmbeddingConfigurationError(vendorRejection);
    }
    if (vendor === 'google') {
      const model = resolveVendorEmbedModel('gemini-embedding-001');
      return {
        embed_tier: 'vendor',
        embed_model: model,
        embed_model_id: model,
        embed_dim: dimOverride ?? 3072,
        doc_prefix: '',
        query_prefix: '',
        pooling: 'mean',
        normalize: 1,
      };
    } else {
      // Default to OpenAI
      const model = resolveVendorEmbedModel('text-embedding-3-small');
      return {
        embed_tier: 'vendor',
        embed_model: model,
        embed_model_id: model,
        embed_dim: dimOverride ?? 1536,
        doc_prefix: '',
        query_prefix: '',
        pooling: 'mean',
        normalize: 1,
      };
    }
  }

  throw new EmbeddingConfigurationError(
    `BRAIN_EMBED must be one of: none, local, local-gpu, remote, vendor (received: ${embedTierRaw})`
  );
}

// Custom embedder function hook for tests/mocking
type CustomEmbedderFn = (text: string, isQuery: boolean) => Promise<number[]>;
let customEmbedderFn: CustomEmbedderFn | null = null;

export function setCustomEmbedder(fn: CustomEmbedderFn | null): void {
  customEmbedderFn = fn;
}

/**
 * @huggingface/transformers (with onnxruntime-node) is an OPTIONAL dependency,
 * loaded only when the in-process `local` embedder is actually used. Docker
 * mode, `local-only` (BRAIN_EMBED=none) and the remote/vendor/local-gpu tiers
 * never load it, so a host install without it still starts and serves.
 *
 * It is optional because onnxruntime-node@1.20.1's install script fails on
 * Linux x64 during `npm install -g` (it downloads a CUDA 11 build that no
 * longer exists); npm drops a failed optional dependency instead of failing the
 * whole install, and `neuralbrain install` / `start` add it back when needed.
 */
export const LOCAL_EMBEDDER_MISSING_MESSAGE =
  'The local embedder (BRAIN_EMBED=local) needs @huggingface/transformers, which is not installed. ' +
  'Run `neuralbrain start` (or `neuralbrain install`) to add it, or set BRAIN_EMBED to none, remote, vendor or local-gpu.';

type TransformersModule = typeof import('@huggingface/transformers');
let transformersPromise: Promise<TransformersModule> | null = null;

async function loadTransformers(): Promise<TransformersModule> {
  if (!transformersPromise) {
    transformersPromise = import('@huggingface/transformers').catch((err) => {
      transformersPromise = null;
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'local embedder unavailable');
      throw new EmbeddingConfigurationError(LOCAL_EMBEDDER_MISSING_MESSAGE);
    });
  }
  return transformersPromise;
}

// In-process pipeline singleton
let localPipelinePromise: Promise<any> | null = null;

async function getLocalPipeline(modelId: string) {
  if (!localPipelinePromise) {
    const { pipeline, env: hfEnv } = await loadTransformers();
    const cacheDir =
      process.env.BRAIN_MODEL_CACHE_DIR ||
      (fs.existsSync(path.join(process.cwd(), 'data', 'models'))
        ? path.join(process.cwd(), 'data', 'models')
        : getDefaultModelCacheDir());

    if (cacheDir) {
      hfEnv.cacheDir = cacheDir;
    }

    localPipelinePromise = pipeline('feature-extraction', modelId, { dtype: 'q8' }).catch((err: unknown) => {
      localPipelinePromise = null;
      throw err;
    });
  }
  return localPipelinePromise;
}

export function resetLocalPipeline(): void {
  localPipelinePromise = null;
}

/**
 * Character cap for in-process ONNX embedding (~2k tokens). Attention memory grows
 * quadratically with sequence length: at the previous 32k-char cap (~8k tokens) a
 * single large observation (full tool input + output) pushed the container past its
 * 1.5 GB limit and caused an OOM crash-loop. The full text stays in SQLite (Rule 2);
 * only the vector is computed over this prefix.
 */
export const MAX_LOCAL_EMBED_CHARS = 8000;

export function boundLocalEmbedText(text: string): string {
  return text.length > MAX_LOCAL_EMBED_CHARS ? text.slice(0, MAX_LOCAL_EMBED_CHARS) : text;
}

async function runLocalEmbedding(text: string, recipe: ResolvedEmbedderRecipe): Promise<number[]> {
  const extractor = await getLocalPipeline(recipe.embed_model_id);
  const boundedText = boundLocalEmbedText(text);
  const output = await extractor(boundedText, { pooling: 'mean', normalize: false });
  const rawData: number[] = Array.from(output.data);

  const isNomic = recipe.embed_model_id.toLowerCase().includes('nomic');
  if (isNomic && rawData.length === 768 && recipe.embed_dim < 768) {
    return matryoshkaTruncate(rawData, recipe.embed_dim);
  }

  if (recipe.normalize === 1) {
    return l2Normalize(rawData.slice(0, recipe.embed_dim));
  }

  return rawData.slice(0, recipe.embed_dim);
}

function postprocessNomicOrSlice(rawVec: number[], modelName: string, recipe: ResolvedEmbedderRecipe): number[] {
  const isNomic = modelName.toLowerCase().includes('nomic');
  if (isNomic && rawVec.length === 768 && recipe.embed_dim < 768) {
    return matryoshkaTruncate(rawVec, recipe.embed_dim);
  }
  if (recipe.normalize === 1 && rawVec.length !== recipe.embed_dim) {
    return l2Normalize(rawVec.slice(0, recipe.embed_dim));
  }
  return rawVec.length > recipe.embed_dim ? rawVec.slice(0, recipe.embed_dim) : rawVec;
}

// Cached OpenAI-compatible clients keyed by `${baseURL}::${apiKey}` so local-gpu,
// remote, and vendor endpoints reuse HTTP keep-alive connections across calls.
const openAIClientCache = new Map<string, OpenAI>();

function getOpenAIClient(apiKey: string, baseURL?: string): OpenAI {
  const key = `${baseURL ?? ''}::${apiKey}`;
  let client = openAIClientCache.get(key);
  if (!client) {
    client = baseURL ? new OpenAI({ apiKey, baseURL }) : new OpenAI({ apiKey });
    openAIClientCache.set(key, client);
  }
  return client;
}

export function resetOpenAIClients(): void {
  openAIClientCache.clear();
}

export function resolveLocalGpuEndpoint(): string {
  const explicit = process.env.BRAIN_GPU_ENDPOINT?.trim() || process.env.BRAIN_EMBED_ENDPOINT?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, '');
  }
  const port = process.env.BRAIN_GPU_PORT?.trim() || '7997';
  return `http://127.0.0.1:${port}`;
}

async function runOpenAICompatibleBatch(
  client: OpenAI,
  requestModel: string,
  postprocessModel: string,
  boundedTexts: string[],
  recipe: ResolvedEmbedderRecipe,
  applyPostprocess: boolean
): Promise<number[][]> {
  const response = await client.embeddings.create({
    model: requestModel,
    input: boundedTexts.length === 1 ? boundedTexts[0] : boundedTexts,
    encoding_format: 'float',
  });

  const sorted = [...(response.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (sorted.length !== boundedTexts.length) {
    throw new Error(
      `Embedding batch size mismatch: expected ${boundedTexts.length}, got ${sorted.length}`
    );
  }

  return sorted.map((item) => {
    const rawVec = item.embedding ?? [];
    return applyPostprocess ? postprocessNomicOrSlice(rawVec, postprocessModel, recipe) : rawVec;
  });
}

async function runLocalGpuEmbedding(text: string, recipe: ResolvedEmbedderRecipe): Promise<number[]> {
  const [vec] = await runLocalGpuBatch([text], recipe);
  return vec ?? [];
}

async function runLocalGpuBatch(texts: string[], recipe: ResolvedEmbedderRecipe): Promise<number[][]> {
  const endpoint = resolveLocalGpuEndpoint();
  const client = getOpenAIClient('no-key', endpoint);
  const bounded = texts.map(boundLocalEmbedText);
  return runOpenAICompatibleBatch(
    client,
    recipe.embed_model_id,
    recipe.embed_model_id,
    bounded,
    recipe,
    true
  );
}

async function runRemoteEmbedding(text: string, recipe: ResolvedEmbedderRecipe): Promise<number[]> {
  const [vec] = await runRemoteBatch([text], recipe);
  return vec ?? [];
}

async function runRemoteBatch(texts: string[], recipe: ResolvedEmbedderRecipe): Promise<number[][]> {
  const endpoint = (
    process.env.BRAIN_EMBED_ENDPOINT?.trim() ||
    process.env.BRAIN_ENDPOINT?.trim() ||
    'http://localhost:11434/v1'
  ).replace(/\/$/, '');
  const apiKey =
    process.env.BRAIN_EMBED_API_KEY?.trim() ||
    process.env.BRAIN_ENDPOINT_API_KEY?.trim() ||
    'no-key';

  const client = getOpenAIClient(apiKey, endpoint);
  const bounded = texts.map(boundLocalEmbedText);
  return runOpenAICompatibleBatch(
    client,
    recipe.embed_model,
    recipe.embed_model,
    bounded,
    recipe,
    true
  );
}

async function runVendorEmbedding(text: string, recipe: ResolvedEmbedderRecipe): Promise<number[]> {
  const vendor = (process.env.BRAIN_VENDOR || 'google').toLowerCase().trim();

  // Unreachable if the recipe was resolved first; kept so no future call path
  // can reach an embeddings API that does not exist.
  const vendorRejection = embeddingVendorRejection(vendor);
  if (vendorRejection) {
    throw new EmbeddingConfigurationError(vendorRejection);
  }

  const boundedText = boundLocalEmbedText(text);

  if (vendor === 'google') {
    const apiKey = process.env.GOOGLE_API_KEY?.trim();
    if (!apiKey) {
      throw new EmbeddingConfigurationError('GOOGLE_API_KEY is required for vendor embedding');
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${recipe.embed_model}:embedContent`;
    const safeUrl = redactUrl(url);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        content: { parts: [{ text: boundedText }] },
      }),
    });
    if (!response.ok) {
      throw new Error(`Google embedding error at ${safeUrl}: ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as any;
    const values = json.embedding?.values;
    if (!Array.isArray(values)) {
      throw new Error('Google embedding response missing numeric values');
    }
    return values.map(Number);
  } else {
    // OpenAI vendor
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new EmbeddingConfigurationError('OPENAI_API_KEY is required for vendor embedding');
    }
    const client = getOpenAIClient(apiKey);
    const response = await client.embeddings.create({
      model: recipe.embed_model,
      input: boundedText,
    });
    return response.data[0]?.embedding ?? [];
  }
}

export async function queryRemoteModelId(endpointUrl?: string): Promise<string | null> {
  const endpoint = (
    endpointUrl ||
    process.env.BRAIN_EMBED_ENDPOINT?.trim() ||
    process.env.BRAIN_ENDPOINT?.trim() ||
    'http://localhost:11434/v1'
  ).replace(/\/$/, '');
  const apiKey =
    process.env.BRAIN_EMBED_API_KEY?.trim() ||
    process.env.BRAIN_ENDPOINT_API_KEY?.trim() ||
    'no-key';

  try {
    const client = getOpenAIClient(apiKey, endpoint);
    const modelsList = await client.models.list();
    if (modelsList.data && modelsList.data.length > 0) {
      return modelsList.data[0].id;
    }
    return null;
  } catch (err) {
    logger.warn({ endpoint, error: err instanceof Error ? err.message : String(err) }, 'failed to query remote model id');
    return null;
  }
}

export async function embedDocument(text: string): Promise<number[]> {
  const recipe = resolveEmbedderRecipe();
  if (recipe.embed_tier === 'none') {
    return [];
  }

  if (customEmbedderFn) {
    return customEmbedderFn(text, false);
  }

  const prefixedText = recipe.doc_prefix ? `${recipe.doc_prefix}${text}` : text;

  switch (recipe.embed_tier) {
    case 'local':
      return runLocalEmbedding(prefixedText, recipe);
    case 'local-gpu':
      return runLocalGpuEmbedding(prefixedText, recipe);
    case 'remote':
      return runRemoteEmbedding(prefixedText, recipe);
    case 'vendor':
      return runVendorEmbedding(prefixedText, recipe);
  }
}

export async function embedQuery(text: string): Promise<number[]> {
  const recipe = resolveEmbedderRecipe();
  if (recipe.embed_tier === 'none') {
    return [];
  }

  if (customEmbedderFn) {
    return customEmbedderFn(text, true);
  }

  const prefixedText = recipe.query_prefix ? `${recipe.query_prefix}${text}` : text;

  switch (recipe.embed_tier) {
    case 'local':
      return runLocalEmbedding(prefixedText, recipe);
    case 'local-gpu':
      return runLocalGpuEmbedding(prefixedText, recipe);
    case 'remote':
      return runRemoteEmbedding(prefixedText, recipe);
    case 'vendor':
      return runVendorEmbedding(prefixedText, recipe);
  }
}

export async function embedDocuments(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  const recipe = resolveEmbedderRecipe();
  if (recipe.embed_tier === 'none') {
    return texts.map(() => []);
  }

  if (customEmbedderFn) {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await customEmbedderFn(text, false));
    }
    return results;
  }

  const prefixedTexts = recipe.doc_prefix
    ? texts.map((text) => `${recipe.doc_prefix}${text}`)
    : texts;

  switch (recipe.embed_tier) {
    case 'local-gpu':
      return runLocalGpuBatch(prefixedTexts, recipe);
    case 'remote':
      return runRemoteBatch(prefixedTexts, recipe);
    case 'vendor': {
      const vendor = (process.env.BRAIN_VENDOR || 'google').toLowerCase().trim();
      const vendorRejection = embeddingVendorRejection(vendor);
      if (vendorRejection) {
        throw new EmbeddingConfigurationError(vendorRejection);
      }
      if (vendor !== 'google') {
        const apiKey = process.env.OPENAI_API_KEY?.trim();
        if (!apiKey) {
          throw new EmbeddingConfigurationError('OPENAI_API_KEY is required for vendor embedding');
        }
        const client = getOpenAIClient(apiKey);
        return runOpenAICompatibleBatch(
          client,
          recipe.embed_model,
          recipe.embed_model,
          prefixedTexts.map(boundLocalEmbedText),
          recipe,
          false
        );
      }
      break;
    }
    case 'local':
      break;
  }

  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embedDocument(text));
  }
  return results;
}

export function buildTrajectoryEmbeddingText(input: {
  description?: string;
  result?: string | null;
  provider?: string;
  model?: string;
  success?: boolean | number | null;
}): string {
  return [
    `task: ${input.description || ''}`,
    `provider: ${input.provider || 'unknown'}`,
    `model: ${input.model || 'unknown'}`,
    // null/undefined is an unknown outcome, not a failed one. Writing 'no'
    // here would put a fabricated outcome into the embedded text.
    `success: ${input.success === null || input.success === undefined ? 'unknown' : input.success ? 'yes' : 'no'}`,
    input.result ? `result: ${input.result}` : 'result: none',
  ].join('\n');
}

export function serializeEmbedding(vector: number[]): Buffer {
  return Buffer.from(Float32Array.from(vector).buffer);
}

export function deserializeEmbedding(blob: Buffer): number[] {
  const byteLength = blob.byteLength - (blob.byteLength % Float32Array.BYTES_PER_ELEMENT);
  if (byteLength === 0) return [];
  if (blob.byteOffset % Float32Array.BYTES_PER_ELEMENT !== 0) {
    const aligned = new Uint8Array(byteLength);
    aligned.set(blob.subarray(0, byteLength));
    return Array.from(new Float32Array(aligned.buffer, 0, byteLength / Float32Array.BYTES_PER_ELEMENT));
  }
  const vector = new Float32Array(blob.buffer, blob.byteOffset, byteLength / Float32Array.BYTES_PER_ELEMENT);
  return Array.from(vector);
}

// Legacy class export for backwards compatibility
export class AutoEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    return embedDocument(text);
  }
}
