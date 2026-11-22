import { getDb, resetDb } from '../../lib/db';
import { resetCircuitBreakers } from '../../ai/circuitBreaker';
import { resetReasoningProbeCache } from '../../ai/chat';
import { renderObservationLog, runConsolidation } from '../../consolidation/runner';
import { listDeadLetters } from '../../memory/deadLetterStore';
import { captureObservations } from '../../memory/observationStore';

/** Pulls the observation ids back out of the rendered log in the prompt. */
function idsFromPrompt(body: string): string[] {
  const parsed = JSON.parse(body);
  const user: string =
    parsed.messages?.find((m: any) => m.role === 'user')?.content ??
    parsed.contents?.[0]?.parts?.[0]?.text ??
    '';
  return Array.from(user.matchAll(/\[id=(obs_[^\]\s]+)\]/g)).map((m) => m[1]);
}

function openAiReply(content: string, finishReason = 'stop') {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      model: 'gpt-4o-mini-2024-07-18',
      choices: [{ message: { content }, finish_reason: finishReason }],
    }),
    text: async () => content,
  } as unknown as Response;
}

function seedFailingSession(sessionId = 'sess-run-1') {
  captureObservations([
    {
      scope: 'project',
      project_id: 'proj-run',
      session_id: sessionId,
      kind: 'tool_call',
      tool_name: 'ExecuteCommand',
      input: 'npm test -- memories',
      output: "TypeError: Cannot read properties of undefined (reading 'id')",
      duration_ms: 500,
      failed: 1,
    },
    {
      scope: 'project',
      project_id: 'proj-run',
      session_id: sessionId,
      kind: 'tool_call',
      tool_name: 'Edit',
      file_path: 'src/routes/memories.ts',
      input: 'add optional chaining',
      output: 'saved',
      duration_ms: 120,
      failed: 0,
    },
  ]);
}

