#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

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
    let slugModule;
    try {
      slugModule = require(path.join(__dirname, 'lib/projectSlug'));
    } catch {
      try {
        slugModule = require(path.join(__dirname, '../../dist/lib/projectSlug'));
      } catch {
        // Fall back
      }
    }
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
    let slugModule;
    try {
      slugModule = require(path.join(__dirname, 'lib/projectSlug'));
    } catch {
      try {
        slugModule = require(path.join(__dirname, '../../dist/lib/projectSlug'));
      } catch {
        // Fall back
      }
    }
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
    const fetchFn = options.fetchFn || globalThis.fetch;

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
      let spoolModule;
      try {
        spoolModule = require(path.join(__dirname, 'lib/spool'));
      } catch {
        try {
          spoolModule = require(path.join(__dirname, '../../dist/lib/spool'));
        } catch {
          // Fall back
        }
      }
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
