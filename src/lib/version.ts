import fs from 'fs';
import path from 'path';

const DEFAULT_PACKAGE_ROOT = path.resolve(__dirname, '../..');

export type InstallKind = 'global' | 'local' | 'npx' | 'checkout';

export interface InstallInfo {
  version: string;
  installKind: InstallKind;
  isGlobal: boolean;
  location: string;
}

export function readPackageVersion(packageRoot: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return typeof pkg?.version === 'string' && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

let cachedVersion: string | null = null;

/**
 * Returns the neuralbrain version from package.json (falling back to
 * NEURALBRAIN_VERSION env var or 'unknown').
 */
export function getAppVersion(packageRoot: string = DEFAULT_PACKAGE_ROOT): string {
  if (packageRoot !== DEFAULT_PACKAGE_ROOT) {
    return readPackageVersion(packageRoot) ?? 'unknown';
  }
  if (cachedVersion === null) {
    cachedVersion =
      readPackageVersion(packageRoot) ??
      (process.env.NEURALBRAIN_VERSION?.trim() || null) ??
      'unknown';
  }
  return cachedVersion;
}

function resolveRealPath(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function isGlobalNodeModulesDir(
  nodeModulesDir: string,
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform
): boolean {
  const normalized = path.resolve(nodeModulesDir);
  const parent = path.dirname(normalized);

  // Standard POSIX global install layout: <prefix>/lib/node_modules
  if (path.basename(parent) === 'lib') {
    return true;
  }

  // Configured npm global prefix
  const prefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX;
  if (prefix) {
    const prefixModules =
      platform === 'win32'
        ? path.resolve(prefix, 'node_modules')
        : path.resolve(prefix, 'lib', 'node_modules');
    if (normalized === prefixModules) return true;
  }

  // Global node_modules adjacent to the active node binary (nvm, fnm, standard installs)
  const binDir = path.dirname(execPath);
  const execModules =
    platform === 'win32'
      ? path.resolve(binDir, 'node_modules')
      : path.resolve(path.dirname(binDir), 'lib', 'node_modules');
  if (normalized === execModules) return true;

  // Windows %APPDATA%\npm\node_modules
  if (platform === 'win32' && path.basename(parent).toLowerCase() === 'npm') {
    return true;
  }

  return false;
}

/**
 * Classifies where this neuralbrain installation is running from:
 * - `global`: installed via `npm install -g`
 * - `local`: installed inside a project's `node_modules`
 * - `npx`: running from npm's temporary `_npx` cache
 * - `checkout`: running directly from a source checkout (or symlinked to one)
 */
export function getInstallInfo(
  packageRoot: string = DEFAULT_PACKAGE_ROOT,
  options?: {
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    platform?: NodeJS.Platform;
  }
): InstallInfo {
  const location = resolveRealPath(packageRoot);
  const version = getAppVersion(packageRoot);
  const segments = location.split(path.sep);

  let installKind: InstallKind;
  if (segments.includes('_npx')) {
    installKind = 'npx';
  } else if (path.basename(path.dirname(location)) === 'node_modules') {
    installKind = isGlobalNodeModulesDir(
      path.dirname(location),
      options?.env,
      options?.execPath,
      options?.platform
    )
      ? 'global'
      : 'local';
  } else {
    installKind = 'checkout';
  }

  return {
    version,
    installKind,
    isGlobal: installKind === 'global',
    location,
  };
}

export function formatInstallKind(kind: InstallKind): string {
  switch (kind) {
    case 'global':
      return 'global (-g)';
    case 'local':
      return 'local node_modules';
    case 'npx':
      return 'npx cache';
    case 'checkout':
      return 'local checkout';
  }
}

export function formatVersionSummary(info: InstallInfo = getInstallInfo()): string {
  return `${info.version} (${formatInstallKind(info.installKind)}: ${info.location})`;
}
