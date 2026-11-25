import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { formatCliVersion, getCliVersion } from '../../cli';
import { formatVersionSummary, getInstallInfo } from '../../lib/version';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CLI_DIST = path.join(REPO_ROOT, 'dist', 'cli.js');
const PKG_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
).version;

describe('neuralbrain version (-v / --version / version)', () => {
  it('getCliVersion returns package.json version', () => {
    expect(getCliVersion(REPO_ROOT)).toBe(PKG_VERSION);
  });

  it('getCliVersion returns "unknown" when package.json is missing or invalid', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-version-'));
    try {
      expect(getCliVersion(tmp)).toBe('unknown');
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'neuralbrain' }));
      expect(getCliVersion(tmp)).toBe('unknown');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('classifies global, local node_modules, npx cache, and checkout installs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-install-kind-'));
    try {
      const writePkg = (dir: string, version = '1.2.3') => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'neuralbrain', version }));
      };

      const globalDir = path.join(tmp, 'prefix', 'lib', 'node_modules', 'neuralbrain');
      const localDir = path.join(tmp, 'my-app', 'node_modules', 'neuralbrain');
      const npxDir = path.join(tmp, '.npm', '_npx', 'deadbeef', 'node_modules', 'neuralbrain');
      const checkoutDir = path.join(tmp, 'Projects', 'neuralbrain');

      writePkg(globalDir);
      writePkg(localDir);
      writePkg(npxDir);
      writePkg(checkoutDir);

      const globalInfo = getInstallInfo(globalDir);
      expect(globalInfo.installKind).toBe('global');
      expect(globalInfo.isGlobal).toBe(true);
      expect(formatVersionSummary(globalInfo)).toBe(`1.2.3 (global (-g): ${fs.realpathSync(globalDir)})`);

      const localInfo = getInstallInfo(localDir);
      expect(localInfo.installKind).toBe('local');
      expect(localInfo.isGlobal).toBe(false);
      expect(formatVersionSummary(localInfo)).toBe(`1.2.3 (local node_modules: ${fs.realpathSync(localDir)})`);

      const npxInfo = getInstallInfo(npxDir);
      expect(npxInfo.installKind).toBe('npx');
      expect(npxInfo.isGlobal).toBe(false);
      expect(formatVersionSummary(npxInfo)).toBe(`1.2.3 (npx cache: ${fs.realpathSync(npxDir)})`);

      const checkoutInfo = getInstallInfo(checkoutDir);
      expect(checkoutInfo.installKind).toBe('checkout');
      expect(checkoutInfo.isGlobal).toBe(false);
      expect(formatVersionSummary(checkoutInfo)).toBe(`1.2.3 (local checkout: ${fs.realpathSync(checkoutDir)})`);

      // A symlink in global node_modules pointing to a checkout resolves to checkout (not global)
      const linkedDir = path.join(tmp, 'prefix', 'lib', 'node_modules', 'linked-nb');
      fs.symlinkSync(checkoutDir, linkedDir, 'dir');
      const linkedInfo = getInstallInfo(linkedDir);
      expect(linkedInfo.installKind).toBe('checkout');
      expect(linkedInfo.isGlobal).toBe(false);
      expect(linkedInfo.location).toBe(fs.realpathSync(checkoutDir));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each(['-v', '--version', 'version'])('prints version and install location for `neuralbrain %s`', (flag) => {
    const res = spawnSync(process.execPath, [CLI_DIST, flag], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe(formatCliVersion(REPO_ROOT));
    expect(res.stdout).toContain(PKG_VERSION);
    expect(res.stdout).toContain('local checkout');
    expect(res.stdout).toContain(fs.realpathSync(REPO_ROOT));
    expect(res.stderr).toBe('');
  });

  it('wires package version into Dockerfile and docker-compose.yml', () => {
    const dockerfile = fs.readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
    const compose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');

    expect(dockerfile).toContain(`ARG NEURALBRAIN_VERSION=${PKG_VERSION}`);
    expect(dockerfile).toContain('org.opencontainers.image.version="${NEURALBRAIN_VERSION}"');
    expect(dockerfile).toContain('ENV NEURALBRAIN_VERSION=${NEURALBRAIN_VERSION}');

    expect(compose).toContain(`image: neuralbrain:\${NEURALBRAIN_VERSION:-${PKG_VERSION}}`);
    expect(compose).toContain(`NEURALBRAIN_VERSION: \${NEURALBRAIN_VERSION:-${PKG_VERSION}}`);
  });
});
