import fs from 'fs';
import os from 'os';
import path from 'path';
import { installGlobalPackage, isInstalledCopy, isNpxCacheCopy } from '../../cli';

type Call = { command: string; args: string[]; options: any };

function fakeNpm(opts: { globalRoot: string; packStatus?: number; installStatus?: number; packStdout?: string }) {
  const calls: Call[] = [];
  const run = (command: string, args: string[], options: any) => {
    calls.push({ command, args, options });
    if (args[0] === 'root') return { status: 0, stdout: `${opts.globalRoot}\n` };
    if (args[0] === 'pack') {
      return {
        status: opts.packStatus ?? 0,
        // npm prints prepack lifecycle output before the JSON array
        stdout: opts.packStdout ?? '> neuralbrain@0.1.0 prepack\n> npm run build\n[{"filename":"neuralbrain-0.1.0.tgz"}]',
      };
    }
    if (args[0] === 'install') return { status: opts.installStatus ?? 0 };
    return { status: 1 };
  };
  return { run, calls };
}

describe('global install copies the package instead of linking it', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-global-install-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('isInstalledCopy: true for a real dir inside node_modules, false for a checkout or a link to one', () => {
    const checkout = path.join(tmp, 'Projects', 'neuralbrain');
    const nodeModules = path.join(tmp, 'lib', 'node_modules');
    const copy = path.join(nodeModules, 'neuralbrain');
    fs.mkdirSync(checkout, { recursive: true });
    fs.mkdirSync(copy, { recursive: true });

    expect(isInstalledCopy(copy)).toBe(true);
    expect(isInstalledCopy(checkout)).toBe(false);

    // `npm install -g .` style: node_modules/neuralbrain -> checkout
    const linked = path.join(nodeModules, 'linked-neuralbrain');
    fs.symlinkSync(checkout, linked, 'dir');
    expect(isInstalledCopy(linked)).toBe(false);

    expect(isInstalledCopy(path.join(tmp, 'missing'))).toBe(false);
  });

  test('from a checkout: packs, installs the tarball globally (never `install -g .`), and returns the global copy', () => {
    const checkout = path.join(tmp, 'checkout');
    fs.mkdirSync(checkout);
    const globalRoot = path.join(tmp, 'global', 'lib', 'node_modules');
    const { run, calls } = fakeNpm({ globalRoot });

    const res = installGlobalPackage(checkout, run as any);

    expect(res).toEqual({ ok: true, installedRoot: path.join(globalRoot, 'neuralbrain'), alreadyInstalled: false });

    const pack = calls.find((c) => c.args[0] === 'pack')!;
    expect(pack.options.cwd).toBe(checkout);

    const install = calls.find((c) => c.args[0] === 'install')!;
    expect(install.args).toContain('-g');
    expect(install.args).not.toContain('.');
    const tarball = install.args[2];
    expect(path.basename(tarball)).toBe('neuralbrain-0.1.0.tgz');
    expect(path.isAbsolute(tarball)).toBe(true);
    // nothing needs an install script any more (SQLite is built into Node)
    expect(install.args.some((a) => a.startsWith('--allow-scripts'))).toBe(false);
    expect(install.options.env.ONNXRUNTIME_NODE_INSTALL_CUDA).toBe('skip');

    // the temporary pack directory is cleaned up
    expect(fs.existsSync(path.dirname(tarball))).toBe(false);
  });

  test('from an installed copy: does nothing and reports alreadyInstalled', () => {
    const copy = path.join(tmp, 'lib', 'node_modules', 'neuralbrain');
    fs.mkdirSync(copy, { recursive: true });
    const { run, calls } = fakeNpm({ globalRoot: path.join(tmp, 'lib', 'node_modules') });

    const res = installGlobalPackage(copy, run as any);

    expect(res).toEqual({ ok: true, installedRoot: copy, alreadyInstalled: true });
    expect(calls).toHaveLength(0);
  });

  test('isInstalledCopy: false for a copy in the npx cache', () => {
    const npxCopy = path.join(tmp, '.npm', '_npx', 'abc123', 'node_modules', 'neuralbrain');
    fs.mkdirSync(npxCopy, { recursive: true });

    expect(isNpxCacheCopy(npxCopy)).toBe(true);
    expect(isInstalledCopy(npxCopy)).toBe(false);
    expect(isNpxCacheCopy(path.join(tmp, 'lib', 'node_modules', 'neuralbrain'))).toBe(false);
  });

  test('from the npx cache: installs the same version from the registry, never packs', () => {
    const npxCopy = path.join(tmp, '.npm', '_npx', 'abc123', 'node_modules', 'neuralbrain');
    fs.mkdirSync(npxCopy, { recursive: true });
    fs.writeFileSync(path.join(npxCopy, 'package.json'), JSON.stringify({ name: 'neuralbrain', version: '1.2.3' }));
    const globalRoot = path.join(tmp, 'global', 'lib', 'node_modules');
    const { run, calls } = fakeNpm({ globalRoot });

    const res = installGlobalPackage(npxCopy, run as any);

    expect(res).toEqual({ ok: true, installedRoot: path.join(globalRoot, 'neuralbrain'), alreadyInstalled: false });
    expect(calls.some((c) => c.args[0] === 'pack')).toBe(false);
    const install = calls.find((c) => c.args[0] === 'install')!;
    expect(install.args).toEqual(['install', '-g', 'neuralbrain@1.2.3', '--no-audit', '--no-fund']);
    expect(install.options.env.ONNXRUNTIME_NODE_INSTALL_CUDA).toBe('skip');

    expect(installGlobalPackage(npxCopy, fakeNpm({ globalRoot, installStatus: 1 }).run as any)).toMatchObject({
      ok: false,
      error: '`npm install -g` failed',
    });
    fs.rmSync(path.join(npxCopy, 'package.json'));
    expect(installGlobalPackage(npxCopy, fakeNpm({ globalRoot }).run as any)).toMatchObject({
      ok: false,
      error: 'could not read package version',
    });
  });

  test('reports failures without throwing', () => {
    const checkout = path.join(tmp, 'checkout');
    fs.mkdirSync(checkout);
    const globalRoot = path.join(tmp, 'g');

    expect(installGlobalPackage(checkout, fakeNpm({ globalRoot, packStatus: 1 }).run as any)).toMatchObject({
      ok: false,
      error: '`npm pack` failed',
    });
    expect(installGlobalPackage(checkout, fakeNpm({ globalRoot, packStdout: 'garbage' }).run as any)).toMatchObject({
      ok: false,
      error: 'could not read `npm pack` output',
    });
    expect(installGlobalPackage(checkout, fakeNpm({ globalRoot, installStatus: 1 }).run as any)).toMatchObject({
      ok: false,
      error: '`npm install -g` failed',
    });
  });
});
