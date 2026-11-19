#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const tls = require('tls');

const warnedHelperFailures = new Set();
function loadHelperModule(relName) {
  const candidates = [
    path.join(__dirname, 'lib', relName),
    path.join(__dirname, '../../dist/lib', relName),
  ];
  let lastErr;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr && !warnedHelperFailures.has(relName)) {
    warnedHelperFailures.add(relName);
    process.stderr.write(
      `[neuralbrain-hook] warning: failed to load helper '${relName}': ${lastErr.message || lastErr}\n`
    );
  }
  return null;
}

function getHookFetch() {
  const tlsMod = loadHelperModule('tls');
  if (tlsMod && typeof tlsMod.createLocalTlsFetch === 'function') {
    return tlsMod.createLocalTlsFetch();
  }
  return async (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsedUrl = new URL(rawUrl);
    const host = parsedUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const explicitCert = process.env.BRAIN_TLS_CERT && process.env.BRAIN_TLS_CERT.trim();
    const certPath = explicitCert || path.join(getBrainHomeDir(), 'certs', 'server.crt');
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    if (parsedUrl.protocol !== 'https:' || (!explicitCert && !isLoopback) || !fs.existsSync(certPath)) {
      return globalThis.fetch(input, init);
    }
    const ca = [...tls.rootCertificates, fs.readFileSync(certPath, 'utf8')];
    const bodyBuffer = typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : init.body;
    const headers = { ...(init.headers || {}) };
    if (bodyBuffer && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = String(Buffer.byteLength(bodyBuffer));
    }
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 443,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          method: init.method || 'GET',
          headers,
          ca,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
          res.on('end', () => {
            const status = res.statusCode ?? 200;
            const resHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) v.forEach((item) => resHeaders.append(k, item));
              else if (v !== undefined) resHeaders.set(k, v);
            }
            const empty = status === 101 || status === 204 || status === 205 || status === 304;
            resolve(new Response(empty ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage || '', headers: resHeaders }));
          });
        }
      );
      if (init.signal) {
        if (init.signal.aborted) {
          req.destroy();
          reject(init.signal.reason || new Error('Aborted'));
          return;
        }
        init.signal.addEventListener('abort', () => {
          req.destroy();
          reject(init.signal.reason || new Error('Aborted'));
        }, { once: true });
      }
      req.on('error', reject);
      if (bodyBuffer) req.write(bodyBuffer);
      req.end();
    });
  };
}

function getBrainHomeDir() {
  const envHome = process.env.BRAIN_HOME && process.env.BRAIN_HOME.trim();
  if (envHome) {
    if (envHome === '~') return os.homedir();
    if (envHome.startsWith('~/') || envHome.startsWith('~\\')) {
      return path.join(os.homedir(), envHome.slice(2));
    }
    return path.resolve(envHome);
  }
  return path.join(os.homedir(), '.neuralbrain');
}

function readDotEnvValue(key, envCandidates) {
  const brainHome = getBrainHomeDir();
  const candidates = envCandidates || [
    path.join(brainHome, '.env'),
    path.join(__dirname, '../../.env'),
  ];
  for (const envFilePath of candidates) {
    try {
      if (fs.existsSync(envFilePath)) {
        const content = fs.readFileSync(envFilePath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx !== -1) {
            const varName = trimmed.slice(0, eqIdx).trim();
            if (varName === key) {
              let val = trimmed.slice(eqIdx + 1).trim();
              if (
                (val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))
              ) {
                val = val.slice(1, -1);
              }
              if (val) return val;
            }
          }
        }
      }
    } catch {
      // Ignore read errors
    }
  }
  return undefined;
}

function readApiKeyFile(keyPath) {
  try {
    if (fs.existsSync(keyPath)) {
      const content = fs.readFileSync(keyPath, 'utf-8').trim();
      if (content) return content;
    }
  } catch {
    // Ignore read errors
  }
  return undefined;
}

