import { performance } from 'perf_hooks';
import {
  MAX_TEMPORAL_SCAN_CHARS,
  parseTemporalQueryWindow,
  resolveRelativeDates,
} from '../../lib/temporal';

const LONE_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('src/lib/temporal — deterministic relative-date resolver and temporal query parser', () => {
  describe('resolveRelativeDates', () => {
    // 2023-05-24 is a Wednesday in UTC
    const anchor = '2023-05-24T15:30:00.000Z';

    it('resolves day anchors accurately in UTC', () => {
      const text = [
        'We started the day before yesterday,',
        'tested yesterday,',
        'shipped today and this morning,',
        'celebrate tonight,',
        'monitor tomorrow,',
        'and close out the day after tomorrow.',
      ].join(' ');

      const res = resolveRelativeDates(text, anchor);
      expect(res.resolved.map((r) => [r.phrase, r.resolved_date, r.granularity])).toEqual([
        ['the day before yesterday', '2023-05-22', 'day'],
        ['yesterday', '2023-05-23', 'day'],
        ['today', '2023-05-24', 'day'],
        ['this morning', '2023-05-24', 'day'],
        ['tonight', '2023-05-24', 'day'],
        ['tomorrow', '2023-05-25', 'day'],
        ['the day after tomorrow', '2023-05-26', 'day'],
      ]);
      expect(res.annotatedText).toContain('the day before yesterday [2023-05-22]');
      expect(res.annotatedText).toContain('yesterday [2023-05-23]');
      expect(res.annotatedText).toContain('today [2023-05-24]');
      expect(res.annotatedText).toContain('tomorrow [2023-05-25]');
      expect(res.annotatedText).toContain('the day after tomorrow [2023-05-26]');
    });

    it('resolves qualified weekdays and unambiguous abbreviations while guarding false positives', () => {
      // Anchor: Wednesday 2023-05-24
      // Previous Saturday -> 2023-05-20; Previous Wednesday -> 2023-05-17; Next Wednesday -> 2023-05-31
      expect(resolveRelativeDates('I adopted a puppy last Saturday.', anchor).annotatedText).toBe(
        'I adopted a puppy last Saturday [2023-05-20].'
      );
      expect(resolveRelativeDates('Reviewed PR last Wednesday.', anchor).annotatedText).toBe(
        'Reviewed PR last Wednesday [2023-05-17].'
      );
      expect(resolveRelativeDates('Demo is next Wednesday.', anchor).annotatedText).toBe(
        'Demo is next Wednesday [2023-05-31].'
      );
      expect(resolveRelativeDates('Met Alex this past Sunday.', anchor).annotatedText).toBe(
        'Met Alex this past Sunday [2023-05-21].'
      );
      expect(resolveRelativeDates('Synced on Tues and next Fri.', anchor).annotatedText).toBe(
        'Synced on Tues [2023-05-23] and next Fri [2023-05-26].'
      );
      expect(resolveRelativeDates('Pushed hotfix last Sat.', anchor).annotatedText).toBe(
        'Pushed hotfix last Sat [2023-05-20].'
      );
      expect(
        resolveRelativeDates('Release is scheduled on Friday.', anchor).annotatedText
      ).toBe('Release is scheduled on Friday [2023-05-26].');

      // Past-context "on Sunday" when anchor is Wednesday -> 2023-05-21 (3 days prior, not +4d future!)
      expect(resolveRelativeDates('Went hiking on Sunday.', anchor).annotatedText).toBe(
        'Went hiking on Sunday [2023-05-21].'
      );

      // Guard: explicit date immediately after weekday must NOT produce redundant relative tag
      const explicitFollow = 'Deployed on Saturday, May 20, 2023 and on Monday 2023-05-15.';
      expect(resolveRelativeDates(explicitFollow, anchor).resolved).toEqual([]);
      expect(resolveRelativeDates(explicitFollow, anchor).annotatedText).toBe(explicitFollow);

      // Guard: lowercase English words "sat", "wed", "sun" must NOT match
      const nonTemporal =
        'That was the bench where he last sat, they were newly wed, and glare on sun sensors failed.';
      expect(resolveRelativeDates(nonTemporal, anchor).resolved).toEqual([]);
    });

    it('resolves numeric and word-number offsets and rejects non-temporal units like "in 2 ways"', () => {
      const text =
        'Started two weeks ago, hit a snag 4 days ago, migrated a month ago, checked a couple of days ago, and will verify in 3 days or 2 weeks from now.';
      const res = resolveRelativeDates(text, anchor);

      expect(res.resolved.map((r) => [r.phrase, r.resolved_date])).toEqual([
        ['two weeks ago', '2023-05-10'],
        ['4 days ago', '2023-05-20'],
        ['a month ago', '2023-04-24'],
        ['a couple of days ago', '2023-05-22'],
        ['in 3 days', '2023-05-27'],
        ['2 weeks from now', '2023-06-07'],
      ]);

      // Month-end & leap-year clamping
      expect(resolveRelativeDates('a month ago', '2024-03-31T10:00:00Z').resolved[0].resolved_date).toBe(
        '2024-02-29'
      );
      expect(resolveRelativeDates('a month ago', '2023-03-31T10:00:00Z').resolved[0].resolved_date).toBe(
        '2023-02-28'
      );
      expect(resolveRelativeDates('a year ago', '2024-02-29T10:00:00Z').resolved[0].resolved_date).toBe(
        '2023-02-28'
      );
      expect(resolveRelativeDates('in 1 month', '2024-01-31T10:00:00Z').resolved[0].resolved_date).toBe(
        '2024-02-29'
      );
      expect(resolveRelativeDates('in 1 month', '2023-01-31T10:00:00Z').resolved[0].resolved_date).toBe(
        '2023-02-28'
      );

      // Non-temporal phrases, version strings, and UUIDs MUST NOT match
      const falsePositives = [
        'We can solve this in 3 ways, all in a day\'s work, with two weeks\' notice in 5 minutes.',
        'How may I help? It may fail if we sat on the mat or wed the two modules.',
        'Upgraded service to v2.4.1 on trace 550e8400-e29b-41d4-a716-446655440000.',
      ].join(' ');
      expect(resolveRelativeDates(falsePositives, anchor).resolved).toEqual([]);
      expect(resolveRelativeDates(falsePositives, anchor).annotatedText).toBe(falsePositives);
    });

    it('resolves week, month, and year period spans and guarantees idempotent annotation', () => {
      const text =
        'Compared metrics from last week, last month, earlier this month, and last year.';
      const firstPass = resolveRelativeDates(text, anchor);

      expect(
        firstPass.resolved.map((r) => ({
          phrase: r.phrase,
          granularity: r.granularity,
          window_start: r.window_start,
          window_end: r.window_end,
        }))
      ).toEqual([
        {
          phrase: 'last week',
          granularity: 'week',
          window_start: '2023-05-15',
          window_end: '2023-05-21',
        },
        {
          phrase: 'last month',
          granularity: 'month',
          window_start: '2023-04-01',
          window_end: '2023-04-30',
        },
        {
          phrase: 'earlier this month',
          granularity: 'month',
          window_start: '2023-05-01',
          window_end: '2023-05-24',
        },
        {
          phrase: 'last year',
          granularity: 'year',
          window_start: '2022-01-01',
          window_end: '2022-12-31',
        },
      ]);

      expect(firstPass.annotatedText).toBe(
        'Compared metrics from last week [2023-05-15..2023-05-21], last month [2023-04-01..2023-04-30], earlier this month [2023-05-01..2023-05-24], and last year [2022-01-01..2022-12-31].'
      );

      // Idempotency check: re-running on already annotated text must not duplicate brackets
      const secondPass = resolveRelativeDates(firstPass.annotatedText, anchor);
      expect(secondPass.annotatedText).toBe(firstPass.annotatedText);

      // Unix epoch seconds & Date object anchors produce identical results
      const unixSec = Math.floor(Date.parse(anchor) / 1000);
      expect(resolveRelativeDates('yesterday', unixSec).annotatedText).toBe(
        'yesterday [2023-05-23]'
      );
      expect(resolveRelativeDates('yesterday', new Date(anchor)).annotatedText).toBe(
        'yesterday [2023-05-23]'
      );
      expect(resolveRelativeDates('yesterday', 'invalid-date').annotatedText).toBe('yesterday');
    });
  });

  describe('parseTemporalQueryWindow', () => {
    const refIso = '2023-06-20T12:00:00.000Z';

    it('parses point-in-past windows ("four weeks ago", "yesterday", "last Saturday", "a month ago") and strips expressions cleanly', () => {
      const fourWeeks = parseTemporalQueryWindow(
        'what milestone did I mention four weeks ago?',
        refIso
      );
      expect(fourWeeks).not.toBeNull();
      // Center = 2023-06-20T12:00Z - 28d = 2023-05-23T12:00Z, ±7d -> [2023-05-16T12:00Z, 2023-05-30T12:00Z]
      expect(fourWeeks!.windowStartIso).toBe('2023-05-16T12:00:00.000Z');
      expect(fourWeeks!.windowEndIso).toBe('2023-05-30T12:00:00.000Z');
      expect(fourWeeks!.expressions).toEqual(['four weeks ago']);
      expect(fourWeeks!.residualQuery).toBe('what milestone did I mention');

      const yesterday = parseTemporalQueryWindow('errors logged yesterday', refIso);
      expect(yesterday).not.toBeNull();
      expect(new Date(yesterday!.centerMs).toISOString()).toBe('2023-06-19T12:00:00.000Z');
      expect(yesterday!.halfWidthMs).toBe(1.5 * 86_400_000);
      expect(yesterday!.residualQuery).toBe('errors logged');

      // 2023-06-20 is Tuesday -> last Saturday is 2023-06-17
      const lastSat = parseTemporalQueryWindow('what happened last Saturday', refIso);
      expect(lastSat).not.toBeNull();
      expect(new Date(lastSat!.centerMs).toISOString()).toBe('2023-06-17T12:00:00.000Z');
      expect(lastSat!.halfWidthMs).toBe(1.5 * 86_400_000);

      const oneMonth = parseTemporalQueryWindow('architecture decision a month ago', refIso);
      expect(oneMonth).not.toBeNull();
      expect(new Date(oneMonth!.centerMs).toISOString()).toBe('2023-05-20T12:00:00.000Z');
      expect(oneMonth!.halfWidthMs).toBe(14 * 86_400_000);
    });

    it('parses trailing relative periods ("in the past two weeks", "last month", "this year")', () => {
      const pastTwoWeeks = parseTemporalQueryWindow(
        'regressions in the past two weeks',
        refIso
      );
      expect(pastTwoWeeks).not.toBeNull();
      expect(pastTwoWeeks!.windowStartIso).toBe('2023-06-05T12:00:00.000Z');
      expect(pastTwoWeeks!.windowEndIso).toBe('2023-06-21T00:00:00.000Z');
      expect(pastTwoWeeks!.residualQuery).toBe('regressions');

      const lastMonth = parseTemporalQueryWindow('incidents last month', refIso);
      expect(lastMonth).not.toBeNull();
      // May 2023 ± 2d grace -> 2023-04-29T00:00:00.000Z .. 2023-06-02T23:59:59.999Z
      expect(lastMonth!.windowStartIso).toBe('2023-04-29T00:00:00.000Z');
      expect(lastMonth!.windowEndIso).toBe('2023-06-02T23:59:59.999Z');
    });

    it('distinguishes modal verb "may" from calendar month "May" and resolves explicit dates, months, quarters, and multi-bound ranges', () => {
      // Modal "may", common English words, version strings, and UUIDs MUST NOT trigger a temporal window
      expect(parseTemporalQueryWindow('How may I help?', refIso)).toBeNull();
      expect(parseTemporalQueryWindow('It may fail', refIso)).toBeNull();
      expect(parseTemporalQueryWindow('how may I configure the connection pool?', refIso)).toBeNull();
      expect(parseTemporalQueryWindow('what may happen if Qdrant is offline?', refIso)).toBeNull();
      expect(parseTemporalQueryWindow('what may 2 threads share safely?', refIso)).toBeNull();
      expect(parseTemporalQueryWindow('sat on the mat', refIso)).toBeNull();
      expect(parseTemporalQueryWindow('wed the two modules', refIso)).toBeNull();
      expect(parseTemporalQueryWindow('solve this in 3 ways', refIso)).toBeNull();
      expect(parseTemporalQueryWindow('regression in v2.4.1 build', refIso)).toBeNull();
      expect(
        parseTemporalQueryWindow('trace 550e8400-e29b-41d4-a716-446655440000 failed', refIso)
      ).toBeNull();

      // Leap-year & month-end boundaries in query window parser
      const leapBackMonth = parseTemporalQueryWindow(
        'deploy a month ago',
        '2024-03-31T12:00:00.000Z'
      );
      expect(leapBackMonth).not.toBeNull();
      expect(new Date(leapBackMonth!.centerMs).toISOString()).toBe('2024-02-29T12:00:00.000Z');

      const nonLeapBackMonth = parseTemporalQueryWindow(
        'deploy a month ago',
        '2023-03-31T12:00:00.000Z'
      );
      expect(nonLeapBackMonth).not.toBeNull();
      expect(new Date(nonLeapBackMonth!.centerMs).toISOString()).toBe('2023-02-28T12:00:00.000Z');

      const leapBackYear = parseTemporalQueryWindow(
        'incident a year ago',
        '2024-02-29T12:00:00.000Z'
      );
      expect(leapBackYear).not.toBeNull();
      expect(new Date(leapBackYear!.centerMs).toISOString()).toBe('2023-02-28T12:00:00.000Z');

      // Invalid non-leap Feb 29 rejected; valid leap Feb 29 accepted; yearless Feb 29 resolves to 2024
      expect(parseTemporalQueryWindow('what happened on Feb 29, 2023?', '2025-06-01T12:00:00Z')).toBeNull();
      expect(parseTemporalQueryWindow('commits on 2023-02-29', '2025-06-01T12:00:00Z')).toBeNull();
      const validLeapDay = parseTemporalQueryWindow(
        'what happened on Feb 29, 2024?',
        '2025-06-01T12:00:00Z'
      );
      expect(validLeapDay).not.toBeNull();
      expect(new Date(validLeapDay!.centerMs).toISOString()).toBe('2024-02-29T12:00:00.000Z');

      const yearlessLeapDay = parseTemporalQueryWindow(
        'what happened on Feb 29?',
        '2025-06-01T12:00:00Z'
      );
      expect(yearlessLeapDay).not.toBeNull();
      expect(new Date(yearlessLeapDay!.centerMs).toISOString()).toBe('2024-02-29T12:00:00.000Z');

      // Capitalized "in May" / "May 2023" / "May 20, 2023" / "20 May 2023" MUST match
      const inMay = parseTemporalQueryWindow('deployments in May', refIso);
      expect(inMay).not.toBeNull();
      expect(inMay!.windowStartIso).toBe('2023-05-01T00:00:00.000Z');
      expect(inMay!.windowEndIso).toBe('2023-05-31T23:59:59.999Z');
      expect(inMay!.residualQuery).toBe('deployments');

      // Year-omitted month rolls back to previous year if month start > referenceDate
      const inOctFromFeb = parseTemporalQueryWindow(
        'outages in October',
        '2023-02-15T00:00:00.000Z'
      );
      expect(inOctFromFeb!.windowStartIso).toBe('2022-10-01T00:00:00.000Z');
      expect(inOctFromFeb!.windowEndIso).toBe('2022-10-31T23:59:59.999Z');

      const may20 = parseTemporalQueryWindow('what happened on May 20, 2023?', refIso);
      expect(may20).not.toBeNull();
      expect(may20!.windowStartIso).toBe('2023-05-19T00:00:00.000Z');
      expect(may20!.windowEndIso).toBe('2023-05-22T00:00:00.000Z');

      const dmy = parseTemporalQueryWindow('notes from 20 May 2023', refIso);
      expect(dmy).not.toBeNull();
      expect(new Date(dmy!.centerMs).toISOString()).toBe('2023-05-20T12:00:00.000Z');

      const quarter = parseTemporalQueryWindow('roadmap items in Q2 2023', refIso);
      expect(quarter).not.toBeNull();
      expect(quarter!.windowStartIso).toBe('2023-04-01T00:00:00.000Z');
      expect(quarter!.windowEndIso).toBe('2023-06-30T23:59:59.999Z');

      // Multi-bound ranges
      const betweenMonths = parseTemporalQueryWindow(
        'migrations between March and May 2023',
        '2025-01-10T00:00:00.000Z'
      );
      expect(betweenMonths).not.toBeNull();
      expect(betweenMonths!.windowStartIso).toBe('2023-03-01T00:00:00.000Z');
      expect(betweenMonths!.windowEndIso).toBe('2023-05-31T23:59:59.999Z');
      expect(betweenMonths!.residualQuery).toBe('migrations');

      const fromToIso = parseTemporalQueryWindow(
        'commits from 2023-04-05 to 2023-04-18',
        refIso
      );
      expect(fromToIso).not.toBeNull();
      expect(fromToIso!.windowStartIso).toBe('2023-04-04T00:00:00.000Z');
      expect(fromToIso!.windowEndIso).toBe('2023-04-20T00:00:00.000Z');
      expect(fromToIso!.residualQuery).toBe('commits');
    });
  });

  describe('ReDoS linear-time performance (<20ms on 50KB) & UTF-16 surrogate safety', () => {
    it('processes 50KB pathological inputs in <20ms and never splits UTF-16 surrogate pairs', () => {
      const pathologicalPayloads = [
        'last '.repeat(10_500), // >52KB repeated "last "
        'between '.repeat(6_500), // >52KB repeated "between "
        '2023-'.repeat(10_500), // >52KB repeated partial ISO prefix
        'in '.repeat(17_000), // >51KB repeated "in "
        ' '.repeat(52_000), // >52KB single-line spaces
        '9'.repeat(52_000), // >52KB single-line digits
        'in a couple of '.repeat(3500), // >52KB near-miss offset prefix
        'this past '.repeat(5500), // >55KB near-miss weekday/period prefix
        'between May and '.repeat(3500), // >56KB near-miss range prefix
        `yesterday foo ${'?'.repeat(51_000)}a`, // >51KB matched temporal prefix + trailing punctuation trap
        `${'🚀🔥✨ '.repeat(2500)}deployed yesterday${' 🎯💡'.repeat(7000)}`, // >50KB emoji payload
      ];

      // Warm up JIT once before strict wall-clock measurement
      resolveRelativeDates('warmup yesterday and two weeks ago', '2023-05-24T12:00:00Z');
      parseTemporalQueryWindow('warmup four weeks ago in May 2023', '2023-06-20T12:00:00Z');

      const measureMinOf3 = <T>(fn: () => T): { result: T; minMs: number } => {
        let minMs = Number.POSITIVE_INFINITY;
        let result!: T;
        for (let i = 0; i < 3; i++) {
          const start = performance.now();
          result = fn();
          const elapsed = performance.now() - start;
          if (elapsed < minMs) minMs = elapsed;
        }
        return { result, minMs };
      };

      for (const payload of pathologicalPayloads) {
        expect(payload.length).toBeGreaterThan(50_000);

        const { result: r, minMs: elapsedResolve } = measureMinOf3(() =>
          resolveRelativeDates(payload, '2023-05-24T12:00:00Z')
        );
        expect(elapsedResolve).toBeLessThan(20);
        expect(LONE_SURROGATE_RE.test(r.annotatedText)).toBe(false);

        const { result: w, minMs: elapsedParse } = measureMinOf3(() =>
          parseTemporalQueryWindow(payload, '2023-06-20T12:00:00Z')
        );
        expect(elapsedParse).toBeLessThan(20);
        if (w) {
          expect(LONE_SURROGATE_RE.test(w.residualQuery)).toBe(false);
        }
      }

      // Specifically place a surrogate pair straddling index MAX_TEMPORAL_SCAN_CHARS - 1
      const prefix = 'x'.repeat(MAX_TEMPORAL_SCAN_CHARS - 1);
      const boundaryEmojiText = `${prefix}🚀 trailing yesterday`;
      expect(boundaryEmojiText.charCodeAt(MAX_TEMPORAL_SCAN_CHARS - 1)).toBeGreaterThanOrEqual(
        0xd800
      );
      const boundaryRes = resolveRelativeDates(boundaryEmojiText, '2023-05-24T12:00:00Z');
      expect(boundaryRes.annotatedText).toBe(boundaryEmojiText);
      expect(LONE_SURROGATE_RE.test(boundaryRes.annotatedText)).toBe(false);
    });
  });
});
