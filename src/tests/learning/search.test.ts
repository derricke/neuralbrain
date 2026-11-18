import { getDb, resetDb } from '../../lib/db';
import { setCustomEmbedder, serializeEmbedding } from '../../learning/embedding';
import { verifyOrCreateStoreMeta, commitStoreMeta } from '../../learning/storeMeta';
import { hybridSearch } from '../../learning/search';
import { createNote, getNotesByFile } from '../../memory/noteStore';
import { logTrajectory } from '../../memory/trajectoryStore';

describe('hybridSearch', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'local';
    process.env.BRAIN_EMBED_MODEL = 'nomic';
    process.env.BRAIN_EMBED_DIM = '4';
    resetDb();
  });

  afterEach(() => {
    resetDb();
    setCustomEmbedder(null);
    process.env = { ...originalEnv };
  });

  it('performs hybrid search with RRF fusion', async () => {
    verifyOrCreateStoreMeta();

    // Custom query embedder returns [1, 0, 0, 0]
    setCustomEmbedder(async () => [1, 0, 0, 0]);

    // Note 1: strong dense match ([1, 0, 0, 0]), but low BM25 text match
    const note1 = createNote({
      scope: 'project',
      projectId: 'p1',
      type: 'fact',
      title: 'Database connection configuration',
      content: 'App uses PostgreSQL connection pool.',
    });
    getDb()
      .prepare('UPDATE notes SET embedding = ? WHERE id = ?')
      .run(serializeEmbedding([1, 0, 0, 0]), note1.id);

    // Note 2: strong BM25 keyword match for "foreign key constraint failed", but orthogonal vector ([0, 1, 0, 0])
    const note2 = createNote({
      scope: 'project',
      projectId: 'p1',
      type: 'bug',
      title: 'Foreign key constraint failed on migration',
      content: 'SQLite error foreign key constraint failed when running schema upgrade.',
    });
    getDb()
      .prepare('UPDATE notes SET embedding = ? WHERE id = ?')
      .run(serializeEmbedding([0, 1, 0, 0]), note2.id);

    // Note 3: has both dense match and keyword match
    const note3 = createNote({
      scope: 'project',
      projectId: 'p1',
      type: 'pattern',
      title: 'Fix for foreign key constraint',
      content: 'Foreign key constraint issue was solved by disabling PRAGMA foreign_keys.',
    });
    getDb()
      .prepare('UPDATE notes SET embedding = ? WHERE id = ?')
      .run(serializeEmbedding([0.8, 0.6, 0, 0]), note3.id);

    const searchRes = await hybridSearch({
      q: 'foreign key constraint failed',
      project_id: 'p1',
      grains: ['note'],
    });

    expect(searchRes.mode).toBe('hybrid');
    expect(searchRes.results.length).toBeGreaterThan(0);

    // note3 matches both legs, so its RRF score should be highest or among the top
    const topResult = searchRes.results[0];
    expect(topResult).toBeDefined();

    // Verify BM25-only match outside dense top-k still surfaces via RRF
    const foundNote2 = searchRes.results.find((r) => r.id === note2.id);
    expect(foundNote2).toBeDefined();
    expect(foundNote2?.score).toBeGreaterThan(0);
  });

  it('strictly adheres to scope filtering rules and NEVER returns unknown unless requested', async () => {
    verifyOrCreateStoreMeta();
    setCustomEmbedder(async () => [1, 0, 0, 0]);

    // Note in project 'alpha'
    const noteProj = createNote({
      scope: 'project',
      projectId: 'alpha',
      type: 'fact',
      title: 'Alpha architecture document',
      content: 'Alpha architecture details',
    });

    // Note in 'global' scope
    const noteGlobal = createNote({
      scope: 'global',
      type: 'pattern',
      title: 'Global architecture guidelines',
      content: 'Global architecture rules for all teams',
    });

    // Note in 'unknown' scope (e.g. unlabelled)
    const noteUnknown = createNote({
      scope: 'unknown',
      type: 'fact',
      title: 'Unlabelled architecture mystery note',
      content: 'Architecture note with unknown scope',
    });

    // Case 1: Search scoped to project 'alpha' with include_global: true (default)
    const resProject = await hybridSearch({
      q: 'architecture',
      project_id: 'alpha',
      include_global: true,
      grains: ['note'],
    });

    const projectResultIds = resProject.results.map((r) => r.id);
    expect(projectResultIds).toContain(noteProj.id);
    expect(projectResultIds).toContain(noteGlobal.id);
    // MUST NOT contain unknown!
    expect(projectResultIds).not.toContain(noteUnknown.id);

    // Case 2: Search with include_global: false
    const resNoGlobal = await hybridSearch({
      q: 'architecture',
      project_id: 'alpha',
      include_global: false,
      grains: ['note'],
    });
    const noGlobalIds = resNoGlobal.results.map((r) => r.id);
    expect(noGlobalIds).toContain(noteProj.id);
    expect(noGlobalIds).not.toContain(noteGlobal.id);
    expect(noGlobalIds).not.toContain(noteUnknown.id);

    // Case 3: Search explicitly for scope: 'unknown' (the repair list)
    const resUnknown = await hybridSearch({
      q: 'architecture',
      scope: 'unknown',
      grains: ['note'],
    });
    const unknownIds = resUnknown.results.map((r) => r.id);
    expect(unknownIds).toContain(noteUnknown.id);
    expect(unknownIds).not.toContain(noteProj.id);
    expect(unknownIds).not.toContain(noteGlobal.id);
  });

  it('filters by grains correctly', async () => {
    verifyOrCreateStoreMeta();
    setCustomEmbedder(async () => [1, 0, 0, 0]);

    createNote({
      scope: 'global',
      type: 'fact',
      title: 'Refactor memory subsystem',
      content: 'Notes on refactoring memory',
    });

    logTrajectory({
      scope: 'global',
      description: 'Refactor memory subsystem',
      success: true,
    });

    const noteOnlyRes = await hybridSearch({
      q: 'refactor memory',
      grains: ['note'],
    });
    expect(noteOnlyRes.results.every((r) => r.grain === 'note')).toBe(true);

    const trajOnlyRes = await hybridSearch({
      q: 'refactor memory',
      grains: ['trajectory'],
    });
    expect(trajOnlyRes.results.every((r) => r.grain === 'trajectory')).toBe(true);
  });

  it('returns degraded mode with BM25 when store_meta mismatches', async () => {
    // Pin as nomic 512
    process.env.BRAIN_EMBED = 'local';
    process.env.BRAIN_EMBED_MODEL = 'nomic';
    process.env.BRAIN_EMBED_DIM = '512';
    verifyOrCreateStoreMeta();

    // Now change config to minilm 384 without reembedding
    process.env.BRAIN_EMBED = 'local';
    process.env.BRAIN_EMBED_MODEL = 'minilm';
    delete process.env.BRAIN_EMBED_DIM;

    createNote({
      scope: 'global',
      type: 'fact',
      title: 'Migration checklist',
      content: 'Steps to migrate SQLite schema',
    });

    const res = await hybridSearch({
      q: 'migration checklist',
      grains: ['note'],
    });

    expect(res.mode).toBe('bm25');
    expect(res.degraded).toBeDefined();
    expect(res.degraded).toContain('vector search unavailable');
    expect(res.results.length).toBeGreaterThan(0);
  });

  it('looks up notes by file association with getNotesByFile', () => {
    const note = createNote({
      scope: 'project',
      projectId: 'neuralswarm',
      type: 'bug',
      title: 'Concurrency bug in db.ts',
      content: 'Avoid nested transactions in db.ts',
      files: ['src/lib/db.ts'],
    });

    const notesForFile = getNotesByFile('src/lib/db.ts', 'neuralswarm');
    expect(notesForFile.length).toBe(1);
    expect(notesForFile[0].id).toBe(note.id);
    expect(notesForFile[0].files).toContain('src/lib/db.ts');

    // Looking up different file returns empty
    const other = getNotesByFile('src/other.ts', 'neuralswarm');
    expect(other.length).toBe(0);
  });
});
