import {
  normalizeProjectId,
  resolveScope,
  PROJECT_ID_MAX_LENGTH,
  getProjectAncestors,
  getProjectChildRange,
  classifyMatchTier,
  buildHierarchicalScopeSql,
} from '../../lib/scope';
import { openDatabase } from '../../lib/sqlite';

describe('project identity normalisation (Q6)', () => {
  it('converges spellings of the same name', () => {
    const variants = ['MyProject', 'myproject', '  MyProject  ', 'MYPROJECT', 'My Project'];
    const got = variants.map((v) => {
      const r = normalizeProjectId(v);
      expect(r.ok).toBe(true);
      return (r as { ok: true; projectId: string }).projectId;
    });
    // 'My Project' -> 'my-project' is a different name; the rest are one name.
    expect(got.slice(0, 4)).toEqual(['myproject', 'myproject', 'myproject', 'myproject']);
    expect(got[4]).toBe('my-project');
  });

  it('normalizes hierarchical project paths and collapses slashes', () => {
    expect(normalizeProjectId('Acme/Socials/Calendar')).toEqual({
      ok: true,
      projectId: 'acme/socials/calendar',
    });
    expect(normalizeProjectId('  Acme / My Sub // App /  ')).toEqual({
      ok: true,
      projectId: 'acme/my-sub/app',
    });
  });

  it('rejects a filesystem path instead of deriving an id from it', () => {
    for (const p of [
      '/home/user/Projects/Foo',
      'C:\\repos\\Foo',
      'C:/repos/Foo',
      '~',
      '~/repos/foo',
      '.',
      '..',
      './foo',
      '../foo',
      'acme/./app',
      'acme/../app',
    ]) {
      const r = normalizeProjectId(p);
      expect(r.ok).toBe(false);
      expect((r as { ok: false; error: string }).error).toMatch(/looks like a path/);
      expect((r as { ok: false; error: string }).error).toMatch(/project root/);
    }
  });

  it('rejects empty path segments', () => {
    expect(normalizeProjectId('acme/   /app').ok).toBe(false);
  });

  it('rejects unsupported characters rather than stripping them', () => {
    for (const bad of ['foo@bar', 'foo:bar', 'foo#1', 'foo%20bar', 'acme/foo@bar']) {
      expect(normalizeProjectId(bad).ok).toBe(false);
    }
  });

  it('accepts the documented charset', () => {
    for (const ok of ['neuralbrain', 'foo.bar', 'foo_bar', 'app2', '1-2.3_4', 'acme/cogs']) {
      expect(normalizeProjectId(ok).ok).toBe(true);
    }
  });

  it('rejects empty, non-string and over-long ids', () => {
    expect(PROJECT_ID_MAX_LENGTH).toBe(256);
    expect(normalizeProjectId('').ok).toBe(false);
    expect(normalizeProjectId('   ').ok).toBe(false);
    expect(normalizeProjectId(undefined).ok).toBe(false);
    expect(normalizeProjectId(42).ok).toBe(false);
    expect(normalizeProjectId('a'.repeat(PROJECT_ID_MAX_LENGTH + 1)).ok).toBe(false);
    expect(normalizeProjectId('a'.repeat(PROJECT_ID_MAX_LENGTH)).ok).toBe(true);
  });
});

describe('scope resolution (rule 4)', () => {
  it("defaults to 'unknown', never 'global'", () => {
    for (const absent of [undefined, null]) {
      const r = resolveScope(absent, undefined);
      expect(r).toEqual({ ok: true, scope: 'unknown', projectId: null });
    }
  });

  it("normalises project_id when scope is 'project'", () => {
    const r = resolveScope('project', '  Acme / Socials ');
    expect(r).toEqual({ ok: true, scope: 'project', projectId: 'acme/socials' });
  });

  it("requires an id for scope 'project'", () => {
    expect(resolveScope('project', undefined).ok).toBe(false);
    expect(resolveScope('project', '').ok).toBe(false);
  });

  it("forbids an id for 'global' and 'unknown'", () => {
    expect(resolveScope('global', 'x').ok).toBe(false);
    expect(resolveScope('unknown', 'x').ok).toBe(false);
    expect(resolveScope('global', null).ok).toBe(true);
  });

  it('rejects an unknown scope value', () => {
    const r = resolveScope('everywhere', null);
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toMatch(/Invalid scope/);
  });
});

