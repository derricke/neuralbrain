/**
 * One AI ecosystem, chosen once (CLAUDE.md).
 *
 * This module is the single place that turns environment variables into a
 * resolved generative producer. It holds no network code and no database
 * handle, so it is safe to import from anywhere — including
 * `learning/embedding.ts`, which calls `assertEmbeddingVendorSupported()` to
 * reject an impossible combination at config time rather than at first embed.
 */

import type { GenerativeTier, VendorName } from '../learning/types';

export type GenerativeFunction = 'summarize' | 'consolidate';

export const GENERATIVE_TIERS: readonly GenerativeTier[] = ['none', 'agent', 'remote', 'vendor'];
export const VENDOR_NAMES: readonly VendorName[] = ['openai', 'anthropic', 'google'];

/**
 * Generative functions support all three vendors; the embedder supports two.
 * Anthropic publishes no embeddings endpoint, so there
 * is nothing to implement for `BRAIN_EMBED=vendor` + `BRAIN_VENDOR=anthropic`.
 */
export const EMBEDDING_VENDORS: readonly VendorName[] = ['openai', 'google'];

/**
 * Default chat model per vendor. Deliberately conservative, stable,
 * widely-available ids — all three are non-reasoning instruct builds, which is
 * what the extraction contract wants (docs/CONTRACTS.md: "A reasoning model is
 * the wrong tool"). Override with BRAIN_VENDOR_MODEL when a newer model is
 * available on the account.
 */
export const VENDOR_DEFAULT_CHAT_MODEL: Record<VendorName, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-20241022',
  google: 'gemini-2.0-flash',
};

export const VENDOR_API_KEY_ENV: Record<VendorName, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
};

export const DEFAULT_CHAT_TIMEOUT_MS = 60000;
export const DEFAULT_CHAT_MAX_TOKENS = 2000;
export const DEFAULT_BREAKER_THRESHOLD = 3;
export const DEFAULT_BREAKER_COOLDOWN_MS = 30000;
/** Per-field cap when rendering an observation log into a prompt. */
export const DEFAULT_FIELD_CHARS = 4000;

export class AiConfigurationError extends Error {
  readonly code = 'ai_configuration_error';

  constructor(message: string) {
    super(message);
    this.name = 'AiConfigurationError';
  }
}

export function isAiConfigurationError(error: unknown): error is AiConfigurationError {
  return error instanceof AiConfigurationError;
}

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const FUNCTION_ENV: Record<GenerativeFunction, string> = {
  summarize: 'BRAIN_AI_SUMMARIZE',
  consolidate: 'BRAIN_AI_CONSOLIDATE',
};

/**
 * `BRAIN_AI_<FN>` falls back to `BRAIN_AI`, which defaults to `agent`.
 *
 * There is no `local` tier for a generative function: `local` means
 * in-process, and only an encoder loads in-process. Naming it is a config
 * error rather than a silent downgrade.
 */
export function resolveGenerativeTier(fn: GenerativeFunction): GenerativeTier {
  const specific = readEnv(FUNCTION_ENV[fn]);
  const shared = readEnv('BRAIN_AI');
  const raw = (specific ?? shared ?? 'agent').toLowerCase();

  if (raw === 'local') {
    throw new AiConfigurationError(
      `${specific !== undefined ? FUNCTION_ENV[fn] : 'BRAIN_AI'}=local is not valid for the generative function '${fn}': ` +
        `'local' means in-process, and only an encoder can run in-process — an embedding model cannot summarise. ` +
        `Use one of: ${GENERATIVE_TIERS.join(', ')} (BRAIN_EMBED is where 'local' belongs).`
    );
  }

  if (!GENERATIVE_TIERS.includes(raw as GenerativeTier)) {
    throw new AiConfigurationError(
      `${specific !== undefined ? FUNCTION_ENV[fn] : 'BRAIN_AI'} must be one of: ${GENERATIVE_TIERS.join(
        ', '
      )} (received: ${raw})`
    );
  }

  return raw as GenerativeTier;
}

