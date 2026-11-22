import {
  upsertFailurePattern,
  getFailurePatterns,
  formatCriticalWarnings,
  sanitizeErrorText,
} from '../../memory/failurePatternStore';
import { getDb, resetDb } from '../../lib/db';

beforeEach(() => {
  resetDb();
  process.env.DATABASE_URL = ':memory:';
  getDb();
});

afterAll(() => {
  resetDb();
});

describe('failurePatternStore', () => {
  it('upserts project-scoped failure patterns and increments count atomically', () => {
    const projectId = 'proj-err';
    const taskType = 'migration';
    const errorText = 'FOREIGN KEY constraint failed';

    const id1 = upsertFailurePattern({
      scope: 'project',
      projectId,
      taskType,
      errorText,
    });

    const patterns1 = getFailurePatterns({ projectId, taskType });
    expect(patterns1).toHaveLength(1);
    expect(patterns1[0].count).toBe(1);

    const id2 = upsertFailurePattern({
      scope: 'project',
      projectId,
      taskType,
      errorText,
    });

    expect(id2).toBe(id1);

    const patterns2 = getFailurePatterns({ projectId, taskType });
    expect(patterns2).toHaveLength(1);
    expect(patterns2[0].count).toBe(2);
  });

  it('upserts global and unknown scoped failure patterns and increments count', () => {
    const errorText = 'ENOMEM: Out of memory';

    const id1 = upsertFailurePattern({
      scope: 'global',
      projectId: null,
      taskType: 'build',
      errorText,
    });

    const id2 = upsertFailurePattern({
      scope: 'global',
      projectId: null,
      taskType: 'build',
      errorText,
    });

    expect(id2).toBe(id1);

    const patterns = getFailurePatterns({ taskType: 'build', includeGlobal: true });
    expect(patterns).toHaveLength(1);
    expect(patterns[0].count).toBe(2);
  });

  it('formats critical warnings per reference specification', () => {
    const patterns = [
      { task_type: 'migration', error_text: 'FOREIGN KEY constraint failed', count: 4 },
      { task_type: 'deploy', error_text: 'Connection refused port 5432', count: 2 },
    ];

    const formatted = formatCriticalWarnings(patterns);
    expect(formatted).toContain('CRITICAL WARNINGS (Learn from past failures in this project):');
    expect(formatted).toContain("- Previous failure when attempting task type 'migration': FOREIGN KEY constraint failed (occurred 4 times)");
    expect(formatted).toContain("- Previous failure when attempting task type 'deploy': Connection refused port 5432 (occurred 2 times)");
  });

  it('returns empty string if no patterns to format', () => {
    expect(formatCriticalWarnings([])).toBe('');
  });

  it('redacts secrets in sanitizeErrorText and upsertFailurePattern', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456';
    const cleaned = sanitizeErrorText(`Auth failed with ${secret}`);
    expect(cleaned).not.toContain(secret);
    expect(cleaned).toContain('[REDACTED_API_KEY]');

    upsertFailurePattern({
      scope: 'project',
      projectId: 'proj-sec',
      taskType: 'deploy',
      errorText: `Token leaked: ghp_abcdefghijklmnopqrstuvwxyz123456`,
    });
    const patterns = getFailurePatterns({ projectId: 'proj-sec', taskType: 'deploy' });
    expect(patterns).toHaveLength(1);
    expect(patterns[0].error_text).not.toContain('ghp_');
    expect(patterns[0].error_text).toContain('[REDACTED_TOKEN]');
  });

  it('stores user_id and agent_id, supports hierarchical scoping and userId filter, and attaches match_tier', () => {
    upsertFailurePattern({
      scope: 'project',
      projectId: 'acme',
      userId: 'alice',
      agentId: 'claude',
      taskType: 'build',
      errorText: 'Root workspace build error',
    });

    upsertFailurePattern({
      scope: 'project',
      projectId: 'acme/socials',
      userId: 'bob',
      agentId: 'antigravity',
      taskType: 'build',
      errorText: 'Socials package build error',
    });

    upsertFailurePattern({
      scope: 'project',
      projectId: 'acme/socials/calendar',
      agentId: 'cursor',
      taskType: 'build',
      errorText: 'Calendar module build error',
    });

    // Updating existing conflict coalesces user_id / agent_id
    upsertFailurePattern({
      scope: 'project',
      projectId: 'acme/socials/calendar',
      userId: 'alice',
      taskType: 'build',
      errorText: 'Calendar module build error',
    });

    upsertFailurePattern({
      scope: 'global',
      userId: 'alice',
      agentId: 'claude',
      taskType: 'build',
      errorText: 'Global build failure',
    });

    const hier = getFailurePatterns({ projectId: 'acme/socials/calendar', taskType: 'build' });
    const byError = new Map(hier.map((p) => [p.error_text, p]));
    expect(byError.get('Calendar module build error')?.match_tier).toBe('exact');
    expect(byError.get('Calendar module build error')?.user_id).toBe('alice');
    expect(byError.get('Calendar module build error')?.agent_id).toBe('cursor');
    expect(byError.get('Socials package build error')?.match_tier).toBe('ancestor');
    expect(byError.get('Root workspace build error')?.match_tier).toBe('ancestor');
    expect(byError.get('Global build failure')?.match_tier).toBe('global');

    // includeAncestors=false excludes parent failures
    const noAncestors = getFailurePatterns({
      projectId: 'acme/socials/calendar',
      includeAncestors: false,
      includeGlobal: false,
    });
    expect(noAncestors.map((p) => p.error_text)).toEqual(['Calendar module build error']);

    // includeChildren=true from parent picks up children
    const withChildren = getFailurePatterns({
      projectId: 'acme',
      includeChildren: true,
      includeGlobal: false,
    });
    expect(withChildren.find((p) => p.project_id === 'acme/socials/calendar')?.match_tier).toBe('child');

    // userId filter filters by user_id and NEVER by agent_id
    const aliceOnly = getFailurePatterns({
      projectId: 'acme/socials/calendar',
      userId: 'alice',
    });
    expect(aliceOnly.map((p) => p.error_text).sort()).toEqual([
      'Calendar module build error',
      'Global build failure',
      'Root workspace build error',
    ]);
  });
});
