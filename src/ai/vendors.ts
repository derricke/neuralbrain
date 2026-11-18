/**
 * The generative adapters: three cloud vendors plus the OpenAI-compatible
 * `remote` tier, all behind one interface.
 *
 * Every adapter speaks raw `fetch` rather than a vendor SDK, for three
 * reasons: the request and response shapes are the thing being adapted and are
 * clearer written out; there is exactly one timeout and one error path to
 * audit; and tests mock `fetch` instead of a client object.
 *
 * An adapter's job stops at returning the text. It never parses the model's
 * JSON, never repairs it and never decides whether it is acceptable — that is
 * the verification gate's job, and the gate runs on every producer, vendor
 * included (docs/CONTRACTS.md).
 */

import { VENDOR_API_KEY_ENV } from './config';
import type { VendorName } from '../learning/types';

export interface ChatRequest {
  system: string;
  user: string;
  model: string;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ChatReply {
  /** The model's text. '' when the provider returned no content at all. */
  content: string;
  /**
   * Normalised across vendors: 'length' whenever the response was cut off by
   * the token budget, whatever each vendor calls it. The gate keys its
   * `truncated` rejection off exactly this value.
   */
  finish_reason: string | null;
  /** The model id the provider says answered, when it reports one. */
  model: string | null;
  /** Reasoning/thinking tokens the provider reports, 0 when it reports none. */
  reasoning_tokens: number;
}

export interface GenerativeAdapter {
  readonly name: string;
  complete(req: ChatRequest): Promise<ChatReply>;
}

export class ChatTransportError extends Error {
  readonly code = 'chat_transport_error';
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ChatTransportError';
    this.status = status;
  }
}

export function isChatTransportError(error: unknown): error is ChatTransportError {
  return error instanceof ChatTransportError;
}

function requireKey(vendor: VendorName): string {
  const envName = VENDOR_API_KEY_ENV[vendor];
  const key = process.env[envName]?.trim();
  if (!key) {
    throw new ChatTransportError(`${envName} is required for BRAIN_VENDOR=${vendor}`);
  }
  return key;
}

