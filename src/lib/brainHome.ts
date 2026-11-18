import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';

function expandTilde(rawPath: string, baseHome: string): string {
  if (rawPath === '~') return baseHome;
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return path.join(baseHome, rawPath.slice(2));
  }
  return path.resolve(rawPath);
}

/**
 * Returns the user-level Neuralbrain home directory (~/.neuralbrain by default,
 * or BRAIN_HOME if set). Passing an explicit `homeDir` overrides os.homedir() and
 * ignores BRAIN_HOME (useful in tests).
 */
export function getBrainHomeDir(homeDir?: string): string {
  if (homeDir) {
    return path.join(path.resolve(homeDir), '.neuralbrain');
  }
  const envHome = process.env.BRAIN_HOME?.trim();
  if (envHome) {
    return expandTilde(envHome, os.homedir());
  }
  return path.join(os.homedir(), '.neuralbrain');
}

export function getBrainDataDir(homeDir?: string): string {
  return path.join(getBrainHomeDir(homeDir), 'data');
}

export function getDefaultDbPath(homeDir?: string): string {
  return path.join(getBrainDataDir(homeDir), 'brain.db');
}

export function getDefaultModelCacheDir(homeDir?: string): string {
  return path.join(getBrainDataDir(homeDir), 'models');
}

export function getDefaultSpoolDir(homeDir?: string): string {
  return path.join(getBrainHomeDir(homeDir), 'spool');
}

export function getDefaultQdrantDir(homeDir?: string): string {
  return path.join(getBrainHomeDir(homeDir), 'qdrant');
}

export function getBrainHooksDir(homeDir?: string): string {
  return path.join(getBrainHomeDir(homeDir), 'hooks');
}

export function getBrainMcpDir(homeDir?: string): string {
  return path.join(getBrainHomeDir(homeDir), 'mcp');
}

export function getBrainEnvPath(homeDir?: string): string {
  return path.join(getBrainHomeDir(homeDir), '.env');
}

export function getBrainEnvCandidates(homeDir?: string): string[] {
  const brainHome = getBrainHomeDir(homeDir);
  return [
    path.join(brainHome, '.env.local'),
    path.join(brainHome, '.env'),
  ];
}

/**
 * Loads environment variables in priority order without clobbering existing
 * `process.env` values:
 *   1. <cwd>/.env.local
 *   2. <cwd>/.env
 *   3. ~/.neuralbrain/.env.local
 *   4. ~/.neuralbrain/.env
 */
export function loadBrainEnv(options?: { cwd?: string; homeDir?: string }): string[] {
  const cwd = options?.cwd ? path.resolve(options.cwd) : process.cwd();
  const candidates = [
    path.join(cwd, '.env.local'),
    path.join(cwd, '.env'),
    ...getBrainEnvCandidates(options?.homeDir),
  ];

  const loaded: string[] = [];
  const seen = new Set<string>();

  for (const filePath of candidates) {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    if (fs.existsSync(resolved)) {
      dotenv.config({ path: resolved, override: false, quiet: true });
      loaded.push(resolved);
    }
  }

  return loaded;
}
