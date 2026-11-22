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

async function runSessionStart(inputObj = {}, options = {}) {
  try {
    const cwd =
      options.cwd ||
      inputObj.cwd ||
      (Array.isArray(inputObj.workspacePaths) && inputObj.workspacePaths[0]) ||
      process.cwd();

    const sessionId =
      inputObj?.conversationId ||
      inputObj?.session_id ||
      inputObj?.sessionId ||
      undefined;
    const projectId = options.projectId || resolveSessionProject(sessionId, cwd, options);
    const scope = projectId ? 'project' : 'unknown';
    const agentName =
      inputObj?.agent_name ||
      inputObj?.agent ||
      process.env.BRAIN_AGENT_NAME ||
      (inputObj?.transcript_path && String(inputObj.transcript_path).includes('.claude')
        ? 'claude'
        : inputObj?.conversationId
          ? 'antigravity'
          : 'unknown');

    const apiUrl = resolveApiUrl(options);
    const apiKey = resolveApiKey(options);
    const fetchFn = options.fetchFn || getHookFetch();

    const headers = { Accept: 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Non-blocking session registration
    try {
      const postHeaders = { 'Content-Type': 'application/json' };
      if (apiKey) {
        postHeaders['Authorization'] = `Bearer ${apiKey}`;
      }
      await fetchFn(`${apiUrl}/sessions/start`, {
        method: 'POST',
        headers: postHeaders,
        body: JSON.stringify({
          id: sessionId,
          project_id: projectId || undefined,
          scope,
          agent_name: agentName,
          cwd,
        }),
        signal: AbortSignal.timeout(1500),
      });
    } catch {
      // Non-blocking if offline
    }

    const query = new URLSearchParams();
    if (projectId) {
      query.set('project_id', projectId);
    }
    query.set('limit', '5');

    const res = await fetchFn(`${apiUrl}/inject?${query.toString()}`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(2500),
    });

    if (!res.ok) {
      return {};
    }

    const data = await res.json().catch(() => ({}));

    let dueActionsText = '';
    if (Array.isArray(data.due_actions) && data.due_actions.length > 0) {
      const lines = data.due_actions.map((a) => {
        const overdueTag = a.overdue ? '[OVERDUE] ' : '';
        const prio =
          a.priority !== undefined && a.priority !== null && String(a.priority).trim()
            ? `[${String(a.priority).toUpperCase()}] `
            : '';
        const timeLabel = a.due_at
          ? `due ${a.due_at}`
          : a.remind_at
            ? `remind ${a.remind_at}`
            : '';
        const tier = a.match_tier;
        const tierTag =
          tier === 'ancestor' || tier === 'child'
            ? ` [${tier}: ${a.project_id || ''}]`
            : tier === 'global'
              ? ' [global]'
              : '';
        const timePart = timeLabel ? ` (${timeLabel})` : '';
        const desc = a.description ? `: ${a.description}` : '';
        return `- ${overdueTag}${prio}${a.title}${timePart}${tierTag}${desc}`;
      });
      dueActionsText = `DUE / OVERDUE ACTIONS:\n${lines.join('\n')}`;
    }

    let readyActionsText = '';
    if (Array.isArray(data.ready_actions) && data.ready_actions.length > 0) {
      const lines = data.ready_actions.map((a) => {
        const prio =
          a.priority !== undefined && a.priority !== null && String(a.priority).trim()
            ? `[${String(a.priority).toUpperCase()}] `
            : '';
        const status = a.status ? ` (${a.status})` : '';
        const desc = a.description ? `: ${a.description}` : '';
        return `- ${prio}${a.title}${status}${desc}`;
      });
      readyActionsText = `READY NEXT ACTIONS:\n${lines.join('\n')}`;
    }

    const warnings =
      data.formatted_warnings ||
      data.prompt_injection ||
      data.critical_warnings ||
      '';

    let lessonsText = '';
    if (Array.isArray(data.lessons) && data.lessons.length > 0) {
      const lines = data.lessons.map((l) => {
        if (typeof l === 'string') return `- ${l}`;
        const label = l.title ? `${l.title}: ` : '';
        const body = l.content || l.text || l.description || '';
        return `- ${label}${body}`.trim();
      });
      lessonsText = `LESSONS:\n${lines.join('\n')}`;
    } else if (typeof data.lessons === 'string' && data.lessons.trim()) {
      lessonsText = `LESSONS:\n${data.lessons.trim()}`;
    }

    let lastSessionText = '';
    if (data.latest_session_summary) {
      if (typeof data.latest_session_summary === 'string' && data.latest_session_summary.trim()) {
        lastSessionText = `LAST SESSION SUMMARY:\n${data.latest_session_summary.trim()}`;
      } else if (typeof data.latest_session_summary === 'object') {
        const s = data.latest_session_summary;
        const summaryBody =
          s.summary ||
          s.description ||
          s.content ||
          (Array.isArray(s.claims) ? s.claims.map((c) => `- ${c.text}`).join('\n') : '') ||
          '';
        if (summaryBody && String(summaryBody).trim()) {
          lastSessionText = `LAST SESSION SUMMARY:\n${String(summaryBody).trim()}`;
        }
      }
    }

    let notesText = '';
    if (Array.isArray(data.notes) && data.notes.length > 0) {
      const lines = data.notes.map(
        (n) => `- [${n.type || 'note'}] ${n.title}: ${n.content}`
      );
      notesText = `CURATED MEMORIES:\n${lines.join('\n')}`;
    }

    const consolidationWarning =
      typeof data.consolidation_warning === 'string' && data.consolidation_warning.trim()
        ? data.consolidation_warning.trim()
        : '';

    const parts = [
      dueActionsText.trim(),
      readyActionsText.trim(),
      String(warnings).trim(),
      consolidationWarning,
      lessonsText.trim(),
      lastSessionText.trim(),
      notesText.trim(),
    ].filter(Boolean);
    if (parts.length === 0) {
      return {};
    }

    const systemMessage = parts.join('\n\n');

    return {
      systemMessage,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: systemMessage,
        systemMessage,
      },
      injectSteps: [
        {
          systemMessage: {
            systemMessage,
          },
        },
      ],
    };
  } catch {
    return {};
  }
}

if (require.main === module) {
  (async () => {
    try {
      const input = await readStdin();
      const output = await runSessionStart(input);
      console.log(JSON.stringify(output || {}));
    } catch {
      console.log(JSON.stringify({}));
    }
    process.exit(0);
  })();
}

module.exports = {
  runSessionStart,
  readDotEnvValue,
  resolveApiKey,
  resolveApiUrl,
  resolveProjectId,
  resolveSessionProject,
};