function resolveApiKey(options) {
  if (options && options.apiKey && typeof options.apiKey === 'string' && options.apiKey.trim()) {
    return options.apiKey.trim();
  }
  if (process.env.BRAIN_API_KEY && process.env.BRAIN_API_KEY.trim()) {
    return process.env.BRAIN_API_KEY.trim();
  }
  const brainHome = getBrainHomeDir();
  const homeEnvKey = readDotEnvValue('BRAIN_API_KEY', [path.join(brainHome, '.env')]);
  if (homeEnvKey && homeEnvKey.trim()) {
    return homeEnvKey.trim();
  }
  const homeKeyFile = readApiKeyFile(path.join(brainHome, 'data', 'api-key.txt'));
  if (homeKeyFile) {
    return homeKeyFile;
  }
  const repoEnvKey = readDotEnvValue('BRAIN_API_KEY', [path.join(__dirname, '../../.env')]);
  if (repoEnvKey && repoEnvKey.trim()) {
    return repoEnvKey.trim();
  }
  return readApiKeyFile(path.join(__dirname, '../../data/api-key.txt'));
}

function resolveApiUrl(options) {
  if (options && options.apiUrl && typeof options.apiUrl === 'string' && options.apiUrl.trim()) {
    return options.apiUrl.trim().replace(/\/$/, '');
  }
  if (process.env.BRAIN_API_URL && process.env.BRAIN_API_URL.trim()) {
    return process.env.BRAIN_API_URL.trim().replace(/\/$/, '');
  }
  const dotEnvUrl = readDotEnvValue('BRAIN_API_URL');
  if (dotEnvUrl && dotEnvUrl.trim()) {
    return dotEnvUrl.trim().replace(/\/$/, '');
  }
  const port =
    (process.env.PORT && process.env.PORT.trim()) ||
    readDotEnvValue('PORT') ||
    '3737';
  const httpsFlag =
    (process.env.BRAIN_HTTPS && process.env.BRAIN_HTTPS.trim()) ||
    readDotEnvValue('BRAIN_HTTPS');
  const useHttps = httpsFlag === '1' || httpsFlag === 'true';
  return `${useHttps ? 'https' : 'http'}://127.0.0.1:${port}`;
}

