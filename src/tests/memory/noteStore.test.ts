import { createNote, getNote, getNotesByFile, listNotes, updateNoteScope } from '../../memory/noteStore';
import { getPendingEmbedCount } from '../../memory/embedQueueStore';
import { getDb, resetDb } from '../../lib/db';

beforeEach(() => {
  resetDb();
  process.env.DATABASE_URL = ':memory:';
  getDb();
});

afterAll(() => {
  resetDb();
});

describe('noteStore', () => {
  it('creates a note with explicit scope, concepts, and files', () => {
    const note = createNote({
      scope: 'project',
      projectId: 'proj-notes',
      type: 'fact',
      title: 'Database location',
      content: 'The database is stored in data/brain.db',
      concepts: ['sqlite', 'database', 'persistence'],
      files: ['src/lib/db.ts', 'src/memory/noteStore.ts'],
    });

    expect(note.id).toBeDefined();
    expect(note.scope).toBe('project');
    expect(note.project_id).toBe('proj-notes');
    expect(note.version).toBe(1);
    expect(note.is_latest).toBe(1);
    expect(note.concepts).toHaveLength(3);
    expect(note.files).toHaveLength(2);

    const fetched = getNote(note.id);
    expect(fetched).toBeDefined();
    expect(fetched?.title).toBe('Database location');
    expect(fetched?.concepts).toEqual(['database', 'persistence', 'sqlite']);

    expect(getPendingEmbedCount('live')).toBe(1);
  });

  it('strictly enforces explicit scope requirement', () => {
    expect(() => {
      createNote({
        scope: undefined as any,
        projectId: 'proj-1',
        type: 'fact',
        title: 'No scope',
        content: 'content',
      });
    }).toThrow();

    expect(() => {
      createNote({
        scope: 'project',
        projectId: null,
        type: 'fact',
        title: 'Missing project id',
        content: 'content',
      });
    }).toThrow();

    expect(() => {
      createNote({
        scope: 'global',
        projectId: 'should-not-be-here',
        type: 'fact',
        title: 'Global with project id',
        content: 'content',
      });
    }).toThrow();
  });

  it('handles supersedes: versions new note and unsets is_latest on old note', () => {
    const v1 = createNote({
      scope: 'project',
      projectId: 'proj-supersede',
      type: 'architecture',
      title: 'Cache architecture',
      content: 'Using in-memory Map for caching',
    });

    expect(v1.version).toBe(1);
    expect(v1.is_latest).toBe(1);

    const v2 = createNote({
      scope: 'project',
      projectId: 'proj-supersede',
      type: 'architecture',
      title: 'Cache architecture v2',
      content: 'Migrated to Redis for shared cache',
      supersedes: v1.id,
    });

    expect(v2.version).toBe(2);
    expect(v2.supersedes).toBe(v1.id);
    expect(v2.is_latest).toBe(1);

    const v1Fetched = getNote(v1.id);
    expect(v1Fetched?.is_latest).toBe(0);
  });

  it('queries notes by file path', () => {
    const filePath = 'src/services/billing.ts';

    createNote({
      scope: 'project',
      projectId: 'proj-billing',
      type: 'bug',
      title: 'Stripe webhook race condition',
      content: 'Webhook can arrive before checkout session is recorded',
      files: [filePath],
    });

    createNote({
      scope: 'global',
      type: 'pattern',
      title: 'Webhook idempotency',
      content: 'Always use idempotency keys on payment calls',
      files: [filePath],
    });

    createNote({
      scope: 'project',
      projectId: 'other-proj',
      type: 'bug',
      title: 'Other project bug',
      content: 'Unrelated',
      files: ['src/services/other.ts'],
    });

    const fileNotes = getNotesByFile(filePath, 'proj-billing');
    expect(fileNotes).toHaveLength(2);
    expect(fileNotes.some((n) => n.scope === 'project')).toBe(true);
    expect(fileNotes.some((n) => n.scope === 'global')).toBe(true);
  });

  it('lists notes with various filters', () => {
    createNote({
      scope: 'project',
      projectId: 'p1',
      type: 'workflow',
      title: 'Deploy process',
      content: 'Run npm run build first',
      concepts: ['deployment'],
    });

    createNote({
      scope: 'project',
      projectId: 'p1',
      type: 'preference',
      title: 'Tabs vs Spaces',
      content: '2 spaces',
      concepts: ['formatting'],
    });

    const workflowNotes = listNotes({ projectId: 'p1', type: ['workflow'] });
    expect(workflowNotes).toHaveLength(1);
    expect(workflowNotes[0].title).toBe('Deploy process');

    const conceptNotes = listNotes({ projectId: 'p1', concept: 'formatting' });
    expect(conceptNotes).toHaveLength(1);
    expect(conceptNotes[0].title).toBe('Tabs vs Spaces');
  });

  it('updates note scope (operator repair action)', () => {
    const note = createNote({
      scope: 'unknown',
      type: 'fact',
      title: 'Unlabelled note',
      content: 'Discovered during audit',
    });

    expect(note.scope).toBe('unknown');
    expect(note.project_id).toBeNull();

    const repaired = updateNoteScope(note.id, 'project', 'proj-repaired');
    expect(repaired.scope).toBe('project');
    expect(repaired.project_id).toBe('proj-repaired');

    const fetched = getNote(note.id);
    expect(fetched?.scope).toBe('project');
    expect(fetched?.project_id).toBe('proj-repaired');
  });

  it('omits embedding BLOBs from createNote, getNote, getNotesByFile, and listNotes', () => {
    const db = getDb();
    const note = createNote({
      scope: 'project',
      projectId: 'proj-embed',
      type: 'fact',
      title: 'Embed strip test',
      content: 'Verify embedding column is never returned',
      files: ['src/embed-test.ts'],
    });
    expect('embedding' in note).toBe(false);

    db.prepare('UPDATE notes SET embedding = ? WHERE id = ?').run(
      Buffer.from(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer),
      note.id
    );

    const fetched = getNote(note.id);
    expect(fetched).toBeDefined();
    expect('embedding' in fetched!).toBe(false);

    const byFile = getNotesByFile('src/embed-test.ts', 'proj-embed');
    expect(byFile).toHaveLength(1);
    expect('embedding' in byFile[0]).toBe(false);

    const listed = listNotes({ projectId: 'proj-embed' });
    expect(listed).toHaveLength(1);
    expect('embedding' in listed[0]).toBe(false);
  });

  it('bounds getNotesByFile with limit parameter (default 50, max 200)', () => {
    const filePath = 'src/bounded.ts';
    for (let i = 0; i < 6; i++) {
      createNote({
        scope: 'project',
        projectId: 'proj-bound',
        type: 'fact',
        title: `Bounded note ${i}`,
        content: `Content ${i}`,
        files: [filePath],
      });
    }

    expect(getNotesByFile(filePath, 'proj-bound', 3)).toHaveLength(3);
    expect(getNotesByFile(filePath, 'proj-bound', 0)).toHaveLength(1);
    expect(getNotesByFile(filePath, 'proj-bound')).toHaveLength(6);
  });

  it('persists user_id, agent_id, and normalized UTC temporal fields (event_at, valid_from, valid_until)', () => {
    const note = createNote({
      scope: 'project',
      projectId: 'acme/cogs',
      userId: 'alice',
      agentId: 'claude',
      type: 'fact',
      title: 'Campaign schedule',
      content: 'Runs every Tuesday in Q4',
      eventAt: '2026-11-22T10:00:00-02:00',
      validFrom: '2026-11-01T00:00:00Z',
      validUntil: new Date('2026-12-31T23:59:59Z'),
    });

    expect(note.user_id).toBe('alice');
    expect(note.agent_id).toBe('claude');
    expect(note.event_at).toBe('2026-11-22T12:00:00.000Z');
    expect(note.valid_from).toBe('2026-11-01T00:00:00.000Z');
    expect(note.valid_until).toBe('2026-12-31T23:59:59.000Z');

    const fetched = getNote(note.id);
    expect(fetched?.user_id).toBe('alice');
    expect(fetched?.agent_id).toBe('claude');
    expect(fetched?.event_at).toBe('2026-11-22T12:00:00.000Z');

    expect(() =>
      createNote({
        scope: 'global',
        type: 'fact',
        title: 'Bad date',
        content: 'Body',
        eventAt: 'not-a-valid-date',
      })
    ).toThrow(/not a valid ISO-8601/);
  });

  it('supports hierarchical scoping, userId filtering, and match_tier in listNotes and getNotesByFile', () => {
    const filePath = 'src/shared/calendar.ts';

    const rootNote = createNote({
      scope: 'project',
      projectId: 'acme',
      userId: 'alice',
      agentId: 'agent-1',
      type: 'architecture',
      title: 'Acme workspace convention',
      content: 'Shared conventions',
      files: [filePath],
    });
    const midNote = createNote({
      scope: 'project',
      projectId: 'acme/socials',
      userId: 'bob',
      agentId: 'agent-2',
      type: 'pattern',
      title: 'Socials pattern',
      content: 'Rate limit handling',
      files: [filePath],
    });
    const leafNote = createNote({
      scope: 'project',
      projectId: 'acme/socials/calendar',
      userId: 'alice',
      agentId: 'agent-3',
      type: 'bug',
      title: 'Calendar timezone bug',
      content: 'Always store UTC ISO',
      files: [filePath],
    });
    const globalNote = createNote({
      scope: 'global',
      userId: 'alice',
      agentId: 'agent-4',
      type: 'fact',
      title: 'Global rule',
      content: 'Never log tokens',
      files: [filePath],
    });

    const listedDefault = listNotes({ projectId: 'acme/socials/calendar', includeGlobal: true });
    const tierById = new Map(listedDefault.map((n) => [n.id, n.match_tier]));
    expect(tierById.get(leafNote.id)).toBe('exact');
    expect(tierById.get(midNote.id)).toBe('ancestor');
    expect(tierById.get(rootNote.id)).toBe('ancestor');
    expect(tierById.get(globalNote.id)).toBe('global');

    const exactOnly = listNotes({
      projectId: 'acme/socials/calendar',
      includeAncestors: false,
      includeGlobal: false,
    });
    expect(exactOnly.map((n) => n.id)).toEqual([leafNote.id]);

    const childrenFromRoot = listNotes({
      projectId: 'acme',
      includeChildren: true,
      includeGlobal: false,
      userId: 'alice',
    });
    expect(childrenFromRoot.map((n) => n.id).sort()).toEqual([leafNote.id, rootNote.id].sort());
    expect(childrenFromRoot.find((n) => n.id === leafNote.id)?.match_tier).toBe('child');

    const byFile = getNotesByFile(filePath, 'acme/socials/calendar', 50, { userId: 'alice' });
    expect(byFile.map((n) => n.id).sort()).toEqual([globalNote.id, leafNote.id, rootNote.id].sort());
    expect(byFile.find((n) => n.id === rootNote.id)?.match_tier).toBe('ancestor');
  });
});
