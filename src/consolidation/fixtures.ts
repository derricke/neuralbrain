import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { verifyAndStoreSummary, type ConsolidationSubmission } from './gate';

export interface ConformanceCheckResult {
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
  details?: Record<string, any>;
}

export interface AiDiagnosticsReport {
  status: 'ok' | 'failed';
  all_passing: boolean;
  passed_count: number;
  total_count: number;
  results: ConformanceCheckResult[];
}

export function seedFixtureObservations(
  sessionId: string,
  fixtureKey: 'fx1' | 'fx2' | 'fx3'
): { leaseId: string; obsIds: string[] } {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const leaseId = `l-${fixtureKey}-${randomUUID().slice(0, 8)}`;

  let obsDefs: Array<{
    id: string;
    kind: 'tool_call' | 'prompt';
    tool_name: string | null;
    file_path: string | null;
    input: string | null;
    output: string | null;
    duration_ms: number;
    failed: number;
  }> = [];

  if (fixtureKey === 'fx1') {
    obsDefs = [
      {
        id: `obs_${fixtureKey}_1_${randomUUID().slice(0, 6)}`,
        kind: 'tool_call',
        tool_name: 'ExecuteCommand',
        file_path: null,
        input: 'npm test -- memories',
        output:
          "FAIL src/tests/memory/trajectoryStore.test.ts\nTypeError: Cannot read properties of undefined (reading 'id')\n      at src/routes/memories.ts:18:34",
        duration_ms: 500,
        failed: 1,
      },
      {
        id: `obs_${fixtureKey}_2_${randomUUID().slice(0, 6)}`,
        kind: 'tool_call',
        tool_name: 'Edit',
        file_path: 'src/routes/memories.ts',
        input: 'fix optional chaining',
        output: 'saved file src/routes/memories.ts',
        duration_ms: 120,
        failed: 0,
      },
      {
        id: `obs_${fixtureKey}_3_${randomUUID().slice(0, 6)}`,
        kind: 'tool_call',
        tool_name: 'ExecuteCommand',
        file_path: null,
        input: 'npm test -- memories',
        output:
          "FAIL src/tests/memory/trajectoryStore.test.ts\nTypeError: Cannot read properties of undefined (reading 'id')\n      at src/routes/memories.ts:18:34",
        duration_ms: 480,
        failed: 1,
      },
      {
        id: `obs_${fixtureKey}_4_${randomUUID().slice(0, 6)}`,
        kind: 'tool_call',
        tool_name: 'ExecuteCommand',
        file_path: null,
        input: 'npm test -- memories',
        output:
          "FAIL src/tests/memory/trajectoryStore.test.ts\nTypeError: Cannot read properties of undefined (reading 'id')\n      at src/routes/memories.ts:18:34",
        duration_ms: 490,
        failed: 1,
      },
    ];
  } else if (fixtureKey === 'fx2') {
    obsDefs = [
      {
        id: `obs_${fixtureKey}_1_${randomUUID().slice(0, 6)}`,
        kind: 'tool_call',
        tool_name: 'Edit',
        file_path: 'src/learning/embedding.ts',
        input: 'edit embedder',
        output: 'saved',
        duration_ms: 200,
        failed: 0,
      },
      {
        id: `obs_${fixtureKey}_2_${randomUUID().slice(0, 6)}`,
        kind: 'tool_call',
        tool_name: 'Edit',
        file_path: 'src/learning/engine.ts',
        input: 'edit engine',
        output: 'saved',
        duration_ms: 210,
        failed: 0,
      },
      {
        id: `obs_${fixtureKey}_3_${randomUUID().slice(0, 6)}`,
        kind: 'tool_call',
        tool_name: 'Edit',
        file_path: 'src/memory/trajectoryStore.ts',
        input: 'edit trajectory',
        output: 'saved',
        duration_ms: 180,
        failed: 0,
      },
      {
        id: `obs_${fixtureKey}_4_${randomUUID().slice(0, 6)}`,
        kind: 'tool_call',
        tool_name: 'Edit',
        file_path: 'src/tests/learning/engine.test.ts',
        input: 'edit tests',
        output: 'saved',
        duration_ms: 190,
        failed: 0,
      },
      {
        id: `obs_${fixtureKey}_5_${randomUUID().slice(0, 6)}`,
        kind: 'tool_call',
        tool_name: 'ExecuteCommand',
        file_path: null,
        input: 'npm test',
        output: 'PASS src/tests/learning/engine.test.ts\n127 passed, 127 total',
        duration_ms: 1200,
        failed: 0,
      },
    ];
  } else {
    // fx3 sparse
    obsDefs = [
      {
        id: `obs_${fixtureKey}_1_${randomUUID().slice(0, 6)}`,
        kind: 'tool_call',
        tool_name: 'Read',
        file_path: 'src/middleware/rateLimiter.ts',
        input: 'path: src/middleware/rateLimiter.ts',
        output: '<101 lines returned>',
        duration_ms: 45,
        failed: 0,
      },
    ];
  }

  const obsIds = obsDefs.map((o) => o.id);

  const insertObs = db.prepare(`
    INSERT INTO observations (
      id, scope, project_id, session_id, kind, tool_name, file_path, input, output, duration_ms, failed, created_at
    ) VALUES (?, 'project', 'fixture-test', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const o of obsDefs) {
    insertObs.run(
      o.id,
      sessionId,
      o.kind,
      o.tool_name,
      o.file_path,
      o.input,
      o.output,
      o.duration_ms,
      o.failed,
      now
    );
  }

  db.prepare(`
    INSERT INTO consolidation_leases (
      lease_id, kind, scope, project_id, session_id, observation_ids, created_at, expires_at
    ) VALUES (?, 'session', 'project', 'fixture-test', ?, ?, ?, ?)
  `).run(leaseId, sessionId, JSON.stringify(obsIds), now, now + 600);

  return { leaseId, obsIds };
}

export async function probeReasoningTokens(): Promise<{ probed: boolean; reasoningTokens: number; model?: string }> {
  if (process.env.BRAIN_CHAT_PROBE === '0') {
    return { probed: false, reasoningTokens: 0 };
  }

  const endpoint = process.env.BRAIN_ENDPOINT;
  const model = process.env.BRAIN_CHAT_MODEL;

  if (!endpoint || !model) {
    return { probed: false, reasoningTokens: 0 };
  }

  try {
    const client = new OpenAI({
      baseURL: endpoint.replace(/\/$/, ''),
      apiKey: process.env.BRAIN_ENDPOINT_API_KEY || 'no-key',
      timeout: 10000,
    });

    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Say hello in 1 word.' }],
      max_tokens: 100,
    });

    const usage = completion.usage as any;
    // Return the ACTUAL count, not a 0/1 flag. `??` binds tighter than `?:`, so
    // the previous form parsed as `(reasoning_tokens ?? length) ? 1 : 0` and a
    // model reporting 5820 reasoning tokens yielded 1. Callers size the budget
    // as a multiple of this value, so that silently reduced the headroom to
    // near-zero — defeating the one safeguard built from the measured failure
    // where 5820 of 6000 tokens went to reasoning and the reply came back empty.
    const reportedReasoning = usage?.completion_tokens_details?.reasoning_tokens;
    const reasoningTokens =
      typeof reportedReasoning === 'number' && Number.isFinite(reportedReasoning)
        ? reportedReasoning
        : // No usage field: fall back to the length of any reasoning_content the
          // endpoint exposed, which is a lower bound rather than a token count.
          ((completion.choices[0]?.message as any)?.reasoning_content?.length ?? 0);

    if (reasoningTokens > 0) {
      logger.warn(
        { model, reasoningTokens },
        'AI reasoning probe detected reasoning tokens. Ensure BRAIN_CHAT_MAX_TOKENS is sized with adequate headroom.'
      );
    }

    return { probed: true, reasoningTokens, model };
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'reasoning tokens probe skipped or failed');
    return { probed: false, reasoningTokens: 0, model };
  }
}

export function runAiConformanceDiagnostics(): AiDiagnosticsReport {
  const results: ConformanceCheckResult[] = [];
  const allLeaseIds: string[] = [];
  const allObsIds: string[] = [];
  const allSummaryIds: string[] = [];

  const trackSeed = (seeded: { leaseId: string; obsIds: string[] }) => {
    allLeaseIds.push(seeded.leaseId);
    allObsIds.push(...seeded.obsIds);
    return seeded;
  };

  try {
    // Check 1: fx1-failure arithmetic outcome derivation and verbatim check
    const fx1 = trackSeed(seedFixtureObservations(`sess-fx1-${randomUUID().slice(0, 6)}`, 'fx1'));
    const fx1Submission: ConsolidationSubmission = {
      lease_id: fx1.leaseId,
      files_touched: ['src/routes/memories.ts'],
      error_verbatim:
        "TypeError: Cannot read properties of undefined (reading 'id')\n      at src/routes/memories.ts:18:34",
      claims: [
        {
          text: 'npm test -- memories failed with TypeError',
          source_ids: [fx1.obsIds[0], fx1.obsIds[2]],
        },
        {
          text: 'The file src/routes/memories.ts was edited',
          source_ids: [fx1.obsIds[1]],
        },
      ],
      producer_tier: 'agent',
    };
    const fx1Res = verifyAndStoreSummary(fx1Submission);
    if (fx1Res.ok && (fx1Res as any).summary_id) {
      allSummaryIds.push((fx1Res as any).summary_id);
    }
    results.push({
      name: 'fx1-failure: arithmetic outcome and verification',
      pass: fx1Res.ok === true && (fx1Res as any).outcome === 'failure',
      expected: "ok: true, outcome: 'failure'",
      actual: fx1Res.ok ? `ok: true, outcome: ${(fx1Res as any).outcome}` : `failed: ${(fx1Res as any).reason}`,
    });

    // Check 2: fx2-success outcome and multi-file files_touched
    const fx2 = trackSeed(seedFixtureObservations(`sess-fx2-${randomUUID().slice(0, 6)}`, 'fx2'));
    const fx2Submission: ConsolidationSubmission = {
      lease_id: fx2.leaseId,
      files_touched: [
        'src/learning/embedding.ts',
        'src/learning/engine.ts',
        'src/memory/trajectoryStore.ts',
        'src/tests/learning/engine.test.ts',
      ],
      error_verbatim: null,
      claims: [
        {
          text: 'Edited 4 files and tests passed with 127 passed',
          source_ids: [fx2.obsIds[0], fx2.obsIds[4]],
        },
      ],
      producer_tier: 'agent',
    };
    const fx2Res = verifyAndStoreSummary(fx2Submission);
    if (fx2Res.ok && (fx2Res as any).summary_id) {
      allSummaryIds.push((fx2Res as any).summary_id);
    }
    results.push({
      name: 'fx2-success: arithmetic outcome success and 4 paths',
      pass: fx2Res.ok === true && (fx2Res as any).outcome === 'success',
      expected: "ok: true, outcome: 'success'",
      actual: fx2Res.ok ? `ok: true, outcome: ${(fx2Res as any).outcome}` : `failed: ${(fx2Res as any).reason}`,
    });

    // Check 3: fx3-sparse outcome is 'unknown'
    const fx3 = trackSeed(seedFixtureObservations(`sess-fx3-${randomUUID().slice(0, 6)}`, 'fx3'));
    const fx3Submission: ConsolidationSubmission = {
      lease_id: fx3.leaseId,
      files_touched: ['src/middleware/rateLimiter.ts'],
      error_verbatim: null,
      claims: [
        {
          text: 'Read src/middleware/rateLimiter.ts',
          source_ids: [fx3.obsIds[0]],
        },
      ],
      producer_tier: 'agent',
    };
    const fx3Res = verifyAndStoreSummary(fx3Submission);
    if (fx3Res.ok && (fx3Res as any).summary_id) {
      allSummaryIds.push((fx3Res as any).summary_id);
    }
    results.push({
      name: 'fx3-sparse: single bare read yields outcome unknown',
      pass: fx3Res.ok === true && (fx3Res as any).outcome === 'unknown',
      expected: "ok: true, outcome: 'unknown'",
      actual: fx3Res.ok ? `ok: true, outcome: ${(fx3Res as any).outcome}` : `failed: ${(fx3Res as any).reason}`,
    });

    // Check 4: Unresolved citation rejection
    const fx4 = trackSeed(seedFixtureObservations(`sess-fx3-chk4-${randomUUID().slice(0, 6)}`, 'fx3'));
    const badCitationSubmission: ConsolidationSubmission = {
      lease_id: fx4.leaseId,
      claims: [{ text: 'Fake citation claim', source_ids: ['obs_fake_nonexistent_id'] }],
      producer_tier: 'agent',
    };
    const badCitRes = verifyAndStoreSummary(badCitationSubmission);
    results.push({
      name: 'gate: reject unresolved citation with 422',
      pass: badCitRes.ok === false && (badCitRes as any).reason === 'citation_unresolved',
      expected: "ok: false, reason: 'citation_unresolved'",
      actual: badCitRes.ok ? 'ok: true' : `reason: ${(badCitRes as any).reason}`,
    });

    // Check 5: Non-verbatim error string rejection
    const fx5 = trackSeed(seedFixtureObservations(`sess-fx1-chk5-${randomUUID().slice(0, 6)}`, 'fx1'));
    const badErrorSubmission: ConsolidationSubmission = {
      lease_id: fx5.leaseId,
      error_verbatim: 'This error text never existed in the log anywhere!',
      claims: [{ text: 'Some claim', source_ids: [fx5.obsIds[0]] }],
      producer_tier: 'agent',
    };
    const badErrRes = verifyAndStoreSummary(badErrorSubmission);
    results.push({
      name: 'gate: reject non-verbatim error string with 422',
      pass: badErrRes.ok === false && (badErrRes as any).reason === 'not_verbatim',
      expected: "ok: false, reason: 'not_verbatim'",
      actual: badErrRes.ok ? 'ok: true' : `reason: ${(badErrRes as any).reason}`,
    });

    // Check 6: Output-only path in files_touched rejection
    // In fx1, 'src/tests/memory/trajectoryStore.test.ts' appeared in command output, but NEVER as tool target file_path!
    const fx6 = trackSeed(seedFixtureObservations(`sess-fx1-chk6-${randomUUID().slice(0, 6)}`, 'fx1'));
    const outputOnlyPathSubmission: ConsolidationSubmission = {
      lease_id: fx6.leaseId,
      files_touched: ['src/tests/memory/trajectoryStore.test.ts'],
      claims: [{ text: 'Some claim', source_ids: [fx6.obsIds[0]] }],
      producer_tier: 'agent',
    };
    const outPathRes = verifyAndStoreSummary(outputOnlyPathSubmission);
    results.push({
      name: 'gate: reject output-only path in files_touched with 422 not_verbatim',
      pass: outPathRes.ok === false && (outPathRes as any).reason === 'not_verbatim',
      expected: "ok: false, reason: 'not_verbatim'",
      actual: outPathRes.ok ? 'ok: true' : `reason: ${(outPathRes as any).reason}`,
    });

    // Check 7: Truncated finish_reason rejection
    const fx7 = trackSeed(seedFixtureObservations(`sess-fx2-chk7-${randomUUID().slice(0, 6)}`, 'fx2'));
    const truncatedSubmission: ConsolidationSubmission = {
      lease_id: fx7.leaseId,
      finish_reason: 'length',
      claims: [{ text: 'Truncated claim', source_ids: [fx7.obsIds[0]] }],
      producer_tier: 'agent',
    };
    const truncRes = verifyAndStoreSummary(truncatedSubmission);
    results.push({
      name: 'gate: reject truncated finish_reason length with 422',
      pass: truncRes.ok === false && (truncRes as any).reason === 'truncated',
      expected: "ok: false, reason: 'truncated'",
      actual: truncRes.ok ? 'ok: true' : `reason: ${(truncRes as any).reason}`,
    });

    // Check 8: Forbidden field (narrative / importance) rejection
    const fx8 = trackSeed(seedFixtureObservations(`sess-fx2-chk8-${randomUUID().slice(0, 6)}`, 'fx2'));
    const forbiddenSubmission: any = {
      lease_id: fx8.leaseId,
      narrative: 'This was an audit process to understand logic',
      claims: [{ text: 'Valid claim', source_ids: [fx8.obsIds[0]] }],
      producer_tier: 'agent',
    };
    const forbRes = verifyAndStoreSummary(forbiddenSubmission);
    results.push({
      name: 'gate: reject forbidden narrative/importance fields with 422 schema_invalid',
      pass: forbRes.ok === false && (forbRes as any).reason === 'schema_invalid',
      expected: "ok: false, reason: 'schema_invalid'",
      actual: forbRes.ok ? 'ok: true' : `reason: ${(forbRes as any).reason}`,
    });
  } finally {
    // [CR-01] Clean up all synthetic rows created by diagnostics so production SQLite and embed_queue are never polluted
    try {
      const db = getDb();
      if (allSummaryIds.length > 0) {
        const placeholders = allSummaryIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM embed_queue WHERE record_type = 'summary' AND record_id IN (${placeholders})`).run(...allSummaryIds);
        db.prepare(`DELETE FROM summary_claims WHERE summary_id IN (${placeholders})`).run(...allSummaryIds);
        db.prepare(`DELETE FROM summary_sources WHERE summary_id IN (${placeholders})`).run(...allSummaryIds);
        db.prepare(`DELETE FROM summaries WHERE id IN (${placeholders})`).run(...allSummaryIds);
      }
      if (allLeaseIds.length > 0) {
        const placeholders = allLeaseIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM consolidation_leases WHERE lease_id IN (${placeholders})`).run(...allLeaseIds);
        for (const leaseId of allLeaseIds) {
          db.prepare(`DELETE FROM dead_letters WHERE source = 'consolidate' AND payload LIKE ?`).run(`%${leaseId}%`);
        }
      }
      if (allObsIds.length > 0) {
        const placeholders = allObsIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM observations WHERE id IN (${placeholders})`).run(...allObsIds);
      }
      db.prepare(`DELETE FROM observations WHERE project_id = 'fixture-test'`).run();
      db.prepare(`DELETE FROM consolidation_leases WHERE project_id = 'fixture-test'`).run();
      db.prepare(`DELETE FROM dead_letters WHERE source = 'consolidate' AND (payload LIKE '%fixture-test%' OR payload LIKE '%sess-fx%')`).run();
    } catch (cleanupErr: any) {
      logger.warn({ error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) }, 'error cleaning up AI conformance diagnostics fixtures');
    }
  }

  const totalCount = results.length;
  const passedCount = results.filter((r) => r.pass).length;
  const allPassing = passedCount === totalCount;

  return {
    status: allPassing ? 'ok' : 'failed',
    all_passing: allPassing,
    passed_count: passedCount,
    total_count: totalCount,
    results,
  };
}