/**
 * Strips/redacts sensitive query parameters (e.g., key, api_key, token, auth, secret)
 * from a URL so credentials cannot leak into error messages, logs, or HTTP responses.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const sensitive = ['key', 'api_key', 'token', 'auth', 'secret'];
    for (const param of sensitive) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '[REDACTED]');
      }
    }
    return parsed.toString();
  } catch {
    return url.replace(/([?&](?:key|api_key|token|auth|secret)=)[^&]*/gi, '$1[REDACTED]');
  }
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal
): Promise<any> {
  const safeUrl = redactUrl(url);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new ChatTransportError(`request to ${safeUrl} aborted (timeout)`);
    }
    throw new ChatTransportError(
      `request to ${safeUrl} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {
      detail = '';
    }
    throw new ChatTransportError(
      `${safeUrl} returned ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`,
      response.status
    );
  }

  try {
    return await response.json();
  } catch (err) {
    // A 200 whose body is not JSON at all is a transport fault, not a model
    // producing bad output: there is no model text to attribute it to.
    throw new ChatTransportError(
      `${safeUrl} returned a non-JSON body: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Shared by the `openai` vendor and by the `remote` tier. */
function readOpenAiCompatibleReply(json: any): ChatReply {
  const choice = json?.choices?.[0];
  const message = choice?.message ?? {};
  const content = typeof message.content === 'string' ? message.content : '';
  const reasoning =
    json?.usage?.completion_tokens_details?.reasoning_tokens ??
    json?.usage?.reasoning_tokens ??
    (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0 ? 1 : 0);

  return {
    content,
    finish_reason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    model: typeof json?.model === 'string' ? json.model : null,
    reasoning_tokens: Number(reasoning) || 0,
  };
}

/** OpenAI-compatible chat completions: the `remote` tier (LM Studio, Ollama, vLLM). */
export function createRemoteAdapter(endpoint: string): GenerativeAdapter {
  const base = endpoint.replace(/\/$/, '');
  return {
    name: `remote:${base}`,
    async complete(req: ChatRequest): Promise<ChatReply> {
      const apiKey = process.env.BRAIN_ENDPOINT_API_KEY?.trim() || 'no-key';
      const json = await postJson(
        `${base}/chat/completions`,
        { Authorization: `Bearer ${apiKey}` },
        {
          model: req.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          max_tokens: req.maxTokens,
          temperature: 0,
        },
        req.signal
      );
      return readOpenAiCompatibleReply(json);
    },
  };
}

export function createOpenAiAdapter(): GenerativeAdapter {
  return {
    name: 'vendor:openai',
    async complete(req: ChatRequest): Promise<ChatReply> {
      const json = await postJson(
        'https://api.openai.com/v1/chat/completions',
        { Authorization: `Bearer ${requireKey('openai')}` },
        {
          model: req.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          max_tokens: req.maxTokens,
          temperature: 0,
        },
        req.signal
      );
      return readOpenAiCompatibleReply(json);
    },
  };
}

export function createAnthropicAdapter(): GenerativeAdapter {
  return {
    name: 'vendor:anthropic',
    async complete(req: ChatRequest): Promise<ChatReply> {
      // Anthropic's shape differs from OpenAI's in two ways that matter here:
      // the system prompt is a top-level field rather than a message, and the
      // reply is a content block array.
      const json = await postJson(
        'https://api.anthropic.com/v1/messages',
        {
          'x-api-key': requireKey('anthropic'),
          'anthropic-version': '2023-06-01',
        },
        {
          model: req.model,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          max_tokens: req.maxTokens,
          temperature: 0,
        },
        req.signal
      );

      const blocks = Array.isArray(json?.content) ? json.content : [];
      const firstText = blocks.find((b: any) => b?.type === 'text' && typeof b.text === 'string');
      const content = typeof firstText?.text === 'string' ? firstText.text : '';

      const stopReason = typeof json?.stop_reason === 'string' ? json.stop_reason : null;
      return {
        content,
        // 'max_tokens' is Anthropic's name for OpenAI's 'length'.
        finish_reason: stopReason === 'max_tokens' ? 'length' : stopReason,
        model: typeof json?.model === 'string' ? json.model : null,
        reasoning_tokens: blocks.some((b: any) => b?.type === 'thinking') ? 1 : 0,
      };
    },
  };
}

export function createGoogleAdapter(): GenerativeAdapter {
  return {
    name: 'vendor:google',
    async complete(req: ChatRequest): Promise<ChatReply> {
      const key = requireKey('google');
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}` +
        `:generateContent?key=${encodeURIComponent(key)}`;

      const json = await postJson(
        url,
        { 'x-goog-api-key': key },
        {
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          generationConfig: { maxOutputTokens: req.maxTokens, temperature: 0 },
        },
        req.signal
      );

      const candidate = json?.candidates?.[0];
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      const content = parts
        .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
        .join('');

      const finishReason =
        typeof candidate?.finishReason === 'string' ? candidate.finishReason : null;
      return {
        content,
        // 'MAX_TOKENS' is Google's name for OpenAI's 'length'.
        finish_reason: finishReason === 'MAX_TOKENS' ? 'length' : finishReason,
        model: typeof json?.modelVersion === 'string' ? json.modelVersion : null,
        reasoning_tokens: Number(json?.usageMetadata?.thoughtsTokenCount) || 0,
      };
    },
  };
}

export function createVendorAdapter(vendor: VendorName): GenerativeAdapter {
  switch (vendor) {
    case 'openai':
      return createOpenAiAdapter();
    case 'anthropic':
      return createAnthropicAdapter();
    case 'google':
      return createGoogleAdapter();
  }
}
