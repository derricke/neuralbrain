import {
  createAnthropicAdapter,
  createGoogleAdapter,
  createOpenAiAdapter,
  createRemoteAdapter,
  createVendorAdapter,
  isChatTransportError,
} from '../../ai/vendors';

const EXTRACTION_JSON = JSON.stringify({
  files_touched: ['src/app.ts'],
  error_verbatim: null,
  claims: [{ text: 'src/app.ts was edited', source_ids: ['obs_1'] }],
});

function jsonResponse(body: unknown, init?: { status?: number; statusText?: string }) {
  return {
    ok: (init?.status ?? 200) < 400,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('generative vendor adapters', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.GOOGLE_API_KEY = 'g-key-test';
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  const request = {
    system: 'SYSTEM PROMPT',
    user: 'OBSERVATION LOG',
    model: 'test-model',
    maxTokens: 1234,
  };

  it('posts OpenAI chat completions with a bearer key and reads choices[0]', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        model: 'gpt-4o-mini-2024-07-18',
        choices: [{ message: { content: EXTRACTION_JSON }, finish_reason: 'stop' }],
        usage: { completion_tokens_details: { reasoning_tokens: 0 } },
      })
    );

    const reply = await createOpenAiAdapter().complete(request);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-openai-test');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('test-model');
    expect(body.max_tokens).toBe(1234);
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'OBSERVATION LOG' },
    ]);

    expect(reply.content).toBe(EXTRACTION_JSON);
    expect(reply.finish_reason).toBe('stop');
    expect(reply.model).toBe('gpt-4o-mini-2024-07-18');
    expect(reply.reasoning_tokens).toBe(0);
  });

  it('posts Anthropic messages with a top-level system field and reads content[0].text', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        model: 'claude-3-5-haiku-20241022',
        content: [{ type: 'text', text: EXTRACTION_JSON }],
        stop_reason: 'end_turn',
      })
    );

    const reply = await createAnthropicAdapter().complete(request);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers.Authorization).toBeUndefined();

    const body = JSON.parse(init.body);
    // The shape difference that matters: system is top-level, not a message.
    expect(body.system).toBe('SYSTEM PROMPT');
    expect(body.messages).toEqual([{ role: 'user', content: 'OBSERVATION LOG' }]);
    expect(body.max_tokens).toBe(1234);

    expect(reply.content).toBe(EXTRACTION_JSON);
    expect(reply.finish_reason).toBe('end_turn');
    expect(reply.model).toBe('claude-3-5-haiku-20241022');
  });

  it("normalises Anthropic's max_tokens stop reason to 'length'", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        content: [{ type: 'text', text: '{"claims":[' }],
        stop_reason: 'max_tokens',
      })
    );

    const reply = await createAnthropicAdapter().complete(request);
    expect(reply.finish_reason).toBe('length');
  });

  it('posts Google generateContent with the key in the query and reads candidates[0]', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        modelVersion: 'gemini-2.0-flash',
        candidates: [{ content: { parts: [{ text: EXTRACTION_JSON }] }, finishReason: 'STOP' }],
        usageMetadata: { thoughtsTokenCount: 0 },
      })
    );

    const reply = await createGoogleAdapter().complete(request);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent?key=g-key-test'
    );
    const body = JSON.parse(init.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYSTEM PROMPT' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'OBSERVATION LOG' }] }]);
    expect(body.generationConfig.maxOutputTokens).toBe(1234);

    expect(reply.content).toBe(EXTRACTION_JSON);
    expect(reply.finish_reason).toBe('STOP');
    expect(reply.model).toBe('gemini-2.0-flash');
  });

  it("normalises Google's MAX_TOKENS finish reason to 'length'", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '{' }] }, finishReason: 'MAX_TOKENS' }],
      })
    );
    expect((await createGoogleAdapter().complete(request)).finish_reason).toBe('length');
  });

  it('posts the remote tier to BRAIN_ENDPOINT/chat/completions', async () => {
    process.env.BRAIN_ENDPOINT = 'http://gpubox.lan:1234/v1/';
    process.env.BRAIN_ENDPOINT_API_KEY = 'lm-studio';
    fetchMock.mockResolvedValue(
      jsonResponse({
        model: 'qwen3.5-9b',
        choices: [{ message: { content: EXTRACTION_JSON }, finish_reason: 'stop' }],
      })
    );

    const reply = await createRemoteAdapter(process.env.BRAIN_ENDPOINT).complete(request);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://gpubox.lan:1234/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer lm-studio');
    expect(reply.content).toBe(EXTRACTION_JSON);
  });

  it('reports reasoning tokens so the budget can be sized from what the endpoint does', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: '' }, finish_reason: 'stop' }],
        usage: { completion_tokens_details: { reasoning_tokens: 5820 } },
      })
    );
    const reply = await createRemoteAdapter('http://127.0.0.1:1234/v1').complete(request);
    expect(reply.reasoning_tokens).toBe(5820);
    // The observed failure mode: 200 OK, finish_reason 'stop', zero content.
    expect(reply.content).toBe('');
  });

  it('surfaces an empty reply as empty content rather than throwing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ content: [], stop_reason: 'end_turn' }));
    const reply = await createAnthropicAdapter().complete(request);
    expect(reply.content).toBe('');
  });

  it('raises a transport error on a non-2xx response, carrying the status', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: 'rate limited' } }, { status: 429, statusText: 'Too Many Requests' })
    );

    let caught: unknown;
    try {
      await createOpenAiAdapter().complete(request);
    } catch (err) {
      caught = err;
    }
    expect(isChatTransportError(caught)).toBe(true);
    expect((caught as any).status).toBe(429);
  });

  it('raises a transport error when a 200 body is not JSON at all', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new Error('Unexpected token < in JSON');
      },
      text: async () => '<html>proxy error</html>',
    } as unknown as Response);

    await expect(createGoogleAdapter().complete(request)).rejects.toThrow(/non-JSON body/);
  });

  it('requires the vendor key before making any request', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(createAnthropicAdapter().complete(request)).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps each vendor name to its adapter', () => {
    expect(createVendorAdapter('openai').name).toBe('vendor:openai');
    expect(createVendorAdapter('anthropic').name).toBe('vendor:anthropic');
    expect(createVendorAdapter('google').name).toBe('vendor:google');
  });
});