describe('hierarchical scope helpers', () => {
  it('getProjectAncestors computes root-to-leaf prefixes', () => {
    expect(getProjectAncestors('acme/socials/calendar')).toEqual([
      'acme',
      'acme/socials',
      'acme/socials/calendar',
    ]);
    expect(getProjectAncestors('acme')).toEqual(['acme']);
    expect(getProjectAncestors('  Acme / Cogs ')).toEqual(['acme', 'acme/cogs']);
  });

  it('getProjectChildRange produces exact ASCII B-tree scan bounds', () => {
    const range = getProjectChildRange('acme/socials');
    expect(range).toEqual({ gte: 'acme/socials/', lt: 'acme/socials0' });

    expect('acme/socials/calendar' >= range.gte && 'acme/socials/calendar' < range.lt).toBe(true);
    expect('acme/socials' >= range.gte && 'acme/socials' < range.lt).toBe(false);
    expect('acme/socials-v2' >= range.gte && 'acme/socials-v2' < range.lt).toBe(false);
    expect('acme/socials_2' >= range.gte && 'acme/socials_2' < range.lt).toBe(false);
    expect('acme/socials0' >= range.gte && 'acme/socials0' < range.lt).toBe(false);
  });

  it('classifyMatchTier classifies global, unknown, exact, ancestor, and child', () => {
    expect(classifyMatchTier('global', null, 'acme/cogs')).toEqual({ match_tier: 'global' });
    expect(classifyMatchTier('unknown', null, 'acme/cogs')).toEqual({ match_tier: 'unknown' });
    expect(classifyMatchTier('project', null, 'acme/cogs')).toEqual({ match_tier: 'unknown' });
    expect(classifyMatchTier('project', 'acme/cogs', null)).toEqual({ match_tier: 'exact' });
    expect(classifyMatchTier('project', 'acme/cogs', 'acme/cogs')).toEqual({ match_tier: 'exact' });
    expect(classifyMatchTier('project', 'acme/socials', 'acme/socials/calendar')).toEqual({
      match_tier: 'ancestor',
      ancestor_distance: 1,
    });
    expect(classifyMatchTier('project', 'acme', 'acme/socials/calendar')).toEqual({
      match_tier: 'ancestor',
      ancestor_distance: 2,
    });
    expect(classifyMatchTier('project', 'acme/socials/calendar', 'acme')).toEqual({
      match_tier: 'child',
    });
    expect(classifyMatchTier('project', 'example-org/app', 'acme/cogs')).toEqual({
      match_tier: 'exact',
    });
  });

  it('buildHierarchicalScopeSql builds SQL with ancestors, children range, global, and user_id', () => {
    const db = openDatabase(':memory:');
    db.exec(`
      CREATE TABLE mem (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        project_id TEXT,
        user_id TEXT,
        agent_id TEXT
      )
    `);
    const ins = db.prepare('INSERT INTO mem (id, scope, project_id, user_id, agent_id) VALUES (?, ?, ?, ?, ?)');
    ins.run('m-root', 'project', 'acme', 'alice', 'agent-1');
    ins.run('m-mid', 'project', 'acme/socials', 'alice', 'agent-2');
    ins.run('m-leaf', 'project', 'acme/socials/calendar', 'bob', 'agent-1');
    ins.run('m-sib', 'project', 'acme/socials-v2', 'alice', 'agent-1');
    ins.run('m-zero', 'project', 'acme/socials0', 'alice', 'agent-1');
    ins.run('m-glob', 'global', null, 'alice', 'agent-3');
    ins.run('m-unk', 'unknown', null, 'alice', 'agent-1');

    const queryIds = (opts: Parameters<typeof buildHierarchicalScopeSql>[0]) => {
      const { clause, params } = buildHierarchicalScopeSql(opts);
      const rows = db
        .prepare(`SELECT id FROM mem m WHERE ${clause} ORDER BY id ASC`)
        .all(...params) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    };

    // Default: includeAncestors=true, includeChildren=false, includeGlobal=true
    expect(queryIds({ tableAlias: 'm', projectId: 'acme/socials/calendar' })).toEqual([
      'm-glob',
      'm-leaf',
      'm-mid',
      'm-root',
    ]);

    // With scope='project' explicitly alongside projectId, includeGlobal still applies
    expect(queryIds({ tableAlias: 'm', scope: 'project', projectId: 'acme/socials/calendar' })).toEqual([
      'm-glob',
      'm-leaf',
      'm-mid',
      'm-root',
    ]);

    // includeAncestors=false, includeGlobal=false -> exact project only
    expect(
      queryIds({
        tableAlias: 'm',
        projectId: 'acme/socials/calendar',
        includeAncestors: false,
        includeGlobal: false,
      })
    ).toEqual(['m-leaf']);

    // includeChildren=true -> exact + ancestors + children, excluding siblings like -v2 and 0
    const childSql = buildHierarchicalScopeSql({
      tableAlias: 'm',
      projectId: 'acme/socials',
      includeAncestors: true,
      includeChildren: true,
      includeGlobal: false,
    });
    expect(childSql.clause).not.toContain('LIKE');
    expect(
      queryIds({
        tableAlias: 'm',
        projectId: 'acme/socials',
        includeAncestors: true,
        includeChildren: true,
        includeGlobal: false,
      })
    ).toEqual(['m-leaf', 'm-mid', 'm-root']);

    // userId filtering (never filters on agent_id)
    expect(
      queryIds({
        tableAlias: 'm',
        projectId: 'acme/socials',
        includeChildren: true,
        includeGlobal: true,
        userId: '  alice  ',
      })
    ).toEqual(['m-glob', 'm-mid', 'm-root']);

    expect(queryIds({ tableAlias: 'm', scope: 'unknown' })).toEqual(['m-unk']);
    expect(queryIds({ tableAlias: 'm', scope: 'global' })).toEqual(['m-glob']);

    db.close();
  });
});
