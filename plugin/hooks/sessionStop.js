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
  const brainHome = getBrainHomeDir();
  const homeEnvCandidates = [path.join(brainHome, '.env')];
  const homeEnvUrl = readDotEnvValue('BRAIN_API_URL', homeEnvCandidates);
  if (homeEnvUrl && homeEnvUrl.trim()) {
    return homeEnvUrl.trim().replace(/\/$/, '');
  }
  const envOrHomePort =
    (process.env.PORT && process.env.PORT.trim()) ||
    readDotEnvValue('PORT', homeEnvCandidates);
  const envOrHomeHttps =
    (process.env.BRAIN_HTTPS && process.env.BRAIN_HTTPS.trim()) ||
    readDotEnvValue('BRAIN_HTTPS', homeEnvCandidates);
  if (envOrHomePort || envOrHomeHttps) {
    const port = envOrHomePort || '3737';
    const useHttps = envOrHomeHttps === '1' || envOrHomeHttps === 'true';
    return `${useHttps ? 'https' : 'http'}://127.0.0.1:${port}`;
  }
  const repoEnvCandidates = [path.join(__dirname, '../../.env')];
  const repoEnvUrl = readDotEnvValue('BRAIN_API_URL', repoEnvCandidates);
  if (repoEnvUrl && repoEnvUrl.trim()) {
    return repoEnvUrl.trim().replace(/\/$/, '');
  }
  const port = readDotEnvValue('PORT', repoEnvCandidates) || '3737';
  const httpsFlag = readDotEnvValue('BRAIN_HTTPS', repoEnvCandidates);
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
    const sanitizeSeg = (s) =>
      String(s || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    const normalizeSlug = (raw) =>
      String(raw || '')
        .trim()
        .replace(/\/+$/, '')
        .replace(/\/{2,}/g, '/')
        .split('/')
        .map((seg) => seg.trim().toLowerCase().replace(/\s+/g, '-'))
        .filter(Boolean)
        .join('/');

    const startDir = path.resolve(cwd || process.cwd());
    const homeDir = path.resolve(os.homedir());
    const homePrefix = homeDir.endsWith(path.sep) ? homeDir : homeDir + path.sep;
    const stopAtHome = startDir === homeDir || startDir.startsWith(homePrefix);

    let current = startDir;
    for (;;) {
      for (const name of ['.brainrc', '.brain.json']) {
        const fp = path.join(current, name);
        if (fs.existsSync(fp)) {
          const raw = fs.readFileSync(fp, 'utf-8');
          let slug = null;
          let autoSubproject = false;
          let maxDepth;
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
              slug = parsed.project_id || parsed.projectId || parsed.project || null;
              autoSubproject = Boolean(parsed.auto_subproject ?? parsed.autoSubproject);
              const rawMaxDepth = parsed.max_depth ?? parsed.maxDepth;
              if (typeof rawMaxDepth === 'number' && Number.isInteger(rawMaxDepth) && rawMaxDepth > 0) {
                maxDepth = rawMaxDepth;
              }
            } else if (typeof parsed === 'string') {
              slug = parsed;
            }
          } catch {
            if (raw.trim()) slug = raw.trim();
          }

          if (slug && typeof slug === 'string') {
            const baseSlug = normalizeSlug(slug);
            if (baseSlug) {
              if (autoSubproject && startDir !== current) {
                const rel = path.relative(current, startDir);
                let segments = rel
                  .split(path.sep)
                  .map(sanitizeSeg)
                  .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
                if (maxDepth !== undefined) {
                  segments = segments.slice(0, maxDepth);
                }
                if (segments.length > 0) {
                  return `${baseSlug}/${segments.join('/')}`;
                }
              }
              return baseSlug;
            }
          }
        }
      }
      if (stopAtHome && current === homeDir) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    const base = path.basename(startDir);
    return sanitizeSeg(base) || null;
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

async function runSessionStop(inputObj = {}, options = {}) {
  try {
    const sessionId =
      inputObj?.conversationId ||
      inputObj?.session_id ||
      inputObj?.sessionId ||
      null;

    const isError = Boolean(inputObj?.error);
    const success = isError ? 0 : 1;

    const cwd =
      options.cwd ||
      inputObj.cwd ||
      (Array.isArray(inputObj.workspacePaths) && inputObj.workspacePaths[0]) ||
      process.cwd();
    const projectId = options.projectId || resolveSessionProject(sessionId, cwd, options);
    const scope = projectId ? 'project' : 'unknown';

    const payload = {
      session_id: sessionId,
      scope,
      project_id: projectId || undefined,
      rollup_source: 'signalled',
      description: 'Agent session completed',
      success,
    };

    const apiUrl = resolveApiUrl(options);
    const apiKey = resolveApiKey(options);
    const fetchFn = options.fetchFn || getHookFetch();

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    try {
      await fetchFn(`${apiUrl}/capture/trajectories`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(2500),
      });
    } catch {
      // Safe non-blocking fallback
    }

    // Only end the session on Stop when an error occurred; normal turn stops
    // leave the session 'active' so multi-turn conversations stay live until
    // closed explicitly or swept after idling.
    if (sessionId && isError) {
      try {
        await fetchFn(`${apiUrl}/sessions/${encodeURIComponent(sessionId)}/end`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            status: 'abandoned',
            success,
            project_id: projectId || undefined,
            scope,
          }),
          signal: AbortSignal.timeout(2500),
        });
      } catch {
        // Safe non-blocking fallback
      }
    }

    // Flush any spooled items
    try {
      const spoolModule = loadHelperModule('spool');
      if (spoolModule && typeof spoolModule.flushSpool === 'function') {
        await spoolModule.flushSpool(async (endpoint, spooledPayload) => {
          const res = await fetchFn(`${apiUrl}${endpoint}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(spooledPayload),
            signal: AbortSignal.timeout(2500),
          });
          return res.ok;
        });
      }
    } catch {
      // Safe non-blocking fallback
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
      const output = await runSessionStop(input);
      console.log(JSON.stringify(output || {}));
    } catch {
      console.log(JSON.stringify({}));
    }
    process.exit(0);
  })();
}

module.exports = {
  runSessionStop,
  readDotEnvValue,
  resolveApiKey,
  resolveApiUrl,
  resolveProjectId,
  resolveSessionProject,
};
