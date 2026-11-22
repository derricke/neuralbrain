import request from 'supertest';
import { createApp } from '../../app';
import { getDb, resetDb } from '../../lib/db';
import { hashApiKey } from '../../middleware/auth';
import { createNote, listNotes } from '../../memory/noteStore';
import { startSession, listSessions } from '../../memory/sessionStore';
import { createAction, listActions } from '../../memory/actionStore';
import { renameProject } from '../../memory/projectRename';
import * as embedWorker from '../../learning/embedWorker';

describe('Project Rename (renameProject + POST /maintenance/rename-project)', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = ':memory:';
    delete process.env.BRAIN_API_KEY;
    resetDb();
    getDb();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetDb();
  });

  test('renames project_id across notes, sessions, actions, entities, merges failure_patterns, and updates Qdrant project_ancestors', async () => {
    createNote({
      type: 'architecture',
      title: 'Old project note',
      content: 'Created under old project_id',
      scope: 'project',
      projectId: 'acme/old-proj',
    });

    startSession({
      id: 'sess-old-1',
      scope: 'project',
      project_id: 'acme/old-proj',
    });

    createAction({
      title: 'Follow up',
      scope: 'project',
      project_id: 'acme/old-proj',
    });

    const db = getDb();
    db.prepare(
      `INSERT INTO entities (id, scope, project_id, entity_type, name)
       VALUES ('ent-old-1', 'project', 'acme/old-proj', 'service', 'Calendar')`
    ).run();

    db.prepare(
      `INSERT INTO failure_patterns (id, scope, project_id, task_type, error_text, count, last_seen_at)
       VALUES ('fp-1', 'project', 'acme/old-proj', 'test_run', 'ECONNREFUSED', 3, 1000)`
    ).run();
    db.prepare(
      `INSERT INTO failure_patterns (id, scope, project_id, task_type, error_text, count, last_seen_at)
       VALUES ('fp-2', 'project', 'acme/new-proj', 'test_run', 'ECONNREFUSED', 2, 2000)`
    ).run();
    db.prepare(
      `INSERT INTO failure_patterns (id, scope, project_id, task_type, error_text, count, last_seen_at)
       VALUES ('fp-3', 'project', 'acme/old-proj', 'build', 'TS2304', 1, 1500)`
    ).run();

    const setPayload = jest.fn(async () => ({}));
    jest.spyOn(embedWorker, 'getQdrantClient').mockReturnValue({ setPayload } as any);

    const result = await renameProject('acme/old-proj', 'acme/new-proj');

    expect(result.from_project_id).toBe('acme/old-proj');
    expect(result.to_project_id).toBe('acme/new-proj');
    expect(result.updated_counts.notes).toBe(1);
    expect(result.updated_counts.sessions).toBe(1);
    expect(result.updated_counts.actions).toBe(1);
    expect(result.updated_counts.entities).toBe(1);
    expect(result.updated_counts.failure_patterns).toBe(2);
    expect(result.total_updated).toBe(6);
    expect(result.qdrant_updated).toBe(true);

    expect(setPayload).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        payload: {
          project_id: 'acme/new-proj',
          project_ancestors: ['acme', 'acme/new-proj'],
        },
        filter: {
          must: [{ key: 'project_id', match: { value: 'acme/old-proj' } }],
        },
        wait: true,
      })
    );

    const renamedEntity = db
      .prepare('SELECT project_id FROM entities WHERE id = ?')
      .get('ent-old-1') as { project_id: string };
    expect(renamedEntity.project_id).toBe('acme/new-proj');

    expect(listNotes({ projectId: 'acme/old-proj', includeGlobal: false })).toHaveLength(0);
    expect(listNotes({ projectId: 'acme/new-proj', includeGlobal: false })).toHaveLength(1);

    expect(listSessions({ projectId: 'acme/old-proj' })).toHaveLength(0);
    expect(listSessions({ projectId: 'acme/new-proj' })).toHaveLength(1);

    expect(listActions({ projectId: 'acme/old-proj', includeGlobal: false })).toHaveLength(0);
    expect(listActions({ projectId: 'acme/new-proj', includeGlobal: false })).toHaveLength(1);

    const mergedFp = db
      .prepare(
        `SELECT count, last_seen_at FROM failure_patterns
         WHERE project_id = 'acme/new-proj' AND task_type = 'test_run' AND error_text = 'ECONNREFUSED'`
      )
      .get() as { count: number; last_seen_at: number };
    expect(mergedFp.count).toBe(5);
    expect(mergedFp.last_seen_at).toBe(2000);
  });

  test('POST /maintenance/rename-project validates inputs and performs rename via HTTP', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO api_keys (id, key, name) VALUES ('key-test-rename', ?, 'test-rename')`
    ).run(hashApiKey('test-rename-key'));
    const app = createApp();

    const badRes = await request(app)
      .post('/maintenance/rename-project')
      .set('Authorization', 'Bearer test-rename-key')
      .send({ from_project_id: 'same', to_project_id: 'same' });
    expect(badRes.status).toBe(400);
    expect(badRes.body.error.code).toBe('SCHEMA_INVALID');

    createNote({
      type: 'fact',
      title: 'HTTP rename note',
      content: 'Should move to target-proj',
      scope: 'project',
      projectId: 'source-proj',
    });

    const okRes = await request(app)
      .post('/maintenance/rename-project')
      .set('Authorization', 'Bearer test-rename-key')
      .send({ from_project_id: 'source-proj', to_project_id: 'target-proj' });
    expect(okRes.status).toBe(200);
    expect(okRes.body.from_project_id).toBe('source-proj');
    expect(okRes.body.to_project_id).toBe('target-proj');
    expect(okRes.body.updated_counts.notes).toBe(1);
  });
});
