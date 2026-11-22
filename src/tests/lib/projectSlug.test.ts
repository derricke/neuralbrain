import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  findGitProjectRoot,
  resolveCanonicalProjectId,
  resolveSessionProjectId,
  writeBrainRc,
} from '../../lib/projectSlug';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runPostToolUse } = require('../../../plugin/hooks/postToolUse');

describe('project id resolution names the project root, not the current subfolder', () => {
  let tmp: string;
  const savedDefault = process.env.BRAIN_DEFAULT_PROJECT_ID;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb-project-id-')));
    delete process.env.BRAIN_DEFAULT_PROJECT_ID;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (savedDefault === undefined) delete process.env.BRAIN_DEFAULT_PROJECT_ID;
    else process.env.BRAIN_DEFAULT_PROJECT_ID = savedDefault;
  });

  const mk = (...parts: string[]) => {
    const dir = path.join(tmp, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  test('a subfolder of a git repo resolves to the repo folder', () => {
    const repo = mk('Projects', 'neuralbrain');
    fs.mkdirSync(path.join(repo, '.git'));
    const deep = mk('Projects', 'neuralbrain', 'src', 'lib', 'deeper');

    expect(findGitProjectRoot(deep)).toBe(repo);
    expect(resolveCanonicalProjectId({ cwd: deep, fallbackToDirname: true })).toBe('neuralbrain');
  });

  test('a linked git worktree resolves to the MAIN repository, wherever the worktree lives', () => {
    const repo = mk('Projects', 'neuralbrain');
    mk('Projects', 'neuralbrain', '.git', 'worktrees', 'update_dashboard_ui_polish');
    const worktree = mk('.gemini', 'antigravity-cli', 'worktrees', 'neuralbrain', 'update_dashboard_ui_polish');
    fs.writeFileSync(
      path.join(worktree, '.git'),
      `gitdir: ${path.join(repo, '.git', 'worktrees', 'update_dashboard_ui_polish')}\n`
    );
    const inside = mk('.gemini', 'antigravity-cli', 'worktrees', 'neuralbrain', 'update_dashboard_ui_polish', 'src');

    expect(findGitProjectRoot(inside)).toBe(repo);
    expect(resolveCanonicalProjectId({ cwd: inside, fallbackToDirname: true })).toBe('neuralbrain');
  });

  test('a submodule-style .git file (not a worktree) is its own project', () => {
    const sub = mk('Projects', 'outer', 'vendor', 'lib-x');
    fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../../.git/modules/lib-x\n');
    expect(findGitProjectRoot(sub)).toBe(sub);
  });

  test('.brainrc wins over the git root and is found more than 5 levels up', () => {
    const root = mk('Projects', 'acme-social');
    fs.writeFileSync(path.join(root, '.brainrc'), JSON.stringify({ project_id: 'acme-social' }));
    fs.mkdirSync(path.join(root, '.git'));
    const deep = mk('Projects', 'acme-social', 'productions', 'campaign-one', 'film-main', 'a', 'b', 'c');

    expect(resolveCanonicalProjectId({ cwd: deep, fallbackToDirname: true })).toBe('acme-social');
  });

  test('with no .brainrc and no git, the folder itself is used (the session start folder)', () => {
    const plain = mk('Projects', 'acme-social');
    expect(resolveCanonicalProjectId({ cwd: plain, fallbackToDirname: true })).toBe('acme-social');
  });

  test('git-root detection is only used when falling back to directory names', () => {
    const repo = mk('Projects', 'neuralbrain');
    fs.mkdirSync(path.join(repo, '.git'));
    expect(resolveCanonicalProjectId({ cwd: repo, fallbackToDirname: false })).toBeNull();
  });

  test('auto_subproject derives hierarchical project_id and respects max_depth', () => {
    const root = mk('Projects', 'acme');
    writeBrainRc(root, 'acme', { autoSubproject: true });

    expect(resolveCanonicalProjectId({ cwd: root })).toBe('acme');

    const leaf = mk('Projects', 'acme', 'Socials', 'Calendar App', 'v1');
    expect(resolveCanonicalProjectId({ cwd: leaf })).toBe('acme/socials/calendar-app/v1');

    // max_depth limits appended subpath segments
    writeBrainRc(root, 'acme', { autoSubproject: true, maxDepth: 2 });
    expect(resolveCanonicalProjectId({ cwd: leaf })).toBe('acme/socials/calendar-app');
  });

  test('nearest .brainrc overrides parent .brainrc and plain string .brainrc disables auto_subproject', () => {
    const parent = mk('workspace', 'acme');
    writeBrainRc(parent, 'acme', { autoSubproject: true });

    const child = mk('workspace', 'acme', 'cogs');
    fs.writeFileSync(path.join(child, '.brainrc'), 'acme/cogs\n');

    const nested = mk('workspace', 'acme', 'cogs', 'sub');
    expect(resolveCanonicalProjectId({ cwd: nested })).toBe('acme/cogs');
  });

  test('stops walking upward after os.homedir() when cwd is inside home', () => {
    const fakeOuter = mk('outer');
    fs.writeFileSync(path.join(fakeOuter, '.brainrc'), JSON.stringify({ project_id: 'should-not-find' }));
    const fakeHome = mk('outer', 'fakehome');
    const insideHome = mk('outer', 'fakehome', 'projects', 'app');

    jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    expect(resolveCanonicalProjectId({ cwd: insideHome, fallbackToDirname: false })).toBeNull();

    // A .brainrc directly inside homedir itself IS still checked before stopping
    fs.writeFileSync(path.join(fakeHome, '.brainrc'), JSON.stringify({ project_id: 'home-proj' }));
    expect(resolveCanonicalProjectId({ cwd: insideHome, fallbackToDirname: false })).toBe('home-proj');
  });

  test('explicitProjectId accepts and normalizes hierarchical project ids', () => {
    expect(resolveCanonicalProjectId({ explicitProjectId: 'Acme / Socials / Calendar' })).toBe(
      'acme/socials/calendar'
    );
  });

  test('writeBrainRc keeps default payload minimal unless autoSubproject is opted in', () => {
    const dirA = mk('rc-default');
    writeBrainRc(dirA, 'example-org/app');
    expect(JSON.parse(fs.readFileSync(path.join(dirA, '.brainrc'), 'utf-8'))).toEqual({
      project_id: 'example-org/app',
    });

    const dirB = mk('rc-auto');
    writeBrainRc(dirB, 'acme', { autoSubproject: true, maxDepth: 3 });
    expect(JSON.parse(fs.readFileSync(path.join(dirB, '.brainrc'), 'utf-8'))).toEqual({
      project_id: 'acme',
      auto_subproject: true,
      max_depth: 3,
    });
  });

  describe('per-session pinning', () => {
    test('the first resolution in a session is kept when the agent moves into subfolders', () => {
      const pinDir = mk('pins');
      const root = mk('Projects', 'acme-social');
      const renders = mk('Projects', 'acme-social', 'productions', 'campaign-one', 'renders');
      const snapshot = mk('Projects', 'acme-social', 'productions', 'x', '7436ed48-5d7e-4990-8228-d4f1a531929c');

      expect(resolveSessionProjectId({ sessionId: 'sess-a', cwd: root, pinDir })).toBe('acme-social');
      expect(resolveSessionProjectId({ sessionId: 'sess-a', cwd: renders, pinDir })).toBe('acme-social');
      expect(resolveSessionProjectId({ sessionId: 'sess-a', cwd: snapshot, pinDir })).toBe('acme-social');

      // A different session is resolved on its own.
      expect(resolveSessionProjectId({ sessionId: 'sess-b', cwd: renders, pinDir })).toBe('renders');
    });

    test('a session that started unscoped stays unscoped', () => {
      const pinDir = mk('pins');
      fs.writeFileSync(path.join(pinDir, 'sess-null.json'), JSON.stringify({ project_id: null }));
      const somewhere = mk('Projects', 'anything');
      expect(resolveSessionProjectId({ sessionId: 'sess-null', cwd: somewhere, pinDir })).toBeNull();
    });

    test('an explicit project id wins and is not pinned', () => {
      const pinDir = mk('pins');
      const dir = mk('Projects', 'neuralbrain');
      expect(resolveSessionProjectId({ sessionId: 'sess-x', cwd: dir, pinDir, explicitProjectId: 'other' })).toBe(
        'other'
      );
      expect(fs.existsSync(path.join(pinDir, 'sess-x.json'))).toBe(false);
    });

    test('session ids are made safe for file names', () => {
      const pinDir = mk('pins');
      const dir = mk('Projects', 'neuralbrain');
      resolveSessionProjectId({ sessionId: '../../etc/passwd', cwd: dir, pinDir });
      expect(fs.readdirSync(pinDir)).toEqual(['.._.._etc_passwd.json']);
    });

    test('pins older than 14 days are pruned when a new pin is written', () => {
      const pinDir = mk('pins');
      const old = path.join(pinDir, 'old.json');
      fs.writeFileSync(old, JSON.stringify({ project_id: 'x' }));
      const past = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      fs.utimesSync(old, past, past);

      resolveSessionProjectId({ sessionId: 'fresh', cwd: mk('Projects', 'p'), pinDir });
      expect(fs.existsSync(old)).toBe(false);
      expect(fs.existsSync(path.join(pinDir, 'fresh.json'))).toBe(true);
    });

    test('under test, nothing is written to the real BRAIN_HOME when no pinDir is given', () => {
      const saved = process.env.BRAIN_HOME;
      delete process.env.BRAIN_HOME;
      try {
        const dir = mk('Projects', 'neuralbrain');
        const homeSessions = path.join(os.homedir(), '.neuralbrain', 'sessions', 'jest-guard-session.json');
        expect(resolveSessionProjectId({ sessionId: 'jest-guard-session', cwd: dir })).toBe('neuralbrain');
        expect(fs.existsSync(homeSessions)).toBe(false);
      } finally {
        if (saved !== undefined) process.env.BRAIN_HOME = saved;
      }
    });
  });

  test('postToolUse hook: observations stay in the session project after the agent cds into a subfolder', async () => {
    const pinDir = mk('pins');
    const root = mk('Projects', 'acme-social');
    const work = mk('Projects', 'acme-social', 'productions', 'campaign-one', 'work');
    const bodies: any[] = [];
    const fetchFn = async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, status: 200 };
    };
    const opts = { apiUrl: 'http://127.0.0.1:3737', fetchFn, pinDir };

    await runPostToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok', session_id: 's1', cwd: root }, opts);
    await runPostToolUse({ tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'ok', session_id: 's1', cwd: work }, opts);

    const projectIds = bodies.map((b) => (b.observations ? b.observations[0] : b).project_id);
    expect(projectIds).toEqual(['acme-social', 'acme-social']);
  });
});
