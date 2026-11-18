import {
  AiConfigurationError,
  VENDOR_DEFAULT_CHAT_MODEL,
  describeAiConfig,
  embeddingVendorRejection,
  resolveChatConfig,
  resolveGenerativeTier,
  resolveProducer,
} from '../../ai/config';
import {
  isEmbeddingConfigurationError,
  resolveEmbedderRecipe,
} from '../../learning/embedding';

describe('generative config resolution', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    delete process.env.BRAIN_AI;
    delete process.env.BRAIN_AI_SUMMARIZE;
    delete process.env.BRAIN_AI_CONSOLIDATE;
    delete process.env.BRAIN_AI_FALLBACK;
    delete process.env.BRAIN_VENDOR;
    delete process.env.BRAIN_VENDOR_MODEL;
    delete process.env.BRAIN_CHAT_MODEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults both generative functions to the 'agent' tier", () => {
    expect(resolveGenerativeTier('summarize')).toBe('agent');
    expect(resolveGenerativeTier('consolidate')).toBe('agent');

    const cfg = resolveChatConfig('consolidate');
    expect(cfg.tier).toBe('agent');
    expect(cfg.model).toBeNull();
    expect(cfg.vendor).toBeNull();
  });

  it('inherits BRAIN_AI and lets the per-function override win', () => {
    process.env.BRAIN_AI = 'none';
    expect(resolveGenerativeTier('summarize')).toBe('none');
    expect(resolveGenerativeTier('consolidate')).toBe('none');

    process.env.BRAIN_AI_CONSOLIDATE = 'agent';
    expect(resolveGenerativeTier('consolidate')).toBe('agent');
    expect(resolveGenerativeTier('summarize')).toBe('none');
  });

  it("rejects the 'local' tier for generative functions, naming why", () => {
    process.env.BRAIN_AI = 'local';
    expect(() => resolveGenerativeTier('consolidate')).toThrow(AiConfigurationError);
    expect(() => resolveGenerativeTier('consolidate')).toThrow(/only an encoder can run in-process/);

    process.env.BRAIN_AI = 'agent';
    process.env.BRAIN_AI_SUMMARIZE = 'local';
    expect(() => resolveGenerativeTier('summarize')).toThrow(/BRAIN_AI_SUMMARIZE=local/);
  });

  it('rejects an unknown generative tier', () => {
    process.env.BRAIN_AI = 'magic';
    expect(() => resolveGenerativeTier('consolidate')).toThrow(/must be one of: none, agent, remote, vendor/);
  });

  it('routes the vendor tier to BRAIN_VENDOR with a default model per vendor', () => {
    process.env.BRAIN_AI_CONSOLIDATE = 'vendor';

    process.env.BRAIN_VENDOR = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    let producer = resolveProducer('vendor', 'consolidate');
    expect(producer.vendor).toBe('openai');
    expect(producer.model).toBe(`openai/${VENDOR_DEFAULT_CHAT_MODEL.openai}`);

    process.env.BRAIN_VENDOR = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    producer = resolveProducer('vendor', 'consolidate');
    expect(producer.model).toBe(`anthropic/${VENDOR_DEFAULT_CHAT_MODEL.anthropic}`);

    process.env.BRAIN_VENDOR = 'google';
    process.env.GOOGLE_API_KEY = 'g-test';
    producer = resolveProducer('vendor', 'consolidate');
    expect(producer.model).toBe(`google/${VENDOR_DEFAULT_CHAT_MODEL.google}`);

    process.env.BRAIN_VENDOR_MODEL = 'some-newer-model';
    expect(resolveProducer('vendor', 'consolidate').model).toBe('google/some-newer-model');
  });

  it('fails config resolution when a vendor tier has no vendor or no key', () => {
    process.env.BRAIN_AI = 'vendor';
    expect(() => resolveChatConfig('consolidate')).toThrow(/requires BRAIN_VENDOR/);

    process.env.BRAIN_VENDOR = 'spacemonkey';
    expect(() => resolveChatConfig('consolidate')).toThrow(/BRAIN_VENDOR must be one of/);

    process.env.BRAIN_VENDOR = 'anthropic';
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => resolveChatConfig('consolidate')).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('requires BRAIN_CHAT_MODEL for the remote tier', () => {
    process.env.BRAIN_AI = 'remote';
    process.env.BRAIN_ENDPOINT = 'http://127.0.0.1:1234/v1';
    expect(() => resolveChatConfig('consolidate')).toThrow(/requires BRAIN_CHAT_MODEL/);

    process.env.BRAIN_CHAT_MODEL = 'qwen3.5-9b';
    const cfg = resolveChatConfig('consolidate');
    expect(cfg.tier).toBe('remote');
    expect(cfg.model).toBe('qwen3.5-9b');
    expect(cfg.endpoint).toBe('http://127.0.0.1:1234/v1');
  });

  it('applies documented defaults for timeout, budget and breaker', () => {
    const cfg = resolveChatConfig('consolidate');
    expect(cfg.timeoutMs).toBe(60000);
    expect(cfg.maxTokens).toBe(2000);
    expect(cfg.breakerThreshold).toBe(3);
    expect(cfg.breakerCooldownMs).toBe(30000);
    expect(cfg.fallbackTiers).toEqual([]);

    process.env.BRAIN_CHAT_TIMEOUT_MS = '1500';
    process.env.BRAIN_CHAT_MAX_TOKENS = '9000';
    const tuned = resolveChatConfig('consolidate');
    expect(tuned.timeoutMs).toBe(1500);
    expect(tuned.maxTokens).toBe(9000);
  });

  it('builds a fallback chain of callable tiers only', () => {
    process.env.BRAIN_AI = 'remote';
    process.env.BRAIN_ENDPOINT = 'http://127.0.0.1:1234/v1';
    process.env.BRAIN_CHAT_MODEL = 'qwen3.5-9b';
    process.env.BRAIN_VENDOR = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.BRAIN_AI_FALLBACK = 'agent,remote,vendor,none';

    // 'agent' and 'none' are dropped: a worker cannot drive either.
    // 'remote' is dropped as the primary tier, leaving the vendor fallback.
    expect(resolveChatConfig('consolidate').fallbackTiers).toEqual(['vendor']);

    process.env.BRAIN_AI_FALLBACK = 'local';
    expect(() => resolveChatConfig('consolidate')).toThrow(/may not contain 'local'/);

    // An unresolvable fallback is dropped rather than failing the primary path.
    process.env.BRAIN_AI_FALLBACK = 'vendor';
    delete process.env.OPENAI_API_KEY;
    expect(resolveChatConfig('consolidate').fallbackTiers).toEqual([]);
  });

  it('describes resolved config without leaking a key', () => {
    process.env.BRAIN_AI = 'vendor';
    process.env.BRAIN_VENDOR = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-value';

    const described = JSON.stringify(describeAiConfig());
    expect(described).not.toContain('sk-ant-secret-value');
    expect(described).toContain('anthropic/');

    const report = describeAiConfig() as Record<string, any>;
    expect(report.generative_vendors).toEqual(['openai', 'anthropic', 'google']);
    expect(report.embedding_vendors).toEqual(['openai', 'google']);
    expect(report.consolidate.ok).toBe(true);
  });
});

