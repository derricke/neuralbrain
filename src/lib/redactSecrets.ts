/**
 * Redacts known API keys, tokens, private keys, and embedded credential URLs
 * from text before persistence or transport.
 */

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // PEM private key blocks
  {
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  // Anthropic API keys
  {
    pattern: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  // OpenAI project/service/admin/classic keys
  {
    pattern: /\bsk-(?:proj-|svcacct-|admin-)?[a-zA-Z0-9_-]{20,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  // Stripe keys
  {
    pattern: /\b(?:sk|rk)_(?:live|test)_[a-zA-Z0-9]{16,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  // Google / Gemini / Firebase API keys
  {
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  // GitHub tokens (classic & fine-grained PAT)
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    replacement: '[REDACTED_TOKEN]',
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: '[REDACTED_TOKEN]',
  },
  // AWS Access Key IDs
  {
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: '[REDACTED_AWS_KEY]',
  },
  // Slack tokens
  {
    pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    replacement: '[REDACTED_TOKEN]',
  },
  // HuggingFace, npm, PyPI, Groq, Perplexity, xAI, SendGrid
  {
    pattern: /\b(?:hf|npm|gsk|pplx|xai)_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    pattern: /\bpypi-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  // Authorization: Bearer <token>
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
    replacement: 'Bearer [REDACTED_TOKEN]',
  },
  // Database / service URLs with embedded passwords (scheme://user:pass@host)
  {
    pattern: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/]+:)[^@\s]+(@)/gi,
    replacement: '$1[REDACTED_PASSWORD]$2',
  },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function redactOptional(text: string | null | undefined): string | null {
  if (text === undefined || text === null) return null;
  return redactSecrets(text);
}