/** The one vendor, used wherever a tier resolves to `vendor`. */
export function resolveVendor(context = 'BRAIN_VENDOR'): VendorName {
  const raw = readEnv('BRAIN_VENDOR')?.toLowerCase();
  if (!raw) {
    throw new AiConfigurationError(
      `${context} requires BRAIN_VENDOR to be set to one of: ${VENDOR_NAMES.join(', ')}`
    );
  }
  if (!VENDOR_NAMES.includes(raw as VendorName)) {
    throw new AiConfigurationError(
      `BRAIN_VENDOR must be one of: ${VENDOR_NAMES.join(', ')} (received: ${raw})`
    );
  }
  return raw as VendorName;
}

/**
 * Returns the rejection message for an embedder vendor that cannot work, or
 * null when the vendor is supported.
 *
 * Called from `resolveEmbedderRecipe()`. The whole point is that this fires at
 * config time — on startup, on `brain doctor`, on /health — and not at the
 * first embed call, where the failure would be a dependency error buried in a
 * worker log.
 */
export function embeddingVendorRejection(vendor: string): string | null {
  const normalized = vendor.toLowerCase().trim();
  if (normalized !== 'anthropic') return null;

  return (
    'BRAIN_EMBED=vendor with BRAIN_VENDOR=anthropic is not a valid configuration: ' +
    'Anthropic publishes no embeddings API, so there is no endpoint to call. ' +
    `Embeddings support ${EMBEDDING_VENDORS.join(' and ')} only (generative functions support all of ` +
    `${VENDOR_NAMES.join(', ')}). Either set BRAIN_VENDOR=openai|google, or keep ` +
    'BRAIN_VENDOR=anthropic for summarize/consolidate and move the embedder off the vendor tier ' +
    '(BRAIN_EMBED=local|local-gpu|remote|none).'
  );
}

/** Throwing form, for callers with no embedder-specific error type of their own. */
export function assertEmbeddingVendorSupported(vendor: string): void {
  const rejection = embeddingVendorRejection(vendor);
  if (rejection) throw new AiConfigurationError(rejection);
}

export interface ResolvedProducer {
  /** Stored verbatim as `summaries.producer_tier`. */
  tier: GenerativeTier;
  /** Stored verbatim as `summaries.producer_model`; null for 'agent' and 'none'. */
  model: string | null;
  /** Only set when tier === 'vendor'. */
  vendor: VendorName | null;
  /** Only set when tier === 'remote'. */
  endpoint: string | null;
  /** Stable key for the circuit breaker and for log lines. */
  key: string;
}

export interface ResolvedChatConfig extends ResolvedProducer {
  fn: GenerativeFunction;
  timeoutMs: number;
  maxTokens: number;
  breakerThreshold: number;
  breakerCooldownMs: number;
  fieldChars: number;
  /** Ordered fallback tiers, from BRAIN_AI_FALLBACK. Empty by default. */
  fallbackTiers: GenerativeTier[];
}

export function resolveProducer(tier: GenerativeTier, fn: GenerativeFunction): ResolvedProducer {
  if (tier === 'none' || tier === 'agent') {
    return { tier, model: null, vendor: null, endpoint: null, key: tier };
  }

  if (tier === 'remote') {
    const endpoint = (readEnv('BRAIN_ENDPOINT') ?? 'http://localhost:11434/v1').replace(/\/$/, '');
    const model = readEnv('BRAIN_CHAT_MODEL');
    if (!model) {
      throw new AiConfigurationError(
        `BRAIN_AI${fn === 'summarize' ? '_SUMMARIZE' : '_CONSOLIDATE'}=remote requires BRAIN_CHAT_MODEL ` +
          `(the model name as ${endpoint} reports it). Prefer a non-reasoning instruct build — see docs/CONTRACTS.md.`
      );
    }
    return { tier, model, vendor: null, endpoint, key: `remote:${endpoint}:${model}` };
  }

  // vendor
  const vendor = resolveVendor(
    `BRAIN_AI${fn === 'summarize' ? '_SUMMARIZE' : '_CONSOLIDATE'}=vendor`
  );
  const model = readEnv('BRAIN_VENDOR_MODEL') ?? VENDOR_DEFAULT_CHAT_MODEL[vendor];
  const apiKeyEnv = VENDOR_API_KEY_ENV[vendor];
  if (!readEnv(apiKeyEnv)) {
    throw new AiConfigurationError(
      `BRAIN_VENDOR=${vendor} requires ${apiKeyEnv} to be set for generative functions.`
    );
  }
  return {
    tier,
    // `vendor/model` keeps rule 6's "regenerate everything vendor X wrote" a
    // plain SQL predicate against summaries.producer_model.
    model: `${vendor}/${model}`,
    vendor,
    endpoint: null,
    key: `vendor:${vendor}:${model}`,
  };
}