describe('embedding vendor capability split', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('rejects BRAIN_EMBED=vendor + BRAIN_VENDOR=anthropic at config time', () => {
    process.env.BRAIN_EMBED = 'vendor';
    process.env.BRAIN_VENDOR = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    // The rejection happens while resolving the recipe — before any embed call
    // and with no network involved at all.
    let caught: unknown;
    try {
      resolveEmbedderRecipe();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(isEmbeddingConfigurationError(caught)).toBe(true);
    expect((caught as Error).message).toContain('Anthropic publishes no embeddings API');
    expect((caught as Error).message).toContain('openai and google');
  });

  it('still resolves the two vendors that do publish an embeddings API', () => {
    process.env.BRAIN_EMBED = 'vendor';

    process.env.BRAIN_VENDOR = 'google';
    expect(resolveEmbedderRecipe().embed_model).toBe('gemini-embedding-001');

    process.env.BRAIN_VENDOR = 'openai';
    expect(resolveEmbedderRecipe().embed_model).toBe('text-embedding-3-small');
  });

  it('allows anthropic for generative functions while the embedder is elsewhere', () => {
    process.env.BRAIN_EMBED = 'local';
    process.env.BRAIN_EMBED_MODEL = 'nomic';
    process.env.BRAIN_AI = 'vendor';
    process.env.BRAIN_VENDOR = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    expect(resolveEmbedderRecipe().embed_tier).toBe('local');
    expect(resolveChatConfig('consolidate').vendor).toBe('anthropic');
    expect(embeddingVendorRejection('anthropic')).toContain('no embeddings API');
    expect(embeddingVendorRejection('google')).toBeNull();
  });
});