describe('vendor-driven consolidation run', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'none';
    process.env.BRAIN_CHAT_PROBE = '0';
    process.env.BRAIN_AI = 'vendor';
    process.env.BRAIN_VENDOR = 'openai';
    process.env.BRAIN_VENDOR_MODEL = 'gpt-4o-mini';
    process.env.OPENAI_API_KEY = 'sk-test';
    delete process.env.BRAIN_AI_FALLBACK;
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    resetDb();
    resetCircuitBreakers();
    resetReasoningProbeCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetDb();
    resetCircuitBreakers();
    resetReasoningProbeCache();
    process.env = { ...originalEnv };
  });

  it('renders the log with ids a producer can cite, and nothing else', () => {
    const log = renderObservationLog(
      [
        {
          id: 'obs_a',
          scope: 'project',
          project_id: 'p',
          note_ref: null,
          task_ref: null,
          session_id: 's',
          agent: null,
          kind: 'tool_call',
          tool_name: 'Read',
          file_path: 'src/app.ts',
          input: 'x'.repeat(50),
          output: 'y'.repeat(50),
          duration_ms: 1,
          failed: 0,
          created_at: 1,
          archived_at: null,
        },
      ],
      10
    );

    expect(log).toContain('OBSERVATION COUNT: 1');
    expect(log).toContain('[id=obs_a]');
    expect(log).toContain('file_path=src/app.ts');
    expect(log).toContain('…[truncated, 40 chars omitted]');
  });

  it('stores a verified vendor summary attributed to vendor tier and model', async () => {
    seedFailingSession();
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const ids = idsFromPrompt(init.body);
      return openAiReply(
        JSON.stringify({
          files_touched: ['src/routes/memories.ts'],
          error_verbatim: "TypeError: Cannot read properties of undefined (reading 'id')",
          claims: [
            { text: 'npm test -- memories failed', source_ids: [ids[0]] },
            { text: 'src/routes/memories.ts was edited', source_ids: [ids[1]] },
          ],
        })
      );
    });

    const report = await runConsolidation({ projectId: 'proj-run' });

    expect(report.status).toBe('ok');
    expect(report.tier).toBe('vendor');
    expect(report.stored).toHaveLength(1);
    expect(report.rejected).toHaveLength(0);
    expect(report.stored[0].outcome).toBe('failure');
    expect(report.stored[0].claims_count).toBe(2);
    expect(report.stored[0].producer_tier).toBe('vendor');
    expect(report.stored[0].producer_model).toBe('openai/gpt-4o-mini');

    const db = getDb();
    const row = db
      .prepare('SELECT * FROM summaries WHERE id = ?')
      .get(report.stored[0].summary_id) as any;
    expect(row.producer_tier).toBe('vendor');
    expect(row.producer_model).toBe('openai/gpt-4o-mini');
    expect(row.prompt_version).toBe('extract-v1');
    expect(row.verified).toBe(1);

    // Rule 6: "regenerate everything this vendor wrote" is one SQL predicate.
    const byProducer = db
      .prepare('SELECT COUNT(*) as c FROM summaries WHERE producer_tier = ? AND producer_model = ?')
      .get('vendor', 'openai/gpt-4o-mini') as { c: number };
    expect(byProducer.c).toBe(1);

    const sources = db
      .prepare('SELECT * FROM summary_sources WHERE summary_id = ?')
      .all(report.stored[0].summary_id) as any[];
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => s.record_type === 'observation')).toBe(true);
  }, 15000);

  it('applies the verification gate to a vendor producer with no bypass', async () => {
    const cases: Array<{ name: string; content: string; finish?: string; reason: string }> = [
      { name: 'empty content', content: '', reason: 'empty_content' },
      { name: 'truncated', content: '{"claims":[', finish: 'length', reason: 'truncated' },
      {
        name: 'markdown fence',
        content: '```json\n{"claims":[{"text":"x","source_ids":["obs_1"]}]}\n```',
        reason: 'unparseable',
      },
      {
        name: 'prose around the json',
        content: 'Sure! Here is the extraction: {"claims":[]}',
        reason: 'unparseable',
      },
      {
        name: 'forbidden narrative field',
        content:
          '{"narrative":"likely part of an audit process","claims":[{"text":"x","source_ids":["CITE0"]}]}',
        reason: 'schema_invalid',
      },
      {
        name: 'fabricated citation',
        content: '{"claims":[{"text":"something happened","source_ids":["obs_does_not_exist"]}]}',
        reason: 'citation_unresolved',
      },
      {
        name: 'invented error string',
        content:
          '{"error_verbatim":"Error: the database is on fire","claims":[{"text":"a claim","source_ids":["CITE0"]}]}',
        reason: 'not_verbatim',
      },
      {
        name: 'path that only appeared in command output',
        content:
          '{"files_touched":["src/tests/memory/trajectoryStore.test.ts"],"claims":[{"text":"a claim","source_ids":["CITE0"]}]}',
        reason: 'not_verbatim',
      },
    ];

    for (const testCase of cases) {
      resetDb();
      resetCircuitBreakers();
      seedFailingSession(`sess-${testCase.reason}-${cases.indexOf(testCase)}`);

      fetchMock.mockImplementation(async (_url: string, init: any) => {
        const ids = idsFromPrompt(init.body);
        return openAiReply(
          testCase.content.replace('CITE0', ids[0] ?? 'obs_missing'),
          testCase.finish ?? 'stop'
        );
      });

      const report = await runConsolidation({ projectId: 'proj-run' });

      expect(report.stored).toHaveLength(0);
      expect(report.rejected).toHaveLength(1);
      expect(report.rejected[0].reason).toBe(testCase.reason);
      expect(report.rejected[0].producer_model).toBe('openai/gpt-4o-mini');

      // Nothing stored, and the reject is recorded against the producer.
      const summaryCount = getDb().prepare('SELECT COUNT(*) as c FROM summaries').get() as {
        c: number;
      };
      expect(summaryCount.c).toBe(0);

      const deadLetters = listDeadLetters({ source: 'consolidate' });
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0].reason).toBe(testCase.reason);
      expect(deadLetters[0].producer).toBe('openai/gpt-4o-mini');
    }
  }, 30000);

  it('releases the lease and writes no dead letter when the producer is unreachable', async () => {
    seedFailingSession('sess-down');
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({}),
      text: async () => 'down',
    } as unknown as Response);

    const report = await runConsolidation({ projectId: 'proj-run' });

    expect(report.status).toBe('unavailable');
    expect(report.stored).toHaveLength(0);
    expect(report.rejected).toHaveLength(0);
    expect(report.released).toHaveLength(1);

    // Rule 3: a dependency being down is never a dead letter.
    expect(listDeadLetters({ source: 'consolidate' })).toHaveLength(0);

    const lease = getDb()
      .prepare('SELECT * FROM consolidation_leases WHERE lease_id = ?')
      .get(report.released[0].lease_id) as any;
    expect(lease.completed_at).toBeNull();
    expect(lease.expires_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    // Released, so the same session is a candidate again for a live producer.
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const ids = idsFromPrompt(init.body);
      return openAiReply(
        JSON.stringify({ claims: [{ text: 'a claim', source_ids: [ids[0]] }] })
      );
    });
    const retry = await runConsolidation({ projectId: 'proj-run' });
    expect(retry.stored).toHaveLength(1);
  }, 20000);

  it("does nothing and says so when the tier is 'none' or 'agent'", async () => {
    seedFailingSession('sess-off');

    process.env.BRAIN_AI = 'none';
    const off = await runConsolidation({ projectId: 'proj-run' });
    expect(off.status).toBe('disabled');
    expect(off.considered).toBe(0);

    process.env.BRAIN_AI = 'agent';
    const agent = await runConsolidation({ projectId: 'proj-run' });
    expect(agent.status).toBe('agent');
    expect(agent.considered).toBe(0);
    expect(agent.message).toContain('/consolidate/candidates');

    // No model was called and, crucially, no candidate was leased away from
    // the host agent.
    expect(fetchMock).not.toHaveBeenCalled();
    const leases = getDb().prepare('SELECT COUNT(*) as c FROM consolidation_leases').get() as {
      c: number;
    };
    expect(leases.c).toBe(0);
  });

  it('reports a misconfiguration instead of half-running', async () => {
    process.env.BRAIN_AI = 'vendor';
    delete process.env.BRAIN_VENDOR;

    const report = await runConsolidation({ projectId: 'proj-run' });
    expect(report.status).toBe('misconfigured');
    expect(report.message).toMatch(/requires BRAIN_VENDOR/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('backs off rejected leases instead of releasing them in a tight re-lease/dead-letter loop', async () => {
    seedFailingSession('sess-backoff');
    fetchMock.mockResolvedValue(openAiReply(''));

    const first = await runConsolidation({ projectId: 'proj-run' });
    expect(first.rejected).toHaveLength(1);
    expect(listDeadLetters({ source: 'consolidate' })).toHaveLength(1);

    // Immediate second run must not re-lease or dead-letter the same session
    const second = await runConsolidation({ projectId: 'proj-run' });
    expect(second.considered).toBe(0);
    expect(second.rejected).toHaveLength(0);
    expect(listDeadLetters({ source: 'consolidate' })).toHaveLength(1);
  });
});
