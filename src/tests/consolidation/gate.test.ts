import { getDb, resetDb } from '../../lib/db';
import {
  formatConsolidationWarning,
  getConsolidationCandidates,
  getConsolidationStatus,
} from '../../consolidation/candidates';
import {
  verifyAndStoreSummary,
  computeArithmeticOutcome,
  type ConsolidationSubmission,
} from '../../consolidation/gate';
import {
  seedFixtureObservations,
  runAiConformanceDiagnostics,
} from '../../consolidation/fixtures';
import { listDeadLetters } from '../../memory/deadLetterStore';
import { captureObservations } from '../../memory/observationStore';

describe('consolidation gate', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    resetDb();
  });

  afterEach(() => {
    resetDb();
    process.env = { ...originalEnv };
  });

  it('leases unconsolidated observations with non-overlapping leases and expiration', () => {
    // Capture observations for 2 separate sessions
    captureObservations([
      {
        scope: 'project',
        project_id: 'proj1',
        session_id: 'sess-A',
        kind: 'tool_call',
        tool_name: 'Edit',
        file_path: 'src/lib/db.ts',
        input: 'edit',
        output: 'saved',
        duration_ms: 100,
        failed: 0,
      },
      {
        scope: 'project',
        project_id: 'proj1',
        session_id: 'sess-B',
        kind: 'tool_call',
        tool_name: 'Edit',
        file_path: 'src/app.ts',
        input: 'edit',
        output: 'saved',
        duration_ms: 120,
        failed: 0,
      },
    ]);

    const res1 = getConsolidationCandidates({ projectId: 'proj1', leaseDurationSec: 300 });
    expect(res1.candidates.length).toBe(2);
    expect(res1.candidates[0].lease_id).toMatch(/^l-/);
    expect(res1.candidates[0].expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // Calling again immediately while leases are active returns 0 candidates
    const res2 = getConsolidationCandidates({ projectId: 'proj1' });
    expect(res2.candidates.length).toBe(0);
  });

  it('verifies and stores a valid summary round-trip with arithmetic outcome', () => {
    const fx1 = seedFixtureObservations('session-test-roundtrip', 'fx1');

    const submission: ConsolidationSubmission = {
      lease_id: fx1.leaseId,
      outcome: 'success', // Producer claimed success, BUT observations have failed = 1!
      files_touched: ['src/routes/memories.ts'],
      error_verbatim:
        "TypeError: Cannot read properties of undefined (reading 'id')\n      at src/routes/memories.ts:18:34",
      claims: [
        {
          text: 'npm test failed with TypeError in src/routes/memories.ts',
          source_ids: [fx1.obsIds[0]],
        },
      ],
      producer_tier: 'agent',
    };

    const res = verifyAndStoreSummary(submission);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.status).toBe(201);
    expect(res.summary_id).toMatch(/^sum_/);
    // Producer submitted "success", but arithmetic recomputation enforces "failure"!
    expect(res.outcome).toBe('failure');

    const db = getDb();
    const storedSummary = db
      .prepare('SELECT * FROM summaries WHERE id = ?')
      .get(res.summary_id) as any;
    expect(storedSummary).toBeDefined();
    expect(storedSummary.verified).toBe(1);
    expect(storedSummary.outcome).toBe('failure');

    const claims = db
      .prepare('SELECT * FROM summary_claims WHERE summary_id = ?')
      .all(res.summary_id);
    expect(claims.length).toBe(1);

    const sources = db
      .prepare('SELECT * FROM summary_sources WHERE summary_id = ?')
      .all(res.summary_id) as any[];
    expect(sources.length).toBe(1);
    expect(sources[0].record_id).toBe(fx1.obsIds[0]);
  });

  it('rejects unresolved citations with 422 and records to dead_letters', () => {
    const fx1 = seedFixtureObservations('session-bad-cit', 'fx1');

    const submission: ConsolidationSubmission = {
      lease_id: fx1.leaseId,
      claims: [
        {
          text: 'Hallucinated claim',
          source_ids: ['obs_nonexistent_fake_id_123'],
        },
      ],
      producer_tier: 'agent',
      producer_model: 'claude-3-5',
    };

    const res = verifyAndStoreSummary(submission);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.status).toBe(422);
    expect(res.reason).toBe('citation_unresolved');
    expect(res.message).toContain('obs_nonexistent_fake_id_123');

    // Verify dead_letter record
    const deadLetters = listDeadLetters({ source: 'consolidate', reason: 'citation_unresolved' });
    expect(deadLetters.length).toBe(1);
    expect(deadLetters[0].producer).toBe('claude-3-5');
    expect(deadLetters[0].payload).toContain('obs_nonexistent_fake_id_123');
  });

  it('rejects non-verbatim error_verbatim with 422 not_verbatim', () => {
    const fx1 = seedFixtureObservations('session-bad-err', 'fx1');

    const submission: ConsolidationSubmission = {
      lease_id: fx1.leaseId,
      error_verbatim: 'This error was completely made up by the model',
      claims: [{ text: 'Some claim', source_ids: [fx1.obsIds[0]] }],
      producer_tier: 'agent',
    };

    const res = verifyAndStoreSummary(submission);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.status).toBe(422);
    expect(res.reason).toBe('not_verbatim');
    expect(res.message).toContain('error_verbatim');
  });

  it('rejects output-only path in files_touched with 422 not_verbatim', () => {
    const fx1 = seedFixtureObservations('session-out-path', 'fx1');

    // In fx1, 'src/tests/memory/trajectoryStore.test.ts' appeared only in command output, not as tool target!
    const submission: ConsolidationSubmission = {
      lease_id: fx1.leaseId,
      files_touched: ['src/tests/memory/trajectoryStore.test.ts'],
      claims: [{ text: 'Ran test', source_ids: [fx1.obsIds[0]] }],
      producer_tier: 'agent',
    };

    const res = verifyAndStoreSummary(submission);
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.status).toBe(422);
    expect(res.reason).toBe('not_verbatim');
    expect(res.message).toContain('files_touched');
  });

  it('rejects truncated finish_reason length and empty_content', () => {
    const fx2 = seedFixtureObservations('session-trunc', 'fx2');

    const truncRes = verifyAndStoreSummary({
      lease_id: fx2.leaseId,
      finish_reason: 'length',
      claims: [{ text: 'Truncated claim', source_ids: [fx2.obsIds[0]] }],
    });
    expect(truncRes.ok).toBe(false);
    if (!truncRes.ok) {
      expect(truncRes.reason).toBe('truncated');
    }

    const emptyRes = verifyAndStoreSummary({
      lease_id: fx2.leaseId,
      raw_response: '   ',
      claims: [],
    });
    expect(emptyRes.ok).toBe(false);
    if (!emptyRes.ok) {
      expect(emptyRes.reason).toBe('empty_content');
    }

    const missingClaimsRes = verifyAndStoreSummary({
      lease_id: fx2.leaseId,
    } as any);
    expect(missingClaimsRes.ok).toBe(false);
    if (!missingClaimsRes.ok) {
      expect(missingClaimsRes.reason).toBe('schema_invalid');
      expect(missingClaimsRes.message).toBe('Submission must contain a claims array');
    }
  });

  it('computes arithmetic outcome: unknown on fx3-sparse', () => {
    const fx3 = seedFixtureObservations('session-sparse', 'fx3');

    const submission: ConsolidationSubmission = {
      lease_id: fx3.leaseId,
      files_touched: ['src/middleware/rateLimiter.ts'],
      claims: [
        {
          text: 'Read src/middleware/rateLimiter.ts',
          source_ids: [fx3.obsIds[0]],
        },
      ],
      producer_tier: 'agent',
    };

    const res = verifyAndStoreSummary(submission);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.outcome).toBe('unknown');
  });

  it('produces single-verdict diagnostics report that cannot report contradictory results', () => {
    const report = runAiConformanceDiagnostics();
    expect(report.total_count).toBeGreaterThan(0);
    expect(report.passed_count).toBe(report.total_count);
    expect(report.all_passing).toBe(true);
    expect(report.status).toBe('ok');
    // Ensure all_passing is strictly (passed_count === total_count)
    expect(report.all_passing).toBe(report.passed_count === report.total_count);
  });

  it('emits consolidation warning when un-consolidated sessions accumulate or age', () => {
    for (let i = 1; i <= 3; i++) {
      captureObservations([
        {
          scope: 'project',
          project_id: 'warn-proj',
          session_id: `sess-warn-${i}`,
          kind: 'tool_call',
          tool_name: 'read_file',
          input: '{}',
          output: 'ok',
        },
      ]);
    }

    const status = getConsolidationStatus('warn-proj');
    expect(status.unconsolidated_sessions).toBe(3);
    expect(status.unconsolidated_observations).toBe(3);
    expect(status.last_consolidated_at).toBeNull();

    const warning = formatConsolidationWarning(status, 'warn-proj');
    expect(warning).toContain('CONSOLIDATION REMINDER');
    expect(warning).toContain("project 'warn-proj'");
    expect(warning).toContain('last consolidated: never');

    // Below threshold when <3 sessions, <50 obs, and recent
    const freshWarning = formatConsolidationWarning(
      {
        unconsolidated_sessions: 1,
        unconsolidated_observations: 10,
        oldest_unconsolidated_at: Math.floor(Date.now() / 1000) - 60,
        last_consolidated_at: null,
      },
      'warn-proj'
    );
    expect(freshWarning).toBeNull();
  });

  it('filters candidates by scope/project_id, excludes verified summary_sources, and caps at 200', () => {
    const db = getDb();
    // Global session with null project_id + same session_id in project scope
    captureObservations([
      {
        scope: 'global',
        session_id: 'shared-sess',
        kind: 'tool_call',
        tool_name: 'Read',
        input: 'global read',
        output: 'ok',
      },
      {
        scope: 'project',
        project_id: 'p-other',
        session_id: 'shared-sess',
        kind: 'tool_call',
        tool_name: 'Read',
        input: 'proj read',
        output: 'ok',
      },
    ]);

    const res = getConsolidationCandidates({ limit: 10 });
    expect(res.candidates).toHaveLength(2);
    const globalCand = res.candidates.find((c) => c.scope === 'global');
    const projCand = res.candidates.find((c) => c.scope === 'project');
    expect(globalCand?.observations).toHaveLength(1);
    expect(globalCand?.observations[0].scope).toBe('global');
    expect(projCand?.observations).toHaveLength(1);
    expect(projCand?.observations[0].project_id).toBe('p-other');

    // Verify 205 observations in one session caps at 200 per lease and excludes already-verified ones
    const bulk = Array.from({ length: 205 }, (_, i) => ({
      scope: 'project' as const,
      project_id: 'p-cap',
      session_id: 'sess-cap',
      kind: 'tool_call' as const,
      tool_name: 'Read',
      input: `read ${i}`,
      output: 'ok',
    }));
    captureObservations(bulk);

    const capRes1 = getConsolidationCandidates({ projectId: 'p-cap' });
    expect(capRes1.candidates).toHaveLength(1);
    expect(capRes1.candidates[0].observations).toHaveLength(200);

    // Consolidate the first 200
    const verify1 = verifyAndStoreSummary({
      lease_id: capRes1.candidates[0].lease_id,
      claims: [{ text: 'Read 200 files', source_ids: [capRes1.candidates[0].observation_ids[0]] }],
    });
    expect(verify1.ok).toBe(true);

    // Wait: only 1 of 200 was cited in summary_sources; remaining 204 are still unconsolidated,
    // and the 1 cited observation must be excluded from the next lease
    const capRes2 = getConsolidationCandidates({ projectId: 'p-cap' });
    expect(capRes2.candidates).toHaveLength(1);
    expect(capRes2.candidates[0].observation_ids).not.toContain(
      capRes1.candidates[0].observation_ids[0]
    );
    expect(db.prepare('SELECT COUNT(*) as c FROM observations WHERE session_id = ?').get('sess-cap')).toEqual({ c: 205 });
  });

  it('redacts secrets, deduplicates source_ids, checks archive, enforces expires_at <= now, and validates raw_response strictly', () => {
    const db = getDb();
    const fx1 = seedFixtureObservations('sess-gate-fixes', 'fx1');

    // 1. Strict raw_response: empty JSON object must NOT fall back to submission.claims
    const strictRes = verifyAndStoreSummary({
      lease_id: fx1.leaseId,
      claims: [{ text: 'Fallback claim', source_ids: [fx1.obsIds[0]] }],
      raw_response: '{}',
    });
    expect(strictRes.ok).toBe(false);
    if (!strictRes.ok) {
      expect(strictRes.reason).toBe('schema_invalid');
    }

    // 2. Deduplicate source_ids & redact secrets in claim.text
    const dupAndSecretRes = verifyAndStoreSummary({
      lease_id: fx1.leaseId,
      claims: [
        {
          text: 'Used key sk-proj-abcdefghijklmnopqrstuvwxyz123456 in test',
          source_ids: [fx1.obsIds[0], fx1.obsIds[0]],
        },
      ],
    });
    expect(dupAndSecretRes.ok).toBe(true);
    if (dupAndSecretRes.ok) {
      const claimRow = db
        .prepare('SELECT text FROM summary_claims WHERE summary_id = ?')
        .get(dupAndSecretRes.summary_id) as { text: string };
      expect(claimRow.text).toContain('[REDACTED_API_KEY]');
      expect(claimRow.text).not.toContain('sk-proj-');

      const srcCount = db
        .prepare('SELECT COUNT(*) as c FROM summary_sources WHERE summary_id = ?')
        .get(dupAndSecretRes.summary_id) as { c: number };
      expect(srcCount.c).toBe(1);
    }

    // 3. Archived observations lookup & expires_at <= now boundary
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO observations_archive (
        id, original_observation_id, scope, project_id, session_id, kind, tool_name,
        file_path, input, output, duration_ms, failed, created_at, archived_at
      ) VALUES ('arc_1', 'obs_archived_1', 'project', 'p-arc', 'sess-arc', 'tool_call', 'Edit', 'src/a.ts', 'in', 'out', 10, 0, ?, ?)
    `).run(now - 100, now - 10);

    // Expired at exact boundary (expires_at = now)
    db.prepare(`
      INSERT INTO consolidation_leases (
        lease_id, kind, scope, project_id, session_id, observation_ids, created_at, expires_at, completed_at
      ) VALUES ('l-boundary', 'session', 'project', 'p-arc', 'sess-arc', '["obs_archived_1"]', ?, ?, NULL)
    `).run(now - 100, now);

    const expiredRes = verifyAndStoreSummary({
      lease_id: 'l-boundary',
      claims: [{ text: 'Archived edit', source_ids: ['obs_archived_1'] }],
    });
    expect(expiredRes.ok).toBe(false);
    if (!expiredRes.ok) {
      expect(expiredRes.message).toContain('expired');
    }

    // Active lease referencing archived observation
    db.prepare(`
      INSERT INTO consolidation_leases (
        lease_id, kind, scope, project_id, session_id, observation_ids, created_at, expires_at, completed_at
      ) VALUES ('l-arc-ok', 'session', 'project', 'p-arc', 'sess-arc', '["obs_archived_1"]', ?, ?, NULL)
    `).run(now - 100, now + 300);

    const arcRes = verifyAndStoreSummary({
      lease_id: 'l-arc-ok',
      files_touched: ['src/a.ts'],
      claims: [{ text: 'Edited src/a.ts', source_ids: ['obs_archived_1'] }],
    });
    expect(arcRes.ok).toBe(true);
  });
});