function resolveFallbackTiers(fn: GenerativeFunction, primary: GenerativeTier): GenerativeTier[] {
  const raw = readEnv('BRAIN_AI_FALLBACK');
  if (!raw) return [];

  const tiers: GenerativeTier[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim().toLowerCase();
    if (name === '') continue;
    if (name === 'local') {
      throw new AiConfigurationError(
        "BRAIN_AI_FALLBACK may not contain 'local': only an encoder runs in-process."
      );
    }
    if (!GENERATIVE_TIERS.includes(name as GenerativeTier)) {
      throw new AiConfigurationError(
        `BRAIN_AI_FALLBACK entries must be one of: ${GENERATIVE_TIERS.join(', ')} (received: ${name})`
      );
    }
    if (name === 'none' || name === 'agent') {
      // Neither can be called by a worker: 'none' is a finished state and
      // 'agent' requires a host agent to come and ask. Skipping them keeps the
      // chain to tiers the brain can actually drive itself.
      continue;
    }
    if (name === primary || tiers.includes(name as GenerativeTier)) continue;
    tiers.push(name as GenerativeTier);
  }

  // A fallback is only legitimate because every derived row records which
  // producer actually wrote it (CLAUDE.md, "A deliberate asymmetry"). Drop any
  // tier that cannot be resolved rather than failing the primary path.
  return tiers.filter((tier) => {
    try {
      resolveProducer(tier, fn);
      return true;
    } catch {
      return false;
    }
  });
}

export function resolveChatConfig(fn: GenerativeFunction): ResolvedChatConfig {
  const tier = resolveGenerativeTier(fn);
  const producer = resolveProducer(tier, fn);

  return {
    ...producer,
    fn,
    timeoutMs: readIntEnv('BRAIN_CHAT_TIMEOUT_MS', DEFAULT_CHAT_TIMEOUT_MS),
    maxTokens: readIntEnv('BRAIN_CHAT_MAX_TOKENS', DEFAULT_CHAT_MAX_TOKENS),
    breakerThreshold: readIntEnv('BRAIN_CHAT_BREAKER_THRESHOLD', DEFAULT_BREAKER_THRESHOLD),
    breakerCooldownMs: readIntEnv('BRAIN_CHAT_BREAKER_COOLDOWN_MS', DEFAULT_BREAKER_COOLDOWN_MS),
    fieldChars: readIntEnv('BRAIN_CHAT_FIELD_CHARS', DEFAULT_FIELD_CHARS),
    fallbackTiers: resolveFallbackTiers(fn, tier),
  };
}

/** Operator-facing view. Never includes a key or any part of one. */
export function describeAiConfig(): Record<string, unknown> {
  const describe = (fn: GenerativeFunction) => {
    try {
      const cfg = resolveChatConfig(fn);
      return {
        ok: true,
        tier: cfg.tier,
        vendor: cfg.vendor,
        model: cfg.model,
        endpoint: cfg.endpoint,
        timeout_ms: cfg.timeoutMs,
        max_tokens: cfg.maxTokens,
        breaker_threshold: cfg.breakerThreshold,
        breaker_cooldown_ms: cfg.breakerCooldownMs,
        fallback_tiers: cfg.fallbackTiers,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  return {
    summarize: describe('summarize'),
    consolidate: describe('consolidate'),
    generative_vendors: VENDOR_NAMES,
    embedding_vendors: EMBEDDING_VENDORS,
  };
}
