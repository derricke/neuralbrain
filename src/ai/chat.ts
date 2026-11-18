/**
 * One call site for every generative request the brain makes itself.
 *
 * It owns the three things a worker needs and nothing else: a request timeout,
 * a circuit breaker, and an optional fallback chain. It deliberately does not
 * inspect the model's text — an empty reply, a truncated reply and
 * unparseable JSON are all *verification* outcomes, handled by the gate so
 * they land in `dead_letters` attributed to the producer that caused them.
 *
 * The asymmetry with the embedder is intentional (CLAUDE.md, "A deliberate
 * asymmetry"): a consolidator may fall back because every derived row records
 * which producer actually wrote it and can be deleted and regenerated. The
 * embedder may not, because a different vector space is not recoverable.
 */

import { logger } from '../lib/logger';
import { probeReasoningTokens } from '../consolidation/fixtures';
import {
  AiConfigurationError,
  resolveChatConfig,
  resolveProducer,
  type GenerativeFunction,
  type ResolvedChatConfig,
} from './config';
import {
  assertCircuitClosed,
  isCircuitOpenError,
  recordFailure,
  recordSuccess,
} from './circuitBreaker';
import {
  createRemoteAdapter,
  createVendorAdapter,
  isChatTransportError,
  type ChatReply,
  type GenerativeAdapter,
} from './vendors';
import type { GenerativeTier } from '../learning/types';

export interface ChatAttempt {
  tier: GenerativeTier;
  model: string | null;
  ok: boolean;
  error?: string;
}

export interface ChatCompletion extends ChatReply {
  /** What goes into `summaries.producer_tier`. */
  producer_tier: GenerativeTier;
  /** What goes into `summaries.producer_model`. */
  producer_model: string | null;
  producer_key: string;
  /** Every tier tried, in order, including the ones that failed. */
  attempts: ChatAttempt[];
}

/** Memoised so the probe runs once per process, as docs/CONTRACTS.md specifies. */
let reasoningProbe: Promise<{ probed: boolean; reasoningTokens: number }> | null = null;

export function resetReasoningProbeCache(): void {
  reasoningProbe = null;
}

async function reasoningHeadroom(): Promise<number> {
  if (!reasoningProbe) {
    reasoningProbe = probeReasoningTokens().catch(() => ({ probed: false, reasoningTokens: 0 }));
  }
  const { reasoningTokens } = await reasoningProbe;
  if (reasoningTokens <= 0) return 0;
  // Budgets are sized from what the endpoint actually does, never from a
  // no-think flag: on tested hardware a reasoning build burned 5,820 of a
  // 6,000-token budget thinking and returned nothing.
  return reasoningTokens * 2;
}

export function adapterFor(tier: GenerativeTier, fn: GenerativeFunction): GenerativeAdapter {
  const producer = resolveProducer(tier, fn);
  if (producer.tier === 'remote') {
    return createRemoteAdapter(producer.endpoint!);
  }
  if (producer.tier === 'vendor') {
    return createVendorAdapter(producer.vendor!);
  }
  throw new AiConfigurationError(
    `tier '${tier}' has no adapter: 'none' is a finished state and 'agent' means the host agent does the ` +
      'work over MCP, so neither is something the brain can call itself.'
  );
}

/** The model name as the provider expects it, stripped of the vendor prefix. */
function wireModel(tier: GenerativeTier, fn: GenerativeFunction): string {
  const producer = resolveProducer(tier, fn);
  const model = producer.model ?? '';
  return producer.tier === 'vendor' ? model.slice(model.indexOf('/') + 1) : model;
}

async function attemptTier(
  tier: GenerativeTier,
  cfg: ResolvedChatConfig,
  prompt: { system: string; user: string },
  maxTokens: number
): Promise<ChatCompletion> {
  const producer = resolveProducer(tier, cfg.fn);
  const adapter = adapterFor(tier, cfg.fn);
  const breakerOptions = {
    threshold: cfg.breakerThreshold,
    cooldownMs: cfg.breakerCooldownMs,
  };

  assertCircuitClosed(producer.key, breakerOptions);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const reply = await adapter.complete({
      system: prompt.system,
      user: prompt.user,
      model: wireModel(tier, cfg.fn),
      maxTokens,
      signal: controller.signal,
    });

    recordSuccess(producer.key);

    if (reply.reasoning_tokens > 0) {
      logger.warn(
        { producer: producer.key, reasoningTokens: reply.reasoning_tokens },
        'generative producer reported reasoning tokens — extraction needs no reasoning; ' +
          'prefer a non-reasoning instruct build and size BRAIN_CHAT_MAX_TOKENS accordingly'
      );
    }

    return {
      ...reply,
      producer_tier: producer.tier,
      producer_model: producer.model,
      producer_key: producer.key,
      attempts: [{ tier, model: producer.model, ok: true }],
    };
  } catch (err) {
    if (!isCircuitOpenError(err)) {
      recordFailure(producer.key, err, breakerOptions);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the configured producer for `fn`. Throws only on transport failure —
 * a dead endpoint, a timeout, an open breaker, a misconfiguration. A 200 with
 * useless content comes back as a normal ChatCompletion, because the gate is
 * what decides whether content is acceptable.
 */
export async function runChat(
  fn: GenerativeFunction,
  prompt: { system: string; user: string },
  configOverride?: ResolvedChatConfig
): Promise<ChatCompletion> {
  const cfg = configOverride ?? resolveChatConfig(fn);

  if (cfg.tier === 'none' || cfg.tier === 'agent') {
    throw new AiConfigurationError(
      `generative function '${fn}' resolves to tier '${cfg.tier}', which the brain cannot call itself. ` +
        "'none' is a finished state; 'agent' means the host agent does the work over MCP."
    );
  }

  const maxTokens = cfg.maxTokens + (await reasoningHeadroom());
  const chain: GenerativeTier[] = [cfg.tier, ...cfg.fallbackTiers];
  const attempts: ChatAttempt[] = [];
  let lastError: unknown;

  for (const tier of chain) {
    try {
      const result = await attemptTier(tier, cfg, prompt, maxTokens);
      return { ...result, attempts: [...attempts, ...result.attempts] };
    } catch (err) {
      lastError = err;
      if (err instanceof AiConfigurationError) throw err;
      if (!isChatTransportError(err) && !isCircuitOpenError(err)) throw err;

      let model: string | null = null;
      try {
        model = resolveProducer(tier, cfg.fn).model;
      } catch {
        model = null;
      }
      attempts.push({
        tier,
        model,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      logger.warn(
        { fn, tier, error: err instanceof Error ? err.message : String(err) },
        chain.indexOf(tier) < chain.length - 1
          ? 'generative producer failed, falling back to the next tier'
          : 'generative producer failed and no fallback remains'
      );
    }
  }

  const summary = attempts.map((a) => `${a.tier}(${a.model ?? '-'}): ${a.error}`).join('; ');
  const error = new Error(
    `every generative producer for '${fn}' failed — ${summary}. ` +
      'Nothing was written and nothing was dead-lettered: a dependency being down is never a dead letter (rule 3).'
  );
  (error as any).code = 'chat_unavailable';
  (error as any).attempts = attempts;
  (error as any).cause = lastError;
  throw error;
}
