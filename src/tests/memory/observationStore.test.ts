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
    expect(obs?.user_id).toBeNull();
    expect(obs?.agent_id).toBeNull();
    expect(obs?.input).toHaveLength(8000);
    expect(obs?.output).toHaveLength(8000);
    expect(obs?.failed).toBe(0);

    // Enqueued for embedding
    expect(getPendingEmbedCount('live')).toBe(1);
  });

  it("supports kind: 'response', nullable user_id and agent_id, and hierarchical listing", () => {
    const result = captureObservations([
      {
        scope: 'project',
        project_id: 'acme',
        user_id: 'alice',
        agent_id: 'agent-a',
        kind: 'prompt',
        input: 'Root prompt',
      },
      {
        scope: 'project',
        project_id: 'acme/socials',
        userId: 'bob',
        agentId: 'agent-b',
        kind: 'response',
        output: 'Assistant response',
      },
      {
        scope: 'project',
        project_id: 'acme/socials/calendar',
        user_id: 'alice',
        agent_id: 'agent-c',
        kind: 'tool_call',
        tool_name: 'read',
      },
      {
        scope: 'global',
        user_id: 'alice',
        agent_id: 'agent-d',
        kind: 'response',
        output: 'Global response',
      },
    ]);

    expect(result.accepted).toBe(4);
    expect(result.rejected).toHaveLength(0);

    const resp = getObservation(result.ids[1]);
    expect(resp?.kind).toBe('response');
    expect(resp?.user_id).toBe('bob');
    expect(resp?.agent_id).toBe('agent-b');

    // Default includeAncestors=true, includeGlobal=false, includeChildren=false
    expect(listObservations({ projectId: 'acme/socials/calendar' }).map((o) => o.project_id).sort()).toEqual([
      'acme',
      'acme/socials',
      'acme/socials/calendar',
    ]);

    // includeAncestors=false -> exact only
    expect(
      listObservations({ projectId: 'acme/socials/calendar', includeAncestors: false }).map(
        (o) => o.project_id
      )
    ).toEqual(['acme/socials/calendar']);

    // includeChildren=true -> returns descendants too
    expect(
      listObservations({ projectId: 'acme/socials', includeChildren: true, includeAncestors: false })
        .map((o) => o.project_id)
        .sort()
    ).toEqual(['acme/socials', 'acme/socials/calendar']);

    // includeGlobal=true + userId filter
    const aliceItems = listObservations({
      projectId: 'acme/socials/calendar',
      includeGlobal: true,
      userId: 'alice',
    });
    expect(aliceItems.map((o) => o.project_id)).toHaveLength(3);
    expect(aliceItems.every((o) => o.user_id === 'alice')).toBe(true);
    // Returns rows from multiple agent_ids (never filters on agent_id)
    expect(new Set(aliceItems.map((o) => o.agent_id))).toEqual(
      new Set(['agent-a', 'agent-c', 'agent-d'])
    );
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

  it('validates and persists event_at (ISO-8601, numeric epoch seconds, null/omitted, and dead-letters invalid)', () => {
    const result = captureObservations([
      // 0: ISO-8601 with timezone offset -> normalized to UTC ISO
      {
        scope: 'project',
        project_id: 'event-proj',
        kind: 'prompt',
        input: 'ISO with offset',
        event_at: '2023-05-30T10:00:00-05:00',
      },
      // 1: camelCase eventAt with numeric Unix epoch seconds
      {
        scope: 'project',
        project_id: 'event-proj',
        kind: 'response',
        output: 'Numeric epoch',
        eventAt: 1685404800, // 2023-05-30T00:00:00.000Z
      },
      // 2: explicit null
      {
        scope: 'project',
        project_id: 'event-proj',
        kind: 'prompt',
        input: 'Null event_at',
        event_at: null,
      },
      // 3: empty string -> stored as null
      {
        scope: 'project',
        project_id: 'event-proj',
        kind: 'prompt',
        input: 'Empty event_at',
        event_at: '   ',
      },
      // 4: omitted -> stored as null
      {
        scope: 'project',
        project_id: 'event-proj',
        kind: 'prompt',
        input: 'Omitted event_at',
      },
      // 5: invalid ISO string -> dead-lettered as schema_invalid
      {
        scope: 'project',
        project_id: 'event-proj',
        kind: 'prompt',
        input: 'Bad string',
        event_at: 'not-a-timestamp',
      },
      // 6: non-finite number -> dead-lettered as schema_invalid
      {
        scope: 'project',
        project_id: 'event-proj',
        kind: 'prompt',
        input: 'NaN epoch',
        event_at: Number.NaN,
      },
      // 7: invalid type (boolean) -> dead-lettered as schema_invalid
      {
        scope: 'project',
        project_id: 'event-proj',
        kind: 'prompt',
        input: 'Boolean event_at',
        event_at: true,
      },
    ]);

    expect(result.accepted).toBe(5);
    expect(result.rejected).toHaveLength(3);
    expect(result.rejected.map((r) => r.index)).toEqual([5, 6, 7]);
    expect(result.rejected.every((r) => r.reason === 'schema_invalid')).toBe(true);

    expect(getObservation(result.ids[0])?.event_at).toBe('2023-05-30T15:00:00.000Z');
    expect(getObservation(result.ids[1])?.event_at).toBe('2023-05-30T00:00:00.000Z');
    expect(getObservation(result.ids[2])?.event_at).toBeNull();
    expect(getObservation(result.ids[3])?.event_at).toBeNull();
    expect(getObservation(result.ids[4])?.event_at).toBeNull();

    const deadLetters = listDeadLetters({ source: 'capture' });
    expect(deadLetters).toHaveLength(3);
    expect(deadLetters.every((dl) => dl.reason === 'schema_invalid')).toBe(true);
  });
});