function resolveProjectId(cwd) {
  try {
    const slugModule = loadHelperModule('projectSlug');
    if (slugModule && typeof slugModule.resolveCanonicalProjectId === 'function') {
      const resolved = slugModule.resolveCanonicalProjectId({ cwd, fallbackToDirname: true });
      if (resolved) return resolved;
    }
  } catch {
    // Fall back to in-line resolution
  }

  try {
    let current = path.resolve(cwd || process.cwd());
    for (;;) {
      for (const name of ['.brainrc', '.brain.json']) {
        const fp = path.join(current, name);
        if (fs.existsSync(fp)) {
          const raw = fs.readFileSync(fp, 'utf-8');
          try {
            const parsed = JSON.parse(raw);
            const val = parsed.project_id || parsed.projectId || parsed.project;
            if (val && typeof val === 'string') return val.trim().toLowerCase();
          } catch {
            if (raw.trim()) return raw.trim().toLowerCase();
          }
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    const base = path.basename(path.resolve(cwd || process.cwd()));
    return base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || null;
  } catch {
    return null;
  }
}

/**
 * The project for this event, fixed per session: the first event of a session
 * resolves it from the project root and pins it, so later events stay in the
 * same project even after the agent changes into a subfolder (see
 * resolveSessionProjectId in src/lib/projectSlug.ts).
 */
function resolveSessionProject(sessionId, cwd, options = {}) {
  try {
    const slugModule = loadHelperModule('projectSlug');
    if (slugModule && typeof slugModule.resolveSessionProjectId === 'function') {
      return slugModule.resolveSessionProjectId({ sessionId, cwd, pinDir: options.pinDir });
    }
  } catch {
    // Fall back to per-event resolution
  }
  return resolveProjectId(cwd);
}

function safeAppendSpool(endpoint, payload) {
  try {
    const spoolModule = loadHelperModule('spool');
    if (spoolModule && typeof spoolModule.appendSpool === 'function') {
      spoolModule.appendSpool(endpoint, payload);
      return;
    }
  } catch {
    // Fall back to direct file append
  }

  try {
    const spoolDir = path.join(getBrainHomeDir(), 'spool');
    if (!fs.existsSync(spoolDir)) {
      fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
    }
    const spoolFile = path.join(spoolDir, 'spool.jsonl');
    const entry = {
      id: `${endpoint}:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      endpoint,
      payload,
      timestamp: Math.floor(Date.now() / 1000),
      attempts: 0,
    };
    fs.appendFileSync(spoolFile, JSON.stringify(entry) + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Non-blocking
  }
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    process.stdin.on('error', () => {
      resolve({});
    });
  });
}

const SUCCESS_OUTPUT_PREVIEW_CHARS = 256;
const FAILURE_OUTPUT_TAIL_CHARS = 2000;
const MAX_INPUT_CHARS = 1500;

const IGNORED_TOOLS = new Set([
  'todowrite',
  'todoread',
  'taskcreate',
  'taskupdate',
  'tasklist',
  'taskget',
  'taskoutput',
  'taskstop',
  'askuserquestion',
  'ask_question',
  'enterplanmode',
  'exitplanmode',
]);

const SHELL_TOOLS = new Set([
  'bash',
  'run_command',
  'shell',
  'execute_command',
  'terminal',
]);

const FALLBACK_SECRET_PATTERNS = [
  [/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]'],
  [/\bsk-(?:proj-|svcacct-|admin-)?[a-zA-Z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]'],
  [/\b(?:sk|rk)_(?:live|test)_[a-zA-Z0-9]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED_API_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_TOKEN]'],
  [/\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, '[REDACTED_TOKEN]'],
  [/\b(?:hf|npm|gsk|pplx|xai)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_API_KEY]'],
  [/\bpypi-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]'],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, 'Bearer [REDACTED_TOKEN]'],
  [/\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/]+:)[^@\s]+(@)/gi, '$1[REDACTED_PASSWORD]$2'],
];

let cachedRedactFn = null;
function redactHookSecrets(text) {
  if (!text) return text;
  if (!cachedRedactFn) {
    const mod = loadHelperModule('redactSecrets');
    if (mod && typeof mod.redactSecrets === 'function') {
      cachedRedactFn = mod.redactSecrets;
    }
    if (!cachedRedactFn) {
      cachedRedactFn = (value) => {
        let out = value;
        for (const [pattern, replacement] of FALLBACK_SECRET_PATTERNS) {
          out = out.replace(pattern, replacement);
        }
        return out;
      };
    }
  }
  return cachedRedactFn(text);
}

function shouldSkipTool(toolName) {
  if (!toolName) return false;
  const lower = String(toolName).toLowerCase();
  if (lower.startsWith('brain_') || lower.includes('brain_')) return true;
  if (lower.startsWith('memory_') || lower.includes('memory_')) return true;
  const baseName = lower.split('__').pop();
  return IGNORED_TOOLS.has(lower) || IGNORED_TOOLS.has(baseName);
}

function stripHeredocs(cmd) {
  // Replace multi-line heredoc bodies (<<EOF ... EOF) so inline scripts/files don't bloat observations
  return cmd.replace(/<<-?\s*(['"]?)([A-Za-z0-9_]+)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (match, _q, tag) => {
    const firstLineEnd = match.indexOf('\n');
    const header = firstLineEnd === -1 ? match : match.slice(0, firstLineEnd);
    return `${header} [heredoc ${tag} omitted]`;
  });
}

function formatObservationInput(toolName, args) {
  const lowerTool = String(toolName || '').toLowerCase();
  let text;

  if (SHELL_TOOLS.has(lowerTool) && args && typeof args === 'object') {
    const cmd = args.command ?? args.CommandLine ?? args.cmd;
    if (typeof cmd === 'string') {
      text = JSON.stringify({ command: stripHeredocs(cmd) });
    }
  }

  if (text === undefined) {
    text = typeof args === 'string' ? args : JSON.stringify(args);
  }
  if (text === undefined || text === null) {
    return '';
  }
  if (text.length <= MAX_INPUT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_INPUT_CHARS)}... [truncated ${text.length - MAX_INPUT_CHARS} chars]`;
}

function formatObservationOutput(rawOutput, isFailed, explicitError) {
  let text = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
  if (text === undefined || text === null) {
    text = '';
  }

  if (isFailed) {
    if (typeof explicitError === 'string' && explicitError.trim() && !text.includes(explicitError.trim())) {
      text = text ? `${text}\n${explicitError.trim()}` : explicitError.trim();
    }
    if (text.length <= FAILURE_OUTPUT_TAIL_CHARS) {
      return text;
    }
    return `...[truncated ${text.length - FAILURE_OUTPUT_TAIL_CHARS} chars]...\n${text.slice(-FAILURE_OUTPUT_TAIL_CHARS)}`;
  }

  if (text.length <= SUCCESS_OUTPUT_PREVIEW_CHARS) {
    return text;
  }
  return `${text.slice(0, SUCCESS_OUTPUT_PREVIEW_CHARS)}... [truncated ${text.length - SUCCESS_OUTPUT_PREVIEW_CHARS} chars]`;
}

async function runPostToolUse(inputObj = {}, options = {}) {
  try {
    const toolName =
      inputObj?.toolCall?.name ||
      inputObj?.tool_name ||
      inputObj?.name ||
      '';

    // Ignore brain_*, legacy memory_*, and noisy bookkeeping tools
    if (shouldSkipTool(toolName)) {
      return {};
    }

    const args =
      inputObj?.toolCall?.args ||
      inputObj?.tool_input ||
      inputObj?.input ||
      {};
    const inputStr = redactHookSecrets(formatObservationInput(toolName, args));

    const rawOutput =
      inputObj?.output !== undefined
        ? inputObj.output
        : inputObj?.tool_response !== undefined
        ? inputObj.tool_response
        : inputObj?.response !== undefined
        ? inputObj.response
        : inputObj?.error !== undefined
        ? String(inputObj.error)
        : '';
    const isFailed = Boolean(inputObj?.error || inputObj?.failed);
    const failed = isFailed ? 1 : 0;
    const outputStr = redactHookSecrets(formatObservationOutput(rawOutput, isFailed, inputObj?.error));

    const filePath =
      args?.Path ||
      args?.file_path ||
      args?.path ||
      inputObj?.filePath ||
      inputObj?.file_path ||
      null;

    const sessionId =
      inputObj?.conversationId ||
      inputObj?.session_id ||
      inputObj?.sessionId ||
      null;

    const cwd =
      options.cwd ||
      inputObj.cwd ||
      (Array.isArray(inputObj.workspacePaths) && inputObj.workspacePaths[0]) ||
      process.cwd();
    const projectId = options.projectId || resolveSessionProject(sessionId, cwd, options);
    const scope = projectId ? 'project' : 'unknown';

    const payload = {
      kind: 'tool_call',
      tool_name: toolName || 'unknown_tool',
      file_path: filePath ? String(filePath) : null,
      input: inputStr,
      output: outputStr,
      failed,
      session_id: sessionId,
      scope,
      project_id: projectId || undefined,
    };

    const apiUrl = resolveApiUrl(options);
    const apiKey = resolveApiKey(options);
    const fetchFn = options.fetchFn || getHookFetch();

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    try {
      const res = await fetchFn(`${apiUrl}/capture/observations`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2500),
      });

      if (!res.ok) {
        safeAppendSpool('/capture/observations', payload);
      }
    } catch {
      safeAppendSpool('/capture/observations', payload);
    }

    return {};
  } catch {
    return {};
  }
}

if (require.main === module) {
  (async () => {
    try {
      const input = await readStdin();
      const output = await runPostToolUse(input);
      console.log(JSON.stringify(output || {}));
    } catch {
      console.log(JSON.stringify({}));
    }
    process.exit(0);
  })();
}

module.exports = {
  runPostToolUse,
  shouldSkipTool,
  formatObservationInput,
  formatObservationOutput,
  redactHookSecrets,
  SUCCESS_OUTPUT_PREVIEW_CHARS,
  FAILURE_OUTPUT_TAIL_CHARS,
  MAX_INPUT_CHARS,
  readDotEnvValue,
  resolveApiKey,
  resolveApiUrl,
  resolveProjectId,
  safeAppendSpool,
};
