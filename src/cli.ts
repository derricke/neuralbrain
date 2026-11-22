#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import readline from 'readline/promises';
import { spawn, spawnSync } from 'child_process';
import dotenv from 'dotenv';
import {
  getBrainDataDir,
  getBrainEnvPath,
  getBrainHomeDir,
  getDefaultModelCacheDir,
  getDefaultQdrantDir,
  getDefaultSpoolDir,
  loadBrainEnv,
} from './lib/brainHome';
import { createLocalTlsFetch, ensureLocalTlsCerts, getDefaultCertsDir } from './lib/tls';
import { resolveCanonicalProjectId, writeBrainRc } from './lib/projectSlug';
import { parseDurationMs } from './lib/recurrence';
import { normalizeProjectId } from './lib/scope';
import {
  installAgentIntegration,
  parseCliArgs as parseInstallAgentArgs,
  printInstallAgentReport,
  resolveApiKey,
  resolveApiUrl,
} from './scripts/installAgent';

export type RuntimeMode = 'docker' | 'qdrant-docker' | 'local-only';

export interface InitializeBrainHomeOptions {
  homeDir?: string;
  mode: RuntimeMode;
  port?: number;
  https?: boolean;
  gpu?: boolean;
}

export interface InitializeBrainHomeResult {
  brainHome: string;
  dataDir: string;
  qdrantDir: string;
  envPath: string;
  modePath: string;
  apiKey: string;
  port: number;
  https: boolean;
  createdEnv: boolean;
}

export interface InstallCliOptions {
  mode?: RuntimeMode;
  yes: boolean;
  global?: boolean;
  agents?: boolean;
  port?: number;
  https?: boolean;
  gpu?: boolean;
}

const COMPOSE_PROJECT_NAME = 'neuralbrain';

function getPackageRoot(): string {
  return path.resolve(__dirname, '..');
}

function getModeFilePath(homeDir?: string): string {
  return path.join(getBrainHomeDir(homeDir), 'mode');
}

function getPidFilePath(homeDir?: string): string {
  return path.join(getBrainHomeDir(homeDir), 'brain.pid');
}

function getLogFilePath(homeDir?: string): string {
  return path.join(getBrainHomeDir(homeDir), 'brain.log');
}

export function readRuntimeMode(homeDir?: string): RuntimeMode | null {
  const modePath = getModeFilePath(homeDir);
  if (!fs.existsSync(modePath)) return null;
  const raw = fs.readFileSync(modePath, 'utf8').trim();
  if (raw === 'docker' || raw === 'qdrant-docker' || raw === 'local-only') {
    return raw;
  }
  return null;
}

/**
 * Updates or appends key=value pairs in an existing .env string while preserving
 * unrelated lines and comments.
 */
export function upsertEnvContent(existing: string, updates: Record<string, string>): string {
  const lines = existing ? existing.split(/\r?\n/) : [];
  const remaining = new Map<string, string>(Object.entries(updates));
  const out: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match && remaining.has(match[1])) {
      const key = match[1];
      out.push(`${key}=${remaining.get(key)}`);
      remaining.delete(key);
    } else {
      out.push(line);
    }
  }

  // Trim trailing empty lines before appending new keys
  while (out.length > 0 && out[out.length - 1] === '') {
    out.pop();
  }

  for (const [key, value] of remaining.entries()) {
    out.push(`${key}=${value}`);
  }

  return out.join('\n') + '\n';
}

/**
 * Initializes ~/.neuralbrain/ directories, mode file, and ~/.neuralbrain/.env.
 */
