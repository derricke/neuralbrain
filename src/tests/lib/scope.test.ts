import { normalizeProjectId, resolveScope, PROJECT_ID_MAX_LENGTH } from '../../lib/scope';

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

  it('rejects a filesystem path instead of deriving an id from it', () => {
    for (const p of ['/home/user/Projects/Foo', 'C:\\repos\\Foo', './foo']) {
      const r = normalizeProjectId(p);
      expect(r.ok).toBe(false);
      expect((r as { ok: false; error: string }).error).toMatch(/looks like a path/);
      expect((r as { ok: false; error: string }).error).toMatch(/project root/);
    }
  });

  it('rejects unsupported characters rather than stripping them', () => {
    for (const bad of ['foo@bar', 'foo:bar', 'foo#1', 'foo%20bar']) {
      expect(normalizeProjectId(bad).ok).toBe(false);
    }
  });

  it('accepts the documented charset', () => {
    for (const ok of ['neuralbrain', 'foo.bar', 'foo_bar', 'app2', '1-2.3_4']) {
      expect(normalizeProjectId(ok).ok).toBe(true);
    }
  });

  it('rejects empty, non-string and over-long ids', () => {
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
    const r = resolveScope('project', '  MyProject ');
    expect(r).toEqual({ ok: true, scope: 'project', projectId: 'myproject' });
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
