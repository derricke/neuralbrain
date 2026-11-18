import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getBrainDataDir,
  getBrainEnvPath,
  getBrainHomeDir,
  getBrainHooksDir,
  getBrainMcpDir,
  getDefaultDbPath,
  getDefaultModelCacheDir,
  getDefaultQdrantDir,
  getDefaultSpoolDir,
  loadBrainEnv,
} from '../../lib/brainHome';
import {
  initializeBrainHome,
  parseInstallArgs,
  readRuntimeMode,
  upsertEnvContent,
} from '../../cli';
import { installAgentIntegration, resolveApiKey, resolveApiUrl } from '../../scripts/installAgent';

describe('brainHome and CLI user-directory setup', () => {
  let tmpRoot: string;
  let tmpHome: string;
  let tmpCwd: string;
  let tmpRepo: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neuralbrain-home-test-'));
    tmpHome = path.join(tmpRoot, 'home');
    tmpCwd = path.join(tmpRoot, 'cwd');
    tmpRepo = path.join(tmpRoot, 'repo');
    fs.mkdirSync(tmpHome, { recursive: true });
    fs.mkdirSync(tmpCwd, { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'dist', 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'dist', 'mcp', 'server.js'), '// stub\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.BRAIN_HOME;
  });

  test('resolves standard ~/.neuralbrain paths and respects BRAIN_HOME', () => {
    expect(getBrainHomeDir(tmpHome)).toBe(path.join(tmpHome, '.neuralbrain'));
    expect(getBrainDataDir(tmpHome)).toBe(path.join(tmpHome, '.neuralbrain', 'data'));
    expect(getDefaultDbPath(tmpHome)).toBe(path.join(tmpHome, '.neuralbrain', 'data', 'brain.db'));
    expect(getDefaultModelCacheDir(tmpHome)).toBe(path.join(tmpHome, '.neuralbrain', 'data', 'models'));
    expect(getDefaultSpoolDir(tmpHome)).toBe(path.join(tmpHome, '.neuralbrain', 'spool'));
    expect(getDefaultQdrantDir(tmpHome)).toBe(path.join(tmpHome, '.neuralbrain', 'qdrant'));
    expect(getBrainHooksDir(tmpHome)).toBe(path.join(tmpHome, '.neuralbrain', 'hooks'));
    expect(getBrainMcpDir(tmpHome)).toBe(path.join(tmpHome, '.neuralbrain', 'mcp'));
    expect(getBrainEnvPath(tmpHome)).toBe(path.join(tmpHome, '.neuralbrain', '.env'));

    const customHome = path.join(tmpRoot, 'custom-brain-home');
    process.env.BRAIN_HOME = customHome;
    expect(getBrainHomeDir()).toBe(customHome);
  });

  test('loadBrainEnv loads ~/.neuralbrain/.env with cwd and process.env taking precedence', () => {
    const origTestVar1 = process.env.NB_TEST_VAR1;
    const origTestVar2 = process.env.NB_TEST_VAR2;
    const origTestVar3 = process.env.NB_TEST_VAR3;
    delete process.env.NB_TEST_VAR1;
    delete process.env.NB_TEST_VAR2;
    process.env.NB_TEST_VAR3 = 'from-process';

    try {
      const userBrainDir = path.join(tmpHome, '.neuralbrain');
      fs.mkdirSync(userBrainDir, { recursive: true });
      fs.writeFileSync(
        path.join(userBrainDir, '.env'),
        'NB_TEST_VAR1=from-user-env\nNB_TEST_VAR2=from-user-env\nNB_TEST_VAR3=from-user-env\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmpCwd, '.env'),
        'NB_TEST_VAR2=from-cwd-env\nNB_TEST_VAR3=from-cwd-env\n',
        'utf8'
      );

      loadBrainEnv({ cwd: tmpCwd, homeDir: tmpHome });

      expect(process.env.NB_TEST_VAR1).toBe('from-user-env');
      expect(process.env.NB_TEST_VAR2).toBe('from-cwd-env');
      expect(process.env.NB_TEST_VAR3).toBe('from-process');
    } finally {
      if (origTestVar1 === undefined) delete process.env.NB_TEST_VAR1;
      else process.env.NB_TEST_VAR1 = origTestVar1;
      if (origTestVar2 === undefined) delete process.env.NB_TEST_VAR2;
      else process.env.NB_TEST_VAR2 = origTestVar2;
      if (origTestVar3 === undefined) delete process.env.NB_TEST_VAR3;
      else process.env.NB_TEST_VAR3 = origTestVar3;
    }
  });

  test('initializeBrainHome creates directories, mode, and .env for all 3 modes while preserving custom keys', () => {
    const res1 = initializeBrainHome({ homeDir: tmpHome, mode: 'local-only', port: 4100 });
    expect(res1.createdEnv).toBe(true);
    expect(fs.existsSync(res1.dataDir)).toBe(true);
    expect(fs.existsSync(res1.qdrantDir)).toBe(true);
    expect(fs.existsSync(path.join(res1.dataDir, 'models'))).toBe(true);
    expect(fs.existsSync(path.join(res1.brainHome, 'spool'))).toBe(true);
    expect(readRuntimeMode(tmpHome)).toBe('local-only');

    const env1 = fs.readFileSync(res1.envPath, 'utf8');
    expect(env1).toContain('PORT=4100');
    expect(env1).toContain('BRAIN_EMBED=none');
    expect(env1).toContain(`BRAIN_API_KEY=${res1.apiKey}`);

    // Add a custom user key and switch mode to qdrant-docker
    fs.appendFileSync(res1.envPath, 'CUSTOM_USER_FLAG=keep-me\n', 'utf8');
    const res2 = initializeBrainHome({ homeDir: tmpHome, mode: 'qdrant-docker' });
    expect(res2.createdEnv).toBe(false);
    expect(res2.apiKey).toBe(res1.apiKey);
    expect(readRuntimeMode(tmpHome)).toBe('qdrant-docker');

    const env2 = fs.readFileSync(res2.envPath, 'utf8');
    expect(env2).toContain('CUSTOM_USER_FLAG=keep-me');
    expect(env2).toContain('BRAIN_EMBED=local');
    expect(env2).toContain('QDRANT_URL=http://127.0.0.1:6333');
  });

  test('upsertEnvContent updates existing keys in place and appends new ones', () => {
    const updated = upsertEnvContent('# header\nPORT=3000\nFOO=bar\n', {
      PORT: '3111',
      BRAIN_EMBED: 'none',
    });
    expect(updated).toBe('# header\nPORT=3111\nFOO=bar\nBRAIN_EMBED=none\n');
  });

  test('parseInstallArgs parses flags and rejects invalid modes', () => {
    const opts = parseInstallArgs(['--mode', 'local-only', '--port', '3200', '-y', '--no-global', '--no-agents']);
    expect(opts).toEqual({
      mode: 'local-only',
      port: 3200,
      yes: true,
      global: false,
      agents: false,
    });
    expect(parseInstallArgs(['--mode', 'docker', '--gpu']).gpu).toBe(true);
    expect(() => parseInstallArgs(['--mode', 'invalid'])).toThrow(/Invalid --mode/);
  });

  test('initializeBrainHome writes BRAIN_EMBED=local-gpu when gpu=true and rejects local-only + gpu', () => {
    const res = initializeBrainHome({ homeDir: tmpHome, mode: 'docker', gpu: true });
    const envContent = fs.readFileSync(res.envPath, 'utf8');
    expect(envContent).toContain('BRAIN_EMBED=local-gpu');

    expect(() => initializeBrainHome({ homeDir: tmpHome, mode: 'local-only', gpu: true })).toThrow(
      /--gpu requires --mode docker or --mode qdrant-docker/
    );
  });

  test('installAgent resolves API key and URL from ~/.neuralbrain/.env and ~/.neuralbrain/data/api-key.txt', () => {
    const origKey = process.env.BRAIN_API_KEY;
    const origUrl = process.env.BRAIN_API_URL;
    delete process.env.BRAIN_API_KEY;
    delete process.env.BRAIN_API_URL;

    try {
      const userDataDir = path.join(tmpHome, '.neuralbrain', 'data');
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.writeFileSync(path.join(userDataDir, 'api-key.txt'), 'key-from-user-data\n', 'utf8');

      expect(resolveApiKey({}, tmpRepo, undefined, tmpHome)).toBe('key-from-user-data');

      fs.writeFileSync(
        path.join(tmpHome, '.neuralbrain', '.env'),
        'BRAIN_API_KEY=key-from-user-env\nBRAIN_API_URL=http://127.0.0.1:3999\n',
        'utf8'
      );

      expect(resolveApiKey({}, tmpRepo, undefined, tmpHome)).toBe('key-from-user-env');
      expect(resolveApiUrl({}, tmpRepo, undefined, tmpHome)).toBe('http://127.0.0.1:3999');

      const report = installAgentIntegration({
        homeDir: tmpHome,
        brainRepoDir: tmpRepo,
        targets: ['claude'],
      });
      expect(report.success).toBe(true);
      const claudeJson = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf8'));
      expect(claudeJson.mcpServers['neuralbrain'].env).toEqual({
        BRAIN_API_URL: 'http://127.0.0.1:3999',
        BRAIN_API_KEY: 'key-from-user-env',
      });
    } finally {
      if (origKey !== undefined) process.env.BRAIN_API_KEY = origKey;
      if (origUrl !== undefined) process.env.BRAIN_API_URL = origUrl;
    }
  });
});