export function initializeBrainHome(options: InitializeBrainHomeOptions): InitializeBrainHomeResult {
  const brainHome = getBrainHomeDir(options.homeDir);
  const dataDir = getBrainDataDir(options.homeDir);
  const modelsDir = getDefaultModelCacheDir(options.homeDir);
  const qdrantDir = getDefaultQdrantDir(options.homeDir);
  const spoolDir = getDefaultSpoolDir(options.homeDir);
  const envPath = getBrainEnvPath(options.homeDir);
  const modePath = getModeFilePath(options.homeDir);

  for (const dir of [brainHome, dataDir, modelsDir, qdrantDir, spoolDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(modePath, `${options.mode}\n`, 'utf8');

  const existingRaw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const parsed = existingRaw ? dotenv.parse(existingRaw) : {};
  const createdEnv = !fs.existsSync(envPath);

  const port = options.port || (parsed.PORT ? parseInt(parsed.PORT, 10) : 3737) || 3737;
  const apiKey = parsed.BRAIN_API_KEY?.trim() || crypto.randomBytes(32).toString('hex');
  const useHttps =
    options.https ?? (parsed.BRAIN_HTTPS?.trim() === '1' || parsed.BRAIN_HTTPS?.trim() === 'true');

  const updates: Record<string, string> = {
    PORT: String(port),
    HOST: parsed.HOST?.trim() || '127.0.0.1',
    BRAIN_HOME: brainHome,
    BRAIN_DATA_DIR: dataDir,
    BRAIN_QDRANT_DIR: qdrantDir,
    BRAIN_REQUIRE_API_KEY: parsed.BRAIN_REQUIRE_API_KEY?.trim() || '1',
    BRAIN_API_KEY: apiKey,
    BRAIN_AI: parsed.BRAIN_AI?.trim() || 'agent',
  };

  if (useHttps) {
    updates.BRAIN_HTTPS = '1';
    updates.BRAIN_API_URL = `https://127.0.0.1:${port}`;
    ensureLocalTlsCerts({ homeDir: options.homeDir });
  }

  if (options.gpu && options.mode === 'local-only') {
    throw new Error('--gpu requires --mode docker or --mode qdrant-docker (spawns the Docker Compose gpu profile).');
  }

  if (options.mode === 'local-only') {
    updates.BRAIN_EMBED = 'none';
  } else {
    updates.BRAIN_EMBED = options.gpu ? 'local-gpu' : 'local';
    updates.BRAIN_EMBED_MODEL = parsed.BRAIN_EMBED_MODEL?.trim() || 'nomic';
    updates.BRAIN_EMBED_DIM = parsed.BRAIN_EMBED_DIM?.trim() || '512';
    if (options.mode === 'qdrant-docker') {
      updates.QDRANT_URL = parsed.QDRANT_URL?.trim() || 'http://127.0.0.1:6333';
    }
  }

  const nextContent = createdEnv
    ? [
        '# neuralbrain user configuration (~/.neuralbrain/.env)',
        upsertEnvContent('', updates).trimEnd(),
        '',
      ].join('\n')
    : upsertEnvContent(existingRaw, updates);

  fs.writeFileSync(envPath, nextContent, { mode: 0o600, encoding: 'utf8' });

  return {
    brainHome,
    dataDir,
    qdrantDir,
    envPath,
    modePath,
    apiKey,
    port,
    https: useHttps,
    createdEnv,
  };
}

export function parseInstallArgs(argv: string[]): InstallCliOptions {
  const opts: InstallCliOptions = { yes: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '-y') {
      opts.yes = true;
    } else if (arg === '--mode') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) {
        throw new Error('Missing value for --mode. Expected: docker | qdrant-docker | local-only');
      }
      if (val === 'docker' || val === 'qdrant-docker' || val === 'local-only') {
        opts.mode = val;
      } else {
        throw new Error(`Invalid --mode '${val}'. Expected: docker | qdrant-docker | local-only`);
      }
    } else if (arg === '--no-global') {
      opts.global = false;
    } else if (arg === '--global') {
      opts.global = true;
    } else if (arg === '--no-agents') {
      opts.agents = false;
    } else if (arg === '--agents') {
      opts.agents = true;
    } else if (arg === '--port') {
      const rawPort = argv[++i];
      if (!rawPort || rawPort.startsWith('--')) {
        throw new Error('Missing value for --port');
      }
      const p = parseInt(rawPort, 10);
      if (Number.isNaN(p) || p <= 0) {
        throw new Error(`Invalid --port value`);
      }
      opts.port = p;
    } else if (arg === '--https') {
      opts.https = true;
    } else if (arg === '--gpu') {
      opts.gpu = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function hasDockerCompose(): boolean {
  const res = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' });
  return res.status === 0;
}

function runCompose(
  args: string[],
  envPath: string,
  packageRoot: string,
  extraComposeFiles: string[] = []
): number {
  const composeFile = path.join(packageRoot, 'docker-compose.yml');
  const fileFlags = [composeFile, ...extraComposeFiles].flatMap((file) => ['-f', file]);
  const res = spawnSync(
    'docker',
    ['compose', '-p', COMPOSE_PROJECT_NAME, ...fileFlags, '--env-file', envPath, ...args],
    {
      cwd: packageRoot,
      stdio: 'inherit',
      env: { ...process.env, HOME: os.homedir() },
    }
  );
  return res.status ?? 1;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startHostDaemon(packageRoot: string, envPath: string): number {
  const pidFile = getPidFilePath();
  if (fs.existsSync(pidFile)) {
    const existingPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!Number.isNaN(existingPid) && isPidAlive(existingPid)) {
      console.log(`  Brain daemon already running (pid ${existingPid})`);
      return existingPid;
    }
  }

  const logPath = getLogFilePath();
  const out = fs.openSync(logPath, 'a', 0o600);
  try {
    fs.chmodSync(logPath, 0o600);
  } catch {
    // ignore chmod errors on unsupported platforms
  }
  const entryJs = path.join(packageRoot, 'dist', 'index.js');

  const parsedEnv = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
  const child = spawn(process.execPath, [entryJs], {
    cwd: getBrainHomeDir(),
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...parsedEnv,
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || parsedEnv.NODE_ENV || 'production',
    },
  });

  child.unref();
  if (child.pid) {
    fs.writeFileSync(pidFile, `${child.pid}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  return child.pid ?? 0;
}

function stopHostDaemon(): boolean {
  const pidFile = getPidFilePath();
  if (!fs.existsSync(pidFile)) return false;

  const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  if (Number.isNaN(pid) || pid <= 0) {
    fs.rmSync(pidFile, { force: true });
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
    fs.rmSync(pidFile, { force: true });
    return true;
  } catch (err: any) {
    if (err?.code === 'ESRCH') {
      fs.rmSync(pidFile, { force: true });
    }
    return false;
  }
}

function isHttpsEnabled(): boolean {
  return (
    process.env.BRAIN_HTTPS === '1' ||
    process.env.BRAIN_HTTPS === 'true' ||
    Boolean(process.env.BRAIN_TLS_CERT && process.env.BRAIN_TLS_KEY)
  );
}

async function checkHealth(
  port: number,
  useHttps: boolean
): Promise<{ ok: boolean; status: number } | null> {
  if (!useHttps) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return { ok: res.ok, status: res.status };
    } catch {
      return null;
    }
  }

  const certPath =
    process.env.BRAIN_TLS_CERT?.trim() || path.join(getDefaultCertsDir(), 'server.crt');
  const ca = fs.existsSync(certPath) ? fs.readFileSync(certPath) : undefined;

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        ca,
        timeout: 3000,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => {
      resolve(null);
    });
    req.end();
  });
}

async function waitForHealth(
  port: number,
  timeoutMs = 45000,
  useHttps = isHttpsEnabled()
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await checkHealth(port, useHttps);
    if (res?.ok) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function promptMode(rl: readline.Interface): Promise<RuntimeMode> {
  console.log('\nChoose how to run neuralbrain:');
  console.log('  1) Full Docker stack (Brain + Qdrant in Docker)');
  console.log('  2) Qdrant in Docker + Brain on host (Node.js)');
  console.log('  3) Brain only on host, no Qdrant (SQLite + BM25, 0 MB vector RAM)');

  while (true) {
    const answer = (await rl.question('\nSelect mode [1/2/3] (default: 1): ')).trim();
    if (!answer || answer === '1') return 'docker';
    if (answer === '2') return 'qdrant-docker';
    if (answer === '3') return 'local-only';
    console.log('Please enter 1, 2, or 3.');
  }
}

async function promptYesNo(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await rl.question(`${question} ${suffix}: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

function isLocalGpuEmbed(parsedEnv: Record<string, string>): boolean {
  return (parsedEnv.BRAIN_EMBED || '').toLowerCase().trim() === 'local-gpu';
}

/**
 * True when the brain runs on this host (not inside the docker image) with the
 * in-process `local` embedder, the only setup that needs the optional
 * @huggingface/transformers dependency on the host. BRAIN_EMBED defaults to
 * `local` when unset.
 */
export function hostNeedsLocalEmbedder(mode: RuntimeMode, parsedEnv: Record<string, string>): boolean {
  if (mode === 'docker') return false;
  const tier = (parsedEnv.BRAIN_EMBED || 'local').toLowerCase().trim();
  return tier === 'local';
}

export interface EnsureLocalEmbedderResult {
  ok: boolean;
  /** True when it was missing and has just been installed. */
  installed: boolean;
  error?: string;
}

/**
 * Checked in a child process: Node caches module lookups for the life of a
 * process, so an in-process require.resolve() keeps failing after the package
 * has just been installed.
 */
function canResolve(id: string, packageRoot: string): boolean {
  const res = spawnSync(
    process.execPath,
    ['-e', `require.resolve(${JSON.stringify(id)}, { paths: [${JSON.stringify(packageRoot)}] })`],
    { stdio: 'ignore' }
  );
  return res.status === 0;
}

/**
 * Makes sure the optional local embedder is installed in packageRoot,
 * installing it if npm dropped it.
 *
 * npm drops it during `npm install -g neuralbrain` on Linux x64, where
 * onnxruntime-node@1.20.1's install script tries to download a CUDA 11 build
 * that no longer exists. Here we control the environment, so that download is
 * skipped (onnxruntime-node ships its CPU binaries in the package).
 */
export function ensureLocalEmbedder(
  packageRoot: string,
  run: SpawnFn = spawnSync as unknown as SpawnFn,
  resolves: (id: string, root: string) => boolean = canResolve
): EnsureLocalEmbedderResult {
  const id = '@huggingface/transformers';
  if (resolves(id, packageRoot)) return { ok: true, installed: false };

  let spec = id;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const version = pkg?.optionalDependencies?.[id] || pkg?.dependencies?.[id];
    if (typeof version === 'string' && version) spec = `${id}@${version}`;
  } catch {
    // fall back to the unversioned spec
  }

  const res = run('npm', ['install', spec, '--no-save', '--no-audit', '--no-fund'], {
    cwd: packageRoot,
    stdio: 'inherit',
    env: { ...process.env, ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip' },
  });
  if (res.status !== 0) {
    return { ok: false, installed: false, error: `\`npm install ${spec}\` failed in ${packageRoot}` };
  }
  if (!resolves(id, packageRoot)) {
    return { ok: false, installed: false, error: `${id} is still not resolvable from ${packageRoot}` };
  }
  return { ok: true, installed: true };
}

function startForMode(mode: RuntimeMode, envPath: string, packageRoot: string): void {
  const parsedEnv = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath, 'utf8')) : {};
  if (hostNeedsLocalEmbedder(mode, parsedEnv)) {
    const embedder = ensureLocalEmbedder(packageRoot);
    if (embedder.installed) {
      console.log('  Installed the local embedder (@huggingface/transformers).');
    } else if (!embedder.ok) {
      console.warn(
        `  Warning: the local embedder is not installed (${embedder.error}). ` +
          'The brain will start, but embedding stays queued until it is installed ' +
          '(re-run `neuralbrain start`) or BRAIN_EMBED is changed to none, remote, vendor or local-gpu.'
      );
    }
  }
  const useGpuProfile = isLocalGpuEmbed(parsedEnv);
  if (parsedEnv.BRAIN_HTTPS === '1' || parsedEnv.BRAIN_HTTPS === 'true') {
    ensureLocalTlsCerts({
      certPath: parsedEnv.BRAIN_TLS_CERT,
      keyPath: parsedEnv.BRAIN_TLS_KEY,
    });
  }

  if (mode === 'docker') {
    if (!hasDockerCompose()) {
      throw new Error('Docker Compose is required for mode "docker" but was not found.');
    }
    const composeArgs = useGpuProfile ? ['--profile', 'gpu', 'up', '-d', '--build'] : ['up', '-d', '--build'];
    const code = runCompose(composeArgs, envPath, packageRoot);
    if (code !== 0) {
      throw new Error(`docker compose up failed with exit code ${code}`);
    }
  } else if (mode === 'qdrant-docker') {
    if (!hasDockerCompose()) {
      throw new Error('Docker Compose is required for mode "qdrant-docker" but was not found.');
    }
    const qdrantPortFile = path.join(packageRoot, 'docker-compose.qdrant-port.yml');
    const composeArgs = useGpuProfile
      ? ['--profile', 'gpu', 'up', '-d', 'qdrant', 'embedder-gpu']
      : ['up', '-d', 'qdrant'];
    const code = runCompose(composeArgs, envPath, packageRoot, [qdrantPortFile]);
    if (code !== 0) {
      throw new Error(`docker compose up ${useGpuProfile ? 'qdrant embedder-gpu' : 'qdrant'} failed with exit code ${code}`);
    }
    const pid = startHostDaemon(packageRoot, envPath);
    console.log(`  Brain daemon started (pid ${pid})`);
  } else {
    if (useGpuProfile && !parsedEnv.BRAIN_GPU_ENDPOINT?.trim()) {
      console.warn(
        '  Warning: BRAIN_EMBED=local-gpu in local-only mode does not start Docker. Set BRAIN_GPU_ENDPOINT or use --mode docker | qdrant-docker.'
      );
    }
    const pid = startHostDaemon(packageRoot, envPath);
    console.log(`  Brain daemon started (pid ${pid})`);
  }
}

type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string; encoding?: 'utf8'; stdio?: 'inherit' | 'pipe'; env?: NodeJS.ProcessEnv }
) => { status: number | null; stdout?: string | Buffer | null };

