import request from 'supertest';
import { createApp } from '../../app';
import { getDb, resetDb } from '../../lib/db';
import { hashApiKey } from '../../middleware/auth';
import { createNote, listNotes } from '../../memory/noteStore';
import { startSession, listSessions } from '../../memory/sessionStore';
import { createAction, listActions } from '../../memory/actionStore';
import { renameProject } from '../../memory/projectRename';

describe('Project Rename (renameProject + POST /maintenance/rename-project)', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = ':memory:';
    delete process.env.BRAIN_API_KEY;
    resetDb();
    getDb();
  });

  afterEach(() => {
    resetDb();
  });

  test('renames project_id across notes, sessions, actions, and merges failure_patterns conflicts', async () => {
    createNote({
      type: 'architecture',
      title: 'Old project note',
      content: 'Created under old project_id',
      scope: 'project',
      projectId: 'old-proj',
    });

    startSession({
      id: 'sess-old-1',
      scope: 'project',
      project_id: 'old-proj',
    });

    createAction({
      title: 'Follow up',
      scope: 'project',
      project_id: 'old-proj',
    });

    const db = getDb();
    db.prepare(
      `INSERT INTO failure_patterns (id, scope, project_id, task_type, error_text, count, last_seen_at)
       VALUES ('fp-1', 'project', 'old-proj', 'test_run', 'ECONNREFUSED', 3, 1000)`
    ).run();
    db.prepare(
      `INSERT INTO failure_patterns (id, scope, project_id, task_type, error_text, count, last_seen_at)
       VALUES ('fp-2', 'project', 'new-proj', 'test_run', 'ECONNREFUSED', 2, 2000)`
    ).run();
    db.prepare(
      `INSERT INTO failure_patterns (id, scope, project_id, task_type, error_text, count, last_seen_at)
       VALUES ('fp-3', 'project', 'old-proj', 'build', 'TS2304', 1, 1500)`
    ).run();

    const result = await renameProject('old-proj', 'new-proj');

    expect(result.from_project_id).toBe('old-proj');
    expect(result.to_project_id).toBe('new-proj');
    expect(result.updated_counts.notes).toBe(1);
    expect(result.updated_counts.sessions).toBe(1);
    expect(result.updated_counts.actions).toBe(1);
    expect(result.updated_counts.failure_patterns).toBe(2);
    expect(result.total_updated).toBe(5);

    expect(listNotes({ projectId: 'old-proj', includeGlobal: false })).toHaveLength(0);
    expect(listNotes({ projectId: 'new-proj', includeGlobal: false })).toHaveLength(1);

    expect(listSessions({ projectId: 'old-proj' })).toHaveLength(0);
    expect(listSessions({ projectId: 'new-proj' })).toHaveLength(1);

    expect(listActions({ projectId: 'old-proj', includeGlobal: false })).toHaveLength(0);
    expect(listActions({ projectId: 'new-proj', includeGlobal: false })).toHaveLength(1);

    const mergedFp = db
      .prepare(
        `SELECT count, last_seen_at FROM failure_patterns
         WHERE project_id = 'new-proj' AND task_type = 'test_run' AND error_text = 'ECONNREFUSED'`
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
