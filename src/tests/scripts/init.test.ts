import fs from 'fs';
import os from 'os';
import path from 'path';
import { runInit } from '../../cli';
import { resolveCanonicalProjectId } from '../../lib/projectSlug';

describe('neuralbrain init', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-init-')));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const mk = (...parts: string[]) => {
    const dir = path.join(tmp, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, '.brainrc'), 'utf-8'));

  test('writes .brainrc named after the folder it is run in', () => {
    const dir = mk('Projects', 'Acme Media Social');
    const res = runInit({ cwd: dir });

    expect(res).toMatchObject({ projectId: 'acme-media-social', written: true, enclosingProjectId: null });
    expect(read(dir)).toEqual({ project_id: 'acme-media-social' });
    // and everything below it now resolves to that project
    const deep = mk('Projects', 'Acme Media Social', 'productions', 'nov 2', 'renders');
    expect(resolveCanonicalProjectId({ cwd: deep, fallbackToDirname: true })).toBe('acme-media-social');
  });

  test('accepts an explicit project id', () => {
    const dir = mk('Projects', 'whatever');
    expect(runInit({ cwd: dir, projectId: 'My Project' }).projectId).toBe('my-project');
    expect(read(dir)).toEqual({ project_id: 'my-project' });
  });

  test('rejects an invalid explicit id instead of silently using the folder name', () => {
    const dir = mk('Projects', 'whatever');
    expect(() => runInit({ cwd: dir, projectId: '///' })).toThrow(/not a valid project id/);
    expect(() => runInit({ cwd: dir, projectId: 'foo/bar' })).toThrow(/not a valid project id/);
    expect(fs.existsSync(path.join(dir, '.brainrc'))).toBe(false);
  });

  test('keeps an existing .brainrc unless forced', () => {
    const dir = mk('Projects', 'keepme');
    fs.writeFileSync(path.join(dir, '.brainrc'), JSON.stringify({ project_id: 'original' }));

    const kept = runInit({ cwd: dir, projectId: 'other' });
    expect(kept).toMatchObject({ written: false, projectId: 'original' });
    expect(read(dir)).toEqual({ project_id: 'original' });

    const forced = runInit({ cwd: dir, projectId: 'other', force: true });
    expect(forced).toMatchObject({ written: true, projectId: 'other' });
    expect(read(dir)).toEqual({ project_id: 'other' });
  });

  test('warns (via enclosingProjectId) when run in a subfolder of a git repo', () => {
    const repo = mk('Projects', 'neuralbrain');
    fs.mkdirSync(path.join(repo, '.git'));
    const sub = mk('Projects', 'neuralbrain', 'src');

    const res = runInit({ cwd: sub });
    expect(res).toMatchObject({ projectId: 'src', written: true, enclosingProjectId: 'neuralbrain' });
  });

  test('warns when run below a folder that already has a .brainrc', () => {
    const root = mk('Projects', 'acme-workspace');
    fs.writeFileSync(path.join(root, '.brainrc'), JSON.stringify({ project_id: 'acme-workspace' }));
    const sub = mk('Projects', 'acme-workspace', 'site');

    expect(runInit({ cwd: sub }).enclosingProjectId).toBe('acme-workspace');
  });

  test('no warning when the id matches the enclosing project (e.g. init at a git root)', () => {
    const repo = mk('Projects', 'robotmap');
    fs.mkdirSync(path.join(repo, '.git'));
    expect(runInit({ cwd: repo }).enclosingProjectId).toBeNull();
  });
});

describe('neuralbrain stop only touches Docker in modes that started it', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { modeUsesCompose } = require('../../cli');
  test.each([
    ['docker', true],
    ['qdrant-docker', true],
    ['local-only', false],
    [null, false],
  ])('%s -> %s', (mode, expected) => {
    expect(modeUsesCompose(mode)).toBe(expected);
  });
});

describe('parseInstallArgs validates value-expecting flags', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { parseInstallArgs } = require('../../cli');
  test('throws when --mode or --port is missing a value', () => {
    expect(() => parseInstallArgs(['--mode'])).toThrow(/Missing value for --mode/);
    expect(() => parseInstallArgs(['--mode', '--yes'])).toThrow(/Missing value for --mode/);
    expect(() => parseInstallArgs(['--port'])).toThrow(/Missing value for --port/);
    expect(() => parseInstallArgs(['--port', '--https'])).toThrow(/Missing value for --port/);
  });
});
