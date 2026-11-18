import { captureObservations, getObservation, listObservations } from '../../memory/observationStore';
import { getPendingEmbedCount } from '../../memory/embedQueueStore';
import { listDeadLetters } from '../../memory/deadLetterStore';
import { getDb, resetDb } from '../../lib/db';

beforeEach(() => {
  resetDb();
  process.env.DATABASE_URL = ':memory:';
  getDb();
});

afterAll(() => {
  resetDb();
});

describe('observationStore', () => {
  it('captures observations without truncation and defaults scope to unknown', () => {
    const longInput = 'A'.repeat(8000); // verify no 4000 char truncation!
    const longOutput = 'B'.repeat(8000);

    const result = captureObservations([
      {
        kind: 'tool_call',
        tool_name: 'bash',
        file_path: 'src/index.ts',
        input: longInput,
        output: longOutput,
        duration_ms: 120,
        failed: 0,
      },
    ]);

    expect(result.accepted).toBe(1);
    expect(result.rejected).toHaveLength(0);

    const obs = getObservation(result.ids[0]);
    expect(obs).toBeDefined();
    expect(obs?.scope).toBe('unknown'); // defaulted to unknown, NEVER global
    expect(obs?.project_id).toBeNull();
    expect(obs?.input).toHaveLength(8000);
    expect(obs?.output).toHaveLength(8000);
    expect(obs?.failed).toBe(0);

    // Enqueued for embedding
    expect(getPendingEmbedCount('live')).toBe(1);
  });

  it('rejects malformed items to dead_letters while accepting valid items in batch', () => {
    const result = captureObservations([
      // Valid item 1
      {
        scope: 'project',
        project_id: 'my-proj',
        kind: 'prompt',
        input: 'Hello',
      },
      // Invalid item 2: scope=project but missing project_id
      {
        scope: 'project',
        kind: 'tool_call',
        tool_name: 'test',
      },
      // Invalid item 3: scope=global with project_id
      {
        scope: 'global',
        project_id: 'bad-project',
        kind: 'prompt',
        input: 'Test',
      },
      // Invalid item 4: invalid kind
      {
        scope: 'unknown',
        kind: 'invalid_kind',
      },
      // Valid item 5: scope=global without project_id
      {
        scope: 'global',
        kind: 'tool_call',
        tool_name: 'read',
      },
    ]);

    expect(result.accepted).toBe(2);
    expect(result.rejected).toHaveLength(3);
    expect(result.ids).toHaveLength(2);

    const deadLetters = listDeadLetters({ source: 'capture' });
    expect(deadLetters).toHaveLength(3);
    expect(deadLetters.every((dl) => dl.reason === 'schema_invalid')).toBe(true);
  });

  it('lists observations with filters', () => {
    captureObservations([
      {
        scope: 'project',
        project_id: 'proj-filter',
        session_id: 'sess-1',
        kind: 'tool_call',
        failed: 1,
      },
      {
        scope: 'project',
        project_id: 'proj-filter',
        session_id: 'sess-2',
        kind: 'tool_call',
        failed: 0,
      },
      {
        scope: 'project',
        project_id: 'other-proj',
        session_id: 'sess-1',
        kind: 'prompt',
        failed: 0,
      },
    ]);

    const projList = listObservations({ projectId: 'proj-filter' });
    expect(projList).toHaveLength(2);

    const failedList = listObservations({ projectId: 'proj-filter', failed: 1 });
    expect(failedList).toHaveLength(1);
    expect(failedList[0].session_id).toBe('sess-1');
  });
});