export interface GlobalInstallResult {
  ok: boolean;
  /** Root of the installed copy (inside `npm root -g`), or null when the install failed. */
  installedRoot: string | null;
  /** True when this CLI is already running from an installed copy, so nothing was reinstalled. */
  alreadyInstalled: boolean;
  error?: string;
}

/**
 * Installs neuralbrain globally as a real copy, not a link.
 *
 * `npm install -g .` on a folder creates a symlink back to that folder (the same
 * as `npm link`), so the CLI, the host daemon and the docker build would keep
 * running out of the checkout, and moving or deleting it would break the install.
 * Packing first and installing the tarball copies the package into npm's global
 * root, exactly as a registry install would.
 */
/**
 * True when packageRoot is inside npm's npx cache (`~/.npm/_npx/<hash>/...`).
 * npm may delete that cache at any time, so it is never a lasting install.
 */
export function isNpxCacheCopy(packageRoot: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(packageRoot);
  } catch {
    real = path.resolve(packageRoot);
  }
  return real.split(path.sep).includes('_npx');
}

/**
 * True when packageRoot is a real installed copy (it sits directly inside a
 * node_modules folder once symlinks are resolved). A linked checkout resolves
 * back to the checkout, so it is not an installed copy. A copy in the npx cache
 * is not one either: the daemon and the docker build must not run from a cache
 * that npm may clear.
 */
