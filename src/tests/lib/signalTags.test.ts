import { performance } from 'perf_hooks';
import {
  detectQuerySignalIntent,
  extractSignalTags,
  MAX_SIGNAL_SCAN_CHARS,
} from '../../lib/signalTags';

describe('signalTags — deterministic zero-LLM linguistic signal tagger', () => {
  it('extracts preference tags from user prompts across coding and personal contexts', () => {
    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'I really prefer TypeScript with strict null checks in backend services.',
      })
    ).toEqual(['preference']);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'Always use parameterized SQL queries in node:sqlite.',
      })
    ).toEqual(['preference']);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: "Please don't use Moment.js in new packages.",
      })
    ).toEqual(['preference']);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'Do not use var in modern TypeScript modules.',
      })
    ).toEqual(['preference']);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'My favorite editor is Neovim and my go-to terminal is Ghostty.',
      })
    ).toEqual(['preference']);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'Skip the basics and show the production index migration.',
      })
    ).toEqual(['preference']);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'When I write CLI utilities, I prefer Commander over raw argv parsing.',
      })
    ).toEqual(['preference']);
  });

  it('extracts state_update, completed_action, and planned_action tags in canonical deduplicated order', () => {
    // state_update variants
    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'We recently migrated from Webpack to Vite for the dashboard build.',
      })
    ).toEqual(['state_update']);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'Switched to pnpm workspaces last sprint.',
      })
    ).toEqual(['state_update']);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'We no longer use Redux and replaced `redux-thunk` with Zustand.',
      })
    ).toEqual(['state_update']);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'I stopped using Docker Desktop; now I use OrbStack on macOS.',
      })
    ).toEqual(['state_update']);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'Just started using Biome for formatting.',
      })
    ).toEqual(['state_update']);

    // completed_action
    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'We finally deployed the zero-downtime schema migration and I fixed the flaky test.',
      })
    ).toEqual(['completed_action']);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'I recently bought an ergonomic split keyboard and attended RustConf.',
      })
    ).toEqual(['completed_action']);

    // planned_action
    expect(
      extractSignalTags({
        kind: 'prompt',
        input: "I'm planning to refactor the ingestion pipeline next week.",
      })
    ).toEqual(['planned_action']);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'We need to upgrade the staging cluster before Friday.',
      })
    ).toEqual(['planned_action']);

    // Reverse input order -> canonical output order & deduplication
    expect(
      extractSignalTags({
        kind: 'prompt',
        input: [
          'We are going to benchmark Qdrant tomorrow.',
          'I just finished wiring the SQLite triggers.',
          'Our team recently switched to Node 22.',
          'I strongly prefer deterministic parsers, and I always use strict mode.',
        ].join(' '),
      })
    ).toEqual(['preference', 'state_update', 'completed_action', 'planned_action']);
  });

  it('enforces anti-noise guards on questions, conditionals, tool_calls, and assistant responses', () => {
    // Questions with '?' must NOT emit tags
    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'Do you prefer TypeScript?',
      })
    ).toEqual([]);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'What is my favorite editor?',
      })
    ).toEqual([]);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'Did we recently migrated to Vitest or are we going to upgrade Jest?',
      })
    ).toEqual([]);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'Have we finished the database migration yet?',
      })
    ).toEqual([]);

    // Questions omitting '?' starting with interrogative auxiliaries / WH-words
    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'do I prefer dark mode',
      })
    ).toEqual([]);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'what is my favorite coffee roast',
      })
    ).toEqual([]);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'should we plan to migrate the worker',
      })
    ).toEqual([]);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'when did we switch from Express to Fastify',
      })
    ).toEqual([]);

    // Conditional / negated clauses must NOT falsely emit state_update or preference
    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'If we switched to Bun, CI cache keys might change.',
      })
    ).toEqual([]);

    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'We have not migrated to ESM yet.',
      })
    ).toEqual([]);

    // Assistant response turns MUST NEVER emit 'preference'
    expect(
      extractSignalTags({
        kind: 'response',
        output:
          "If you prefer TypeScript, you might like strict mode! I really love clean types, my favorite setup is Vite, and please don't use any.",
      })
    ).toEqual([]);

    // Assistant conversational meta-chatter must NOT emit planned_action or state_update
    expect(
      extractSignalTags({
        kind: 'response',
        output: "Sure! I'm going to walk you through the migration. Now we have three options.",
      })
    ).toEqual([]);

    // Verbose assistant essay (> 400 chars) must NOT emit tags
    const verboseEssay =
      'We recently migrated from Webpack to Vite and I fixed the build. ' +
      'Here is a detailed explanation of bundler architecture and module resolution across environments. '.repeat(
        6
      );
    expect(verboseEssay.length).toBeGreaterThan(400);
    expect(
      extractSignalTags({
        kind: 'response',
        output: verboseEssay,
      })
    ).toEqual([]);

    // Concise declarative summary on response MAY emit non-preference tags, never preference
    expect(
      extractSignalTags({
        kind: 'response',
        output: 'We migrated from Jest to Vitest and I fixed the snapshot suite. I prefer clean diffs.',
      })
    ).toEqual(['state_update', 'completed_action']);

    // tool_call dumps (e.g. file reads containing preference strings) must NEVER emit tags
    expect(
      extractSignalTags({
        kind: 'tool_call',
        input: 'src/tests/fixture.md',
        output: 'I prefer TypeScript and we just migrated to Vite.',
      })
    ).toEqual([]);
  });

  it('detects preference and state-update query intent accurately', () => {
    expect(detectQuerySignalIntent('What test runner would you recommend for this repo?')).toEqual({
      wantsPreference: true,
      wantsStateUpdate: false,
    });
    expect(detectQuerySignalIntent('Any tips or advice on how should we structure configs?')).toEqual({
      wantsPreference: true,
      wantsStateUpdate: false,
    });
    expect(detectQuerySignalIntent('What database do we currently use in staging?')).toEqual({
      wantsPreference: false,
      wantsStateUpdate: true,
    });
    expect(detectQuerySignalIntent('Are we still using Redis nowadays or did we switched?')).toEqual({
      wantsPreference: false,
      wantsStateUpdate: true,
    });
    expect(
      detectQuerySignalIntent('Based on what we currently use, what linter do you suggest?')
    ).toEqual({
      wantsPreference: true,
      wantsStateUpdate: true,
    });
    expect(detectQuerySignalIntent('SqliteError: FOREIGN KEY constraint failed in db.ts')).toEqual({
      wantsPreference: false,
      wantsStateUpdate: false,
    });
  });

  it('executes in <5ms on 50KB pathological inputs (ReDoS & scan-bound verification)', () => {
    expect(MAX_SIGNAL_SCAN_CHARS).toBe(8_000);

    // Warm up V8 regex JIT once before timing
    extractSignalTags({ kind: 'prompt', input: 'I prefer fast O(N) state machines.' });
    detectQuerySignalIntent('recommend current setup');

    const pathologicalInputs = [
      'i   really   prefer   '.repeat(2_600), // > 57 KB
      `we ${' '.repeat(52_000)}switched to vite`, // > 52 KB whitespace run
      `replaced ${'a'.repeat(52_000)} with vite`, // > 52 KB token without closing 'with'
      `when ${'word '.repeat(11_000)}, do you remember?`, // > 55 KB long clause ending with ?
      `${'?'.repeat(52_000)}a`, // > 52 KB repeated '?' with non-closing trailing char
      `${',   '.repeat(14_000)}x`, // > 56 KB repeated comma-whitespace clauses
      `${'i have   '.repeat(6_000)}something`, // > 54 KB partial completed_action prefixes
    ];

    const measureBestOf3 = <T>(fn: () => T): { result: T; minMs: number } => {
      let minMs = Number.POSITIVE_INFINITY;
      let result!: T;
      for (let attempt = 0; attempt < 3; attempt++) {
        const t0 = performance.now();
        result = fn();
        const dt = performance.now() - t0;
        if (dt < minMs) minMs = dt;
      }
      return { result, minMs };
    };

    for (const payload of pathologicalInputs) {
      expect(payload.length).toBeGreaterThan(50_000);
      const { result: tags, minMs } = measureBestOf3(() =>
        extractSignalTags({ kind: 'prompt', input: payload })
      );
      expect(Array.isArray(tags)).toBe(true);
      expect(minMs).toBeLessThan(5);
    }

    const pathologicalQuery = `recommend${'x'.repeat(52_000)} currently`;
    const { result: intent, minMs: qMinMs } = measureBestOf3(() =>
      detectQuerySignalIntent(pathologicalQuery)
    );
    expect(intent).toEqual({ wantsPreference: false, wantsStateUpdate: false });
    expect(qMinMs).toBeLessThan(5);
  });

  it('handles UTF-16 surrogate pair slice boundaries, malformed inputs, mixed assertion+question prompts, and negated need-to clauses', () => {
    // 1. Malformed / non-string runtime inputs
    expect(extractSignalTags(null as any)).toEqual([]);
    expect(extractSignalTags(undefined as any)).toEqual([]);
    expect(extractSignalTags({ kind: 123 as any, input: {} as any, output: [] as any })).toEqual([]);
    expect(detectQuerySignalIntent(null as any)).toEqual({
      wantsPreference: false,
      wantsStateUpdate: false,
    });
    expect(detectQuerySignalIntent(123 as any)).toEqual({
      wantsPreference: false,
      wantsStateUpdate: false,
    });

    // 2. Astral emoji ('🚀' = \uD83D\uDE80) straddling exact 8,000-char and 4,000-char scan caps
    const prefixBefore8k = 'I prefer deterministic SQLite triggers. ' + 'a'.repeat(8_000 - 40 - 1);
    expect(prefixBefore8k.length).toBe(7_999);
    const surrogateBoundaryPrompt = `${prefixBefore8k}🚀 trailing text`;
    expect(surrogateBoundaryPrompt.charCodeAt(7_999)).toBe(0xd83d);
    expect(surrogateBoundaryPrompt.charCodeAt(8_000)).toBe(0xde80);
    expect(extractSignalTags({ kind: 'prompt', input: surrogateBoundaryPrompt })).toEqual([
      'preference',
    ]);

    const queryPrefixBefore4k = 'Can you recommend ' + 'b'.repeat(4_000 - 18 - 1);
    expect(queryPrefixBefore4k.length).toBe(3_999);
    const surrogateBoundaryQuery = `${queryPrefixBefore4k}🚀 currently`;
    expect(surrogateBoundaryQuery.charCodeAt(3_999)).toBe(0xd83d);
    expect(surrogateBoundaryQuery.charCodeAt(4_000)).toBe(0xde80);
    expect(detectQuerySignalIntent(surrogateBoundaryQuery)).toEqual({
      wantsPreference: true,
      wantsStateUpdate: false,
    });

    // 3. Multi-sentence prompt: declarative preference sentence followed by a question
    expect(
      extractSignalTags({
        kind: 'prompt',
        input:
          'I really enjoy sci-fi novels and prefer hard science fiction. Can you recommend something to read?',
      })
    ).toEqual(['preference']);

    // 4. Negated 'need(s) to' clauses must NOT falsely emit planned_action
    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'We do not need to refactor this module.',
      })
    ).toEqual([]);
    expect(
      extractSignalTags({
        kind: 'prompt',
        input: "You don't need to upgrade the staging cluster.",
      })
    ).toEqual([]);
    expect(
      extractSignalTags({
        kind: 'prompt',
        input: 'There is no need to migrate that table.',
      })
    ).toEqual([]);
  });
});
