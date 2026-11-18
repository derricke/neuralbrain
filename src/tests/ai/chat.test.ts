import { resolveChatConfig } from '../../ai/config';
import { getBreakerStatus, resetCircuitBreakers } from '../../ai/circuitBreaker';
import { resetReasoningProbeCache, runChat } from '../../ai/chat';

const PROMPT = { system: 'SYSTEM', user: 'LOG' };

function okResponse(content: string, finishReason = 'stop') {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      model: 'wire-model',
      choices: [{ message: { content }, finish_reason: finishReason }],
    }),
    text: async () => content,
  } as unknown as Response;
}

function anthropicOk(content: string) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      model: 'claude-3-5-haiku-20241022',
      content: [{ type: 'text', text: content }],
      stop_reason: 'end_turn',
    }),
    text: async () => content,
  } as unknown as Response;
}

function errorResponse(status: number) {
  return {
    ok: false,
    status,
    statusText: 'Server Error',
    json: async () => ({}),
    text: async () => 'upstream exploded',
  } as unknown as Response;
}

describe('runChat: timeout, circuit breaker, fallback, attribution', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    // No real network, and no probe: the reasoning probe is reused for budget
    // sizing, so it must be explicitly off in tests.
    process.env.BRAIN_CHAT_PROBE = '0';
    process.env.BRAIN_AI = 'remote';
    process.env.BRAIN_ENDPOINT = 'http://127.0.0.1:9/v1';
    process.env.BRAIN_CHAT_MODEL = 'qwen3.5-9b';
    delete process.env.BRAIN_AI_FALLBACK;
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    resetCircuitBreakers();
    resetReasoningProbeCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    resetCircuitBreakers();
    resetReasoningProbeCache();
  });

  it("refuses to call a tier the brain cannot drive ('none' and 'agent')", async () => {
    process.env.BRAIN_AI = 'none';
    await expect(runChat('consolidate', PROMPT)).rejects.toThrow(/cannot call itself/);

    process.env.BRAIN_AI = 'agent';
    await expect(runChat('consolidate', PROMPT)).rejects.toThrow(/host agent does the work over MCP/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('attributes a successful reply to the producer that wrote it', async () => {
    process.env.BRAIN_AI = 'vendor';
    process.env.BRAIN_VENDOR = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    fetchMock.mockResolvedValue(anthropicOk('{"claims":[]}'));

    const completion = await runChat('consolidate', PROMPT);
    expect(completion.producer_tier).toBe('vendor');
    expect(completion.producer_model).toBe('anthropic/claude-3-5-haiku-20241022');
    expect(completion.content).toBe('{"claims":[]}');
    expect(completion.attempts).toEqual([
      { tier: 'vendor', model: 'anthropic/claude-3-5-haiku-20241022', ok: true },
    ]);

    // The vendor is sent the bare model name, not the vendor-prefixed label
    // that gets stored as producer_model.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('claude-3-5-haiku-20241022');
  });

  it('returns a 200 with useless content instead of throwing: the gate decides', async () => {
    fetchMock.mockResolvedValue(okResponse('', 'stop'));
    const completion = await runChat('consolidate', PROMPT);
    expect(completion.content).toBe('');
    expect(completion.finish_reason).toBe('stop');

    fetchMock.mockResolvedValue(okResponse('{"claims":[', 'length'));
    const truncated = await runChat('consolidate', PROMPT);
    expect(truncated.finish_reason).toBe('length');
  });

  it('aborts a hanging request at BRAIN_CHAT_TIMEOUT_MS', async () => {
    process.env.BRAIN_CHAT_TIMEOUT_MS = '25';
    fetchMock.mockImplementation(
      (_url: string, init: any) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })
    );

    await expect(runChat('consolidate', PROMPT)).rejects.toThrow(/every generative producer/);
    // A timeout is a dependency failure, so it counts against the breaker.
    expect(getBreakerStatus()[0].consecutive_failures).toBe(1);
  }, 15000);

  it('opens the circuit after the threshold and then fails fast without calling out', async () => {
    process.env.BRAIN_CHAT_BREAKER_THRESHOLD = '3';
    process.env.BRAIN_CHAT_BREAKER_COOLDOWN_MS = '60000';
    fetchMock.mockResolvedValue(errorResponse(502));

    for (let i = 0; i < 3; i++) {
      await expect(runChat('consolidate', PROMPT)).rejects.toThrow(/every generative producer/);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const status = getBreakerStatus();
    expect(status[0].open).toBe(true);
    expect(status[0].consecutive_failures).toBe(3);

    // Fails fast: a dead endpoint cannot stall the queue with more requests.
    await expect(runChat('consolidate', PROMPT)).rejects.toThrow(/circuit breaker open/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 20000);

  it('half-opens after the cooldown and closes on a success', async () => {
    process.env.BRAIN_CHAT_BREAKER_THRESHOLD = '2';
    process.env.BRAIN_CHAT_BREAKER_COOLDOWN_MS = '30';
    fetchMock.mockResolvedValue(errorResponse(500));

    await expect(runChat('consolidate', PROMPT)).rejects.toThrow();
    await expect(runChat('consolidate', PROMPT)).rejects.toThrow();
    expect(getBreakerStatus()[0].open).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 60));
    fetchMock.mockResolvedValue(okResponse('{"claims":[]}'));

    const completion = await runChat('consolidate', PROMPT);
    expect(completion.content).toBe('{"claims":[]}');
    expect(getBreakerStatus()[0].open).toBe(false);
    expect(getBreakerStatus()[0].consecutive_failures).toBe(0);
  }, 20000);

  it('falls back to the next tier on a transport failure and records who answered', async () => {
    process.env.BRAIN_AI_FALLBACK = 'vendor';
    process.env.BRAIN_VENDOR = 'google';
    process.env.GOOGLE_API_KEY = 'g-key';

    const cfg = resolveChatConfig('consolidate');
    expect(cfg.tier).toBe('remote');
    expect(cfg.fallbackTiers).toEqual(['vendor']);

    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('127.0.0.1:9')) return errorResponse(503);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          modelVersion: 'gemini-2.0-flash',
          candidates: [{ content: { parts: [{ text: '{"claims":[]}' }] }, finishReason: 'STOP' }],
        }),
        text: async () => '',
      } as unknown as Response;
    });

    const completion = await runChat('consolidate', PROMPT);
    // Rule 6 still holds through a fallback: the row records the producer that
    // actually wrote it, not the one that was configured first.
    expect(completion.producer_tier).toBe('vendor');
    expect(completion.producer_model).toBe('google/gemini-2.0-flash');
    expect(completion.attempts).toHaveLength(2);
    expect(completion.attempts[0]).toMatchObject({ tier: 'remote', ok: false });
    expect(completion.attempts[1]).toMatchObject({ tier: 'vendor', ok: true });
  }, 15000);

  it('reports every attempt when the whole chain fails, and dead-letters none of it', async () => {
    process.env.BRAIN_AI_FALLBACK = 'vendor';
    process.env.BRAIN_VENDOR = 'openai';
    process.env.OPENAI_API_KEY = 'sk-test';
    fetchMock.mockResolvedValue(errorResponse(500));

    let caught: any;
    try {
      await runChat('consolidate', PROMPT);
    } catch (err) {
      caught = err;
    }
    expect(caught.code).toBe('chat_unavailable');
    expect(caught.attempts).toHaveLength(2);
    expect(caught.message).toContain('never a dead letter');
  }, 15000);
});