export function isInstalledCopy(packageRoot: string): boolean {
  let real: string;
  try {
    real = fs.realpathSync(packageRoot);
  } catch {
    return false;
  }
  if (isNpxCacheCopy(real)) return false;
  return path.basename(path.dirname(real)) === 'node_modules';
}

function readPackageVersion(packageRoot: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return typeof pkg?.version === 'string' && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Finds the globally installed copy on disk.
 *
 * `npm root -g` alone is not trusted: npm masks anything that looks like a
 * UUID in its output (legacy npm tokens were UUIDs), so a global folder whose
 * path contains one is printed with `***` and points nowhere. Candidates, first
 * existing one wins: npm's answer (unless masked), the configured global
 * prefix, then the folder next to the running node binary (nvm and standard
 * installs).
 */
export function locateInstalledCopy(
  reportedRoot: string,
  exists: (p: string) => boolean = fs.existsSync
): string | null {
  const roots: string[] = [];
  if (reportedRoot && !reportedRoot.includes('***')) roots.push(reportedRoot);
  const prefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX;
  if (prefix) {
    roots.push(process.platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules'));
  }
  const binDir = path.dirname(process.execPath);
  roots.push(
    process.platform === 'win32' ? path.join(binDir, 'node_modules') : path.join(path.dirname(binDir), 'lib', 'node_modules')
  );
  for (const root of roots) {
    const candidate = path.join(root, 'neuralbrain');
    if (exists(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

export function installGlobalPackage(
  packageRoot: string,
  run: SpawnFn = spawnSync as unknown as SpawnFn
): GlobalInstallResult {
  if (isInstalledCopy(packageRoot)) {
    return { ok: true, installedRoot: packageRoot, alreadyInstalled: true };
  }

  const rootRes = run('npm', ['root', '-g'], { encoding: 'utf8', stdio: 'pipe' });
  const reportedRoot = rootRes.status === 0 ? String(rootRes.stdout || '').trim() : '';
  // The real location is confirmed on disk after installing (see locateInstalledCopy).
  const located = (): GlobalInstallResult => {
    const root = locateInstalledCopy(reportedRoot);
    return root
      ? { ok: true, installedRoot: root, alreadyInstalled: false }
      : {
          ok: false,
          installedRoot: null,
          alreadyInstalled: false,
          error: 'installed, but could not find the global copy (check `npm root -g`)',
        };
  };
  // onnxruntime-node's script only fetches the CUDA add-on, which the host never
  // uses; with CUDA present it can 404 and fail the whole install. Skip it in
  // case npm runs the script anyway (npm 10 and older run every script).
  const installOptions: Parameters<SpawnFn>[2] = { stdio: 'inherit', env: { ...process.env, ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip' } };

  // From `npx neuralbrain`: the npx cache copy has no dev dependencies, so
  // `npm pack` (whose prepack runs tsc) would fail there. Install the same
  // version from the registry instead.
  if (isNpxCacheCopy(packageRoot)) {
    const version = readPackageVersion(packageRoot);
    if (!version) {
      return { ok: false, installedRoot: null, alreadyInstalled: false, error: 'could not read package version' };
    }
    const installRes = run('npm', ['install', '-g', `neuralbrain@${version}`, '--no-audit', '--no-fund'], installOptions);
    if (installRes.status !== 0) {
      return { ok: false, installedRoot: null, alreadyInstalled: false, error: '`npm install -g` failed' };
    }
    return located();
  }

  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neuralbrain-pack-'));
  try {
    const packRes = run('npm', ['pack', '--json', '--pack-destination', packDir], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (packRes.status !== 0) {
      return { ok: false, installedRoot: null, alreadyInstalled: false, error: '`npm pack` failed' };
    }
    let filename: string | undefined;
    try {
      // `npm pack --json` prints lifecycle output (e.g. the prepack build) before the JSON array.
      const out = String(packRes.stdout || '');
      const parsed = JSON.parse(out.slice(out.indexOf('[')));
      filename = parsed?.[0]?.filename;
    } catch {
      filename = undefined;
    }
    if (!filename) {
      return { ok: false, installedRoot: null, alreadyInstalled: false, error: 'could not read `npm pack` output' };
    }

    const tarball = path.join(packDir, path.basename(filename));
    // No dependency needs its install script: SQLite is built into Node, and sharp
    // and onnxruntime-node ship prebuilt binaries. npm 11+ skips those scripts by
    // default and says so; that is expected.
    const installRes = run('npm', ['install', '-g', tarball, '--no-audit', '--no-fund'], installOptions);
    if (installRes.status !== 0) {
      return { ok: false, installedRoot: null, alreadyInstalled: false, error: '`npm install -g` failed' };
    }
    return located();
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }
}

async function cmdInstall(argv: string[]): Promise<void> {
  const opts = parseInstallArgs(argv);
  const packageRoot = getPackageRoot();
  const isInteractive = !opts.yes && process.stdin.isTTY;

  let mode: RuntimeMode = opts.mode || 'docker';
  let installGlobal = opts.global ?? true;
  let installAgents = opts.agents ?? true;

  if (isInteractive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!opts.mode) {
        mode = await promptMode(rl);
      }
      if (opts.global === undefined) {
        installGlobal = await promptYesNo(
          rl,
          '\nInstall `neuralbrain` globally so it works in any shell?',
          true
        );
      }
      if (opts.agents === undefined) {
        installAgents = await promptYesNo(
          rl,
          'Configure coding agents (Antigravity, Claude Code, Cursor)?',
          true
        );
      }
    } finally {
      rl.close();
    }
  }

  console.log(`\nInitializing ${getBrainHomeDir()} (mode: ${mode})...`);
  const init = initializeBrainHome({ mode, port: opts.port, https: opts.https, gpu: opts.gpu });
  const protocol = init.https ? 'https' : 'http';
  console.log(`  Config: ${init.envPath}${init.createdEnv ? ' (created)' : ' (updated)'}`);

  // Install the global copy first, so the daemon and the docker build run from
  // it rather than from this checkout.
  let runtimeRoot = packageRoot;
  if (installGlobal) {
    console.log('\nInstalling `neuralbrain` globally...');
    const res = installGlobalPackage(packageRoot);
    if (res.ok && res.installedRoot) {
      runtimeRoot = res.installedRoot;
      console.log(
        res.alreadyInstalled
          ? `  Already running from the installed copy at ${res.installedRoot}`
          : `  Installed to ${res.installedRoot}`
      );
      if (!res.alreadyInstalled) {
        console.log(
          '  (If npm listed skipped install scripts for onnxruntime-node, sharp or protobufjs above, that is expected: they are not needed.)'
        );
      }
    } else {
      console.warn(
        `  Warning: global install failed (${res.error}). You may need to fix npm permissions. Running from ${packageRoot} for now.`
      );
    }
  }

  console.log('\nStarting neuralbrain...');
  startForMode(mode, init.envPath, runtimeRoot);

  process.stdout.write(`  Waiting for ${protocol}://127.0.0.1:${init.port}/health...`);
  const healthy = await waitForHealth(init.port, mode === 'docker' ? 90000 : 30000, init.https);
  console.log(healthy ? ' ready!' : ' timed out (check `neuralbrain logs` or `neuralbrain status`).');

  if (installAgents) {
    console.log('\nConfiguring coding agents...');
    const report = installAgentIntegration({
      homeDir: os.homedir(),
      brainRepoDir: runtimeRoot,
    });
    console.log(`  Configured targets: ${report.configuredTargets.join(', ') || 'none'}`);
  }

  console.log('\n┌──────────────────────────────────────────────────────────────┐');
  console.log('│  neuralbrain ready                                           │');
  console.log(`│  Home       ${init.brainHome.padEnd(48)} │`);
  console.log(`│  Mode       ${mode.padEnd(48)} │`);
  console.log(`│  REST API   ${`${protocol}://127.0.0.1:${init.port}`.padEnd(48)} │`);
  console.log(`│  Dashboard  ${`${protocol}://127.0.0.1:${init.port}/dashboard`.padEnd(48)} │`);
  console.log('├──────────────────────────────────────────────────────────────┤');
  console.log('│  Commands: neuralbrain status | stop | start | logs | doctor │');
  console.log('└──────────────────────────────────────────────────────────────┘\n');
}

async function cmdStart(): Promise<void> {
  loadBrainEnv();
  const packageRoot = getPackageRoot();
  const mode = readRuntimeMode() || 'local-only';
  const envPath = getBrainEnvPath();
  if (!fs.existsSync(envPath)) {
    throw new Error(`Not initialized. Run \`neuralbrain install\` first (missing ${envPath}).`);
  }
  const port = parseInt(process.env.PORT || '3737', 10);
  const useHttps = isHttpsEnabled();
  const protocol = useHttps ? 'https' : 'http';
  console.log(`Starting neuralbrain (mode: ${mode})...`);
  startForMode(mode, envPath, packageRoot);
  const healthy = await waitForHealth(port, 30000, useHttps);
  console.log(healthy ? `Ready at ${protocol}://127.0.0.1:${port}` : 'Started, waiting for health check...');
}

/**
 * Whether this BRAIN_HOME's mode runs Docker Compose, and so whether `stop`
 * may touch it. The compose project name is fixed ("neuralbrain"), so stopping
 * compose from a `local-only` home would stop some other install's containers.
 * Only modes that start compose stop it; an unknown mode stops nothing in Docker.
 */
export function modeUsesCompose(mode: RuntimeMode | null): boolean {
  return mode === 'docker' || mode === 'qdrant-docker';
}

function cmdStop(): void {
  const packageRoot = getPackageRoot();
  const envPath = getBrainEnvPath();
  const stoppedHost = stopHostDaemon();
  if (stoppedHost) {
    console.log('Stopped host Brain daemon.');
  }
  const mode = readRuntimeMode();
  if (fs.existsSync(envPath) && modeUsesCompose(mode) && hasDockerCompose()) {
    const extraFiles =
      mode === 'qdrant-docker' ? [path.join(packageRoot, 'docker-compose.qdrant-port.yml')] : [];
    runCompose(['--profile', 'gpu', 'stop'], envPath, packageRoot, extraFiles);
  }
  if (!stoppedHost && !fs.existsSync(envPath)) {
    console.log('Nothing running.');
  }
}

async function cmdStatus(): Promise<void> {
  loadBrainEnv();
  const brainHome = getBrainHomeDir();
  const mode = readRuntimeMode() || 'unconfigured';
  const port = parseInt(process.env.PORT || '3737', 10);
  const pidFile = getPidFilePath();
  let pidStatus = 'not running';
  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    pidStatus = !Number.isNaN(pid) && isPidAlive(pid) ? `running (pid ${pid})` : 'stale pid';
  }

  const useHttps = isHttpsEnabled();
  const protocol = useHttps ? 'https' : 'http';
  const health = await checkHealth(port, useHttps);
  const healthStatus = health
    ? health.ok
      ? `healthy (${health.status})`
      : `unhealthy (${health.status})`
    : 'unreachable';

  console.log(`Home:   ${brainHome}`);
  console.log(`Mode:   ${mode}`);
  console.log(`Daemon: ${pidStatus}`);
  console.log(`API:    ${protocol}://127.0.0.1:${port} (${healthStatus})`);
}

function cmdLogs(): void {
  const mode = readRuntimeMode();
  const envPath = getBrainEnvPath();
  const packageRoot = getPackageRoot();
  if (mode === 'docker' && fs.existsSync(envPath) && hasDockerCompose()) {
    const parsedEnv = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
    const logArgs = isLocalGpuEmbed(parsedEnv)
      ? ['--profile', 'gpu', 'logs', '-f', '--tail=100']
      : ['logs', '-f', '--tail=100'];
    runCompose(logArgs, envPath, packageRoot);
    return;
  }
  const logPath = getLogFilePath();
  if (!fs.existsSync(logPath)) {
    console.log(`No log file found at ${logPath}`);
    return;
  }
  spawnSync('tail', ['-n', '100', '-f', logPath], { stdio: 'inherit' });
}

export interface InitResult {
  filePath: string;
  projectId: string;
  /** False when a .brainrc was already there and was left alone. */
  written: boolean;
  /** The project this folder belonged to before, when it differs (parent .brainrc or git root). */
  enclosingProjectId: string | null;
}

/**
 * `neuralbrain init [project-id] [--force] [--auto-subproject] [--max-depth <n>]`:
 * writes .brainrc in `cwd` so every agent working anywhere below it records the same project_id.
 *
 * Defaults to the folder's own name. An existing .brainrc is kept unless
 * `force` is set. An explicit id that is not a valid project_id is an error,
 * never silently replaced.
 */
export function runInit(options: {
  cwd: string;
  projectId?: string;
  force?: boolean;
  autoSubproject?: boolean;
  maxDepth?: number;
}): InitResult {
  const cwd = path.resolve(options.cwd);
  const filePath = path.join(cwd, '.brainrc');

  if (
    options.maxDepth !== undefined &&
    (!Number.isInteger(options.maxDepth) || options.maxDepth <= 0)
  ) {
    throw new Error('--max-depth must be a positive integer');
  }

  let explicit: string | undefined;
  if (options.projectId !== undefined) {
    const norm = normalizeProjectId(options.projectId);
    if (!norm.ok) {
      throw new Error(`'${options.projectId}' is not a valid project id: ${norm.error}`);
    }
    explicit = norm.projectId;
  }

  // What this folder resolves to today, from a parent .brainrc or the git root.
  const parentDir = path.dirname(cwd);
  const enclosing =
    parentDir !== cwd ? resolveCanonicalProjectId({ cwd: parentDir, fallbackToDirname: false }) : null;
  const gitOrParent = enclosing ?? resolveCanonicalProjectId({ cwd, fallbackToDirname: true });

  if (fs.existsSync(filePath) && !options.force) {
    const existing = resolveCanonicalProjectId({ cwd, fallbackToDirname: false });
    return { filePath, projectId: existing ?? '', written: false, enclosingProjectId: null };
  }

  const written = writeBrainRc(cwd, explicit, {
    autoSubproject: options.autoSubproject,
    maxDepth: options.maxDepth,
  });
  const enclosingProjectId = gitOrParent && gitOrParent !== written.projectId ? gitOrParent : null;
  return { filePath: written.filePath, projectId: written.projectId, written: true, enclosingProjectId };
}

function cmdInit(argv: string[]): void {
  let force = false;
  let autoSubproject = false;
  let maxDepth: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (arg === '--auto-subproject') {
      autoSubproject = true;
    } else if (arg === '--max-depth' || arg.startsWith('--max-depth=')) {
      const raw = arg.startsWith('--max-depth=') ? arg.slice('--max-depth='.length) : argv[++i];
      if (!raw || raw.startsWith('-')) {
        console.error('Missing value for --max-depth');
        process.exit(1);
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        console.error(`Invalid --max-depth '${raw}': must be a positive integer`);
        process.exit(1);
      }
      maxDepth = parsed;
    } else if (arg.startsWith('-')) {
      console.error(`Unknown option for init: ${arg}`);
      process.exit(1);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    console.error('Usage: neuralbrain init [project-id] [--force] [--auto-subproject] [--max-depth <n>]');
    process.exit(1);
  }
  let result: InitResult;
  try {
    result = runInit({
      cwd: process.cwd(),
      projectId: positional[0],
      force,
      autoSubproject,
      maxDepth,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (!result.written) {
    console.log(`${result.filePath} already exists (project_id: ${result.projectId || 'unreadable'}).`);
    console.log('Run `neuralbrain init [project-id] --force` to replace it.');
    return;
  }
  console.log(`Wrote ${result.filePath}`);
  console.log(`project_id: ${result.projectId}`);
  if (autoSubproject) {
    console.log(
      `auto_subproject: true${maxDepth !== undefined ? ` (max_depth: ${maxDepth})` : ''}`
    );
  }
  if (result.enclosingProjectId) {
    console.log(
      `Note: this folder was part of project "${result.enclosingProjectId}". ` +
        `Work here will now be recorded as "${result.projectId}". ` +
        'If that was not intended, delete the file or run init in the project root.'
    );
  }
}

export interface RemindersCheckOptions {
  json?: boolean;
  webhookUrl?: string;
  webhook?: string;
  projectId?: string;
  project?: string;
  includeAncestors?: boolean;
  includeChildren?: boolean;
  includeGlobal?: boolean;
  cooldownMs?: number;
  cooldown?: string;
  dryRun?: boolean;
  limit?: number;
  apiUrl?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

export interface RemindersCheckResult {
  checked_at: string;
  reminders: any[];
  marked_count: number;
  acked_count?: number;
  webhook_delivered?: boolean;
  webhook_status?: number;
  output: string;
}

function validateWebhookUrl(raw: string): string {
  const val = raw.trim();
  if (!/^https?:\/\//i.test(val)) {
    throw new Error(`Invalid --webhook URL '${val}': must start with http:// or https://`);
  }
  try {
    new URL(val);
  } catch {
    throw new Error(`Invalid --webhook URL '${val}'`);
  }
  return val;
}

export function parseRemindersArgs(argv: string[]): RemindersCheckOptions {
  const opts: RemindersCheckOptions = {
    json: false,
    includeAncestors: true,
    includeChildren: false,
    includeGlobal: true,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eqIdx = arg.indexOf('=');
    const flag = eqIdx !== -1 ? arg.slice(0, eqIdx) : arg;
    const inlineVal = eqIdx !== -1 ? arg.slice(eqIdx + 1) : undefined;

    const takeValue = (name: string): string => {
      if (inlineVal !== undefined) {
        if (!inlineVal) throw new Error(`Missing value for ${name}`);
        return inlineVal;
      }
      const next = argv[++i];
      if (!next || next.startsWith('--')) {
        throw new Error(`Missing value for ${name}`);
      }
      return next;
    };

    if (flag === '--json') {
      opts.json = true;
    } else if (flag === '--include-children') {
      opts.includeChildren = true;
    } else if (flag === '--no-ancestors') {
      opts.includeAncestors = false;
    } else if (flag === '--no-global') {
      opts.includeGlobal = false;
    } else if (flag === '--dry-run') {
      opts.dryRun = true;
    } else if (flag === '--webhook') {
      opts.webhookUrl = validateWebhookUrl(takeValue('--webhook'));
    } else if (flag === '--project') {
      const val = takeValue('--project').trim();
      const norm = normalizeProjectId(val);
      if (!norm.ok) {
        throw new Error(`Invalid --project '${val}': ${norm.error}`);
      }
      opts.projectId = norm.projectId;
    } else if (flag === '--cooldown') {
      const val = takeValue('--cooldown').trim();
      const ms = parseDurationMs(val);
      if (ms === null) {
        throw new Error(`Invalid --cooldown duration '${val}' (examples: 30m, 2h, 1d, PT15M)`);
      }
      opts.cooldownMs = ms;
      opts.cooldown = val;
    } else if (flag === '--limit') {
      const val = takeValue('--limit').trim();
      const parsed = Number(val);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid --limit '${val}': must be a positive integer`);
      }
      opts.limit = parsed;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return opts;
}

function formatRemindersHuman(result: Omit<RemindersCheckResult, 'output'>): string {
  if (result.reminders.length === 0) {
    return `No due reminders (checked at ${result.checked_at}).`;
  }
  const lines = [`Due reminders (${result.reminders.length}, checked at ${result.checked_at}):`];
  for (const r of result.reminders) {
    const overdueTag = r.overdue ? '[OVERDUE] ' : '';
    const prio = r.priority ? `[${String(r.priority).toUpperCase()}] ` : '';
    const when = r.due_at ? `due ${r.due_at}` : r.remind_at ? `remind ${r.remind_at}` : '';
    const loc = r.project_id ? `${r.scope}:${r.project_id}` : r.scope;
    const tier = r.match_tier ? ` [${r.match_tier}]` : '';
    lines.push(`- ${overdueTag}${prio}${r.title} (${r.id}, ${loc}${tier}${when ? `, ${when}` : ''})`);
  }
  const statusBits = [`marked=${result.marked_count}`];
  if (result.webhook_delivered !== undefined) {
    statusBits.push(`webhook_delivered=${result.webhook_delivered}`);
  }
  if (result.acked_count !== undefined) {
    statusBits.push(`acked=${result.acked_count}`);
  }
  lines.push(`Summary: ${statusBits.join(', ')}`);
  return lines.join('\n');
}

export async function runRemindersCheck(
  options: RemindersCheckOptions = {}
): Promise<RemindersCheckResult> {
  const rawWebhook = options.webhookUrl !== undefined ? options.webhookUrl : options.webhook;
  const webhookUrl = rawWebhook !== undefined && rawWebhook !== null ? validateWebhookUrl(rawWebhook) : undefined;

  let projectId: string | undefined;
  const rawProject = options.projectId !== undefined ? options.projectId : options.project;
  if (rawProject !== undefined && rawProject !== null && rawProject.trim() !== '') {
    const norm = normalizeProjectId(rawProject.trim());
    if (!norm.ok) {
      throw new Error(`Invalid project_id '${rawProject}': ${norm.error}`);
    }
    projectId = norm.projectId;
  }

  let cooldownMs: number | undefined = options.cooldownMs;
  if (cooldownMs !== undefined) {
    if (typeof cooldownMs !== 'number' || !Number.isFinite(cooldownMs) || cooldownMs < 0) {
      throw new Error('cooldownMs must be a non-negative finite number');
    }
  } else if (options.cooldown !== undefined) {
    const parsed = parseDurationMs(options.cooldown);
    if (parsed === null) {
      throw new Error(`Invalid --cooldown duration '${options.cooldown}'`);
    }
    cooldownMs = parsed;
  }

  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw new Error('limit must be a positive integer');
  }

  const packageRoot = getPackageRoot();
  const apiUrl = (
    options.apiUrl || resolveApiUrl({}, packageRoot, process.cwd(), os.homedir())
  ).replace(/\/+$/, '');
  const apiKey =
    options.apiKey !== undefined
      ? options.apiKey
      : resolveApiKey({}, packageRoot, process.cwd(), os.homedir());
  const fetchFn = options.fetchFn || createLocalTlsFetch();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const dryRun = Boolean(options.dryRun);
  const checkPayload: Record<string, unknown> = {
    include_ancestors: options.includeAncestors ?? true,
    include_children: options.includeChildren ?? false,
    include_global: options.includeGlobal ?? true,
    dry_run: webhookUrl ? true : dryRun,
  };
  if (projectId) checkPayload.project_id = projectId;
  if (cooldownMs !== undefined) checkPayload.cooldown_ms = cooldownMs;
  if (options.limit !== undefined) checkPayload.limit = options.limit;

  const checkRes = await fetchFn(`${apiUrl}/actions/reminders/check`, {
    method: 'POST',
    headers,
    body: JSON.stringify(checkPayload),
  });

  const checkData = (await checkRes.json().catch(() => ({}))) as any;
  if (!checkRes.ok) {
    throw new Error(
      `Reminders check failed (${checkRes.status}): ${checkData?.error?.message || JSON.stringify(checkData)}`
    );
  }

  const checkedAt = typeof checkData.checked_at === 'string' ? checkData.checked_at : new Date().toISOString();
  const reminders = Array.isArray(checkData.reminders) ? checkData.reminders : [];
  let markedCount = typeof checkData.marked_count === 'number' ? checkData.marked_count : 0;
  let ackedCount: number | undefined;
  let webhookDelivered: boolean | undefined;
  let webhookStatus: number | undefined;

  if (webhookUrl && reminders.length > 0) {
    const webhookRes = await fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'neuralbrain.reminders.due',
        checked_at: checkedAt,
        count: reminders.length,
        reminders,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    webhookStatus = webhookRes.status;
    if (!webhookRes.ok) {
      throw new Error(`Webhook delivery failed with status ${webhookRes.status}`);
    }
    webhookDelivered = true;

    if (!dryRun) {
      const ackRes = await fetchFn(`${apiUrl}/actions/reminders/ack`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids: reminders.map((r: any) => r.id) }),
      });
      const ackData = (await ackRes.json().catch(() => ({}))) as any;
      if (!ackRes.ok) {
        throw new Error(
          `Reminders ack failed (${ackRes.status}): ${ackData?.error?.message || JSON.stringify(ackData)}`
        );
      }
      ackedCount = typeof ackData.updated === 'number' ? ackData.updated : reminders.length;
      markedCount = ackedCount ?? reminders.length;
    }
  } else if (webhookUrl) {
    webhookDelivered = false;
  }

  const summaryData: Omit<RemindersCheckResult, 'output'> = {
    checked_at: checkedAt,
    reminders,
    marked_count: markedCount,
    ...(ackedCount !== undefined ? { acked_count: ackedCount } : {}),
    ...(webhookDelivered !== undefined ? { webhook_delivered: webhookDelivered } : {}),
    ...(webhookStatus !== undefined ? { webhook_status: webhookStatus } : {}),
  };

  const output = options.json
    ? JSON.stringify(summaryData, null, 2)
    : formatRemindersHuman(summaryData);

  return {
    ...summaryData,
    output,
  };
}

async function cmdReminders(argv: string[]): Promise<void> {
  const action = argv[0];
  if (!action || action === '-h' || action === '--help' || action === 'help') {
    printHelp();
    return;
  }
  if (action !== 'check') {
    console.error(`Unknown reminders subcommand '${action}'. Expected: check`);
    process.exit(1);
  }
  loadBrainEnv();
  const opts = parseRemindersArgs(argv.slice(1));
  const result = await runRemindersCheck(opts);
  console.log(result.output);
}

function printHelp(): void {
  console.log(`
Usage: neuralbrain <command> [options]

Commands:
  install         Interactive setup in ~/.neuralbrain/ (default)
    --mode <m>      docker | qdrant-docker | local-only
    --port <n>      API port (default: 3737)
    --https         Enable local HTTPS with self-signed cert
    --gpu           Use BRAIN_EMBED=local-gpu (spawns Docker Compose gpu profile)
    --yes, -y       Non-interactive defaults
    --no-global     Skip global npm install
    --no-agents     Skip configuring coding agents
  start           Start the configured Brain service
  stop            Stop running Brain / Docker containers
  status          Show service and health status
  logs            Tail Brain service logs
  doctor          Run health and AI conformance diagnostics
  install-agent   Configure Antigravity, Claude Code, Cursor, or project rules
  init            Write .brainrc here so agents use one project_id for this folder
    [project-id]    Defaults to this folder's name (supports hierarchical a/b/c)
    --force, -f     Replace an existing .brainrc
    --auto-subproject Derive subproject segments from subfolder path below .brainrc
    --max-depth <n> Limit auto-subproject depth below .brainrc
  reminders check Check due/overdue action reminders via Brain HTTP API
    --json          Print machine-readable JSON output
    --webhook <url> POST due reminders payload to http(s) webhook before acking
    --project <id>  Filter reminders to project_id
    --include-children Include child subprojects under --project
    --no-ancestors  Exclude ancestor projects when --project is set
    --no-global     Exclude global-scoped actions
    --cooldown <d>  Minimum interval before re-notifying (e.g. 30m, 2h, PT15M)
    --dry-run       Evaluate without stamping last_reminded_at
    --limit <n>     Max reminders to return
  rename-project  Rename a project_id across SQLite and Qdrant (<from> <to>)
  mcp             Start the stdio MCP server
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sub = args[0];

  if (sub === '-h' || sub === '--help' || sub === 'help') {
    printHelp();
    return;
  }

  if (!sub || sub === 'install') {
    await cmdInstall(sub === 'install' ? args.slice(1) : args);
    return;
  }
  if (sub === 'start') {
    await cmdStart();
    return;
  }
  if (sub === 'stop') {
    cmdStop();
    return;
  }
  if (sub === 'status') {
    await cmdStatus();
    return;
  }
  if (sub === 'logs') {
    cmdLogs();
    return;
  }
  if (sub === 'doctor') {
    loadBrainEnv();
    const doctorPath = path.join(getPackageRoot(), 'dist', 'scripts', 'doctor.js');
    const res = spawnSync(process.execPath, [doctorPath, ...args.slice(1)], { stdio: 'inherit' });
    process.exit(res.status ?? 0);
  }
  if (sub === 'install-agent') {
    loadBrainEnv();
    const parsed = parseInstallAgentArgs(args.slice(1));
    const report = installAgentIntegration({
      ...parsed,
      brainRepoDir: getPackageRoot(),
    });
    printInstallAgentReport(report);
    return;
  }
  if (sub === 'init') {
    cmdInit(args.slice(1));
    return;
  }
  if (sub === 'reminders') {
    await cmdReminders(args.slice(1));
    return;
  }
  if (sub === 'rename-project') {
    loadBrainEnv();
    const [fromId, toId] = args.slice(1);
    if (!fromId || !toId) {
      console.error('Usage: neuralbrain rename-project <from_project_id> <to_project_id>');
      process.exit(1);
    }
    const apiUrl = resolveApiUrl({}, getPackageRoot(), process.cwd(), os.homedir()).replace(/\/+$/, '');
    const apiKey = resolveApiKey({}, getPackageRoot(), process.cwd(), os.homedir());
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const tlsFetch = createLocalTlsFetch();
    const res = await tlsFetch(`${apiUrl}/maintenance/rename-project`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ from_project_id: fromId, to_project_id: toId }),
    });
    const data = (await res.json()) as any;
    if (!res.ok) {
      console.error(`Rename failed (${res.status}): ${data?.error?.message || JSON.stringify(data)}`);
      process.exit(1);
    }
    console.log(
      `Renamed project "${data.from_project_id}" -> "${data.to_project_id}" (${data.total_updated} SQLite rows, qdrant_updated=${data.qdrant_updated})`
    );
    if (data.updated_counts) {
      for (const [table, count] of Object.entries(data.updated_counts)) {
        if (Number(count) > 0) {
          console.log(`  - ${table}: ${count}`);
        }
      }
    }
    if (data.qdrant_error) {
      console.warn(`Warning: Qdrant payload update failed: ${data.qdrant_error}`);
    }
    return;
  }
  if (sub === 'mcp') {
    loadBrainEnv();
    const mcpPath = path.join(getPackageRoot(), 'dist', 'mcp', 'server.js');
    const res = spawnSync(process.execPath, [mcpPath, ...args.slice(1)], { stdio: 'inherit' });
    process.exit(res.status ?? 0);
  }

  console.error(`Unknown command: ${sub}`);
  printHelp();
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[ERROR]', err?.message || err);
    process.exit(1);
  });
}
