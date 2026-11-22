import {
  normalizeUtcIso,
  validateRecurrence,
  computeNextOccurrence,
  parseDurationMs,
} from '../../lib/recurrence';

describe('recurrence utilities', () => {
  describe('normalizeUtcIso', () => {
    it('returns null for undefined, null, or empty strings', () => {
      expect(normalizeUtcIso(undefined, 'due_at')).toBeNull();
      expect(normalizeUtcIso(null, 'due_at')).toBeNull();
      expect(normalizeUtcIso('', 'due_at')).toBeNull();
      expect(normalizeUtcIso('   ', 'due_at')).toBeNull();
    });

    it('normalizes valid ISO strings and Date objects to UTC ISO format', () => {
      expect(normalizeUtcIso('2026-11-22T08:30:00Z', 'due_at')).toBe('2026-11-22T08:30:00.000Z');
      expect(normalizeUtcIso('2026-11-22T08:30:00-02:00', 'due_at')).toBe(
        '2026-11-22T10:30:00.000Z'
      );
      expect(normalizeUtcIso(new Date('2026-01-15T12:00:00Z'), 'remind_at')).toBe(
        '2026-01-15T12:00:00.000Z'
      );
    });

    it('rejects invalid dates and non-string/non-Date values with SCHEMA_INVALID', () => {
      for (const bad of ['not-a-date', 12345, {}, new Date('invalid')]) {
        try {
          normalizeUtcIso(bad, 'due_at');
          throw new Error('expected throw');
        } catch (err: any) {
          expect(err.code).toBe('SCHEMA_INVALID');
        }
      }
    });
  });

  describe('validateRecurrence', () => {
    it('accepts cron macros and 5-field expressions', () => {
      expect(validateRecurrence('@hourly')).toEqual({
        ok: true,
        kind: 'cron',
        normalized: '0 * * * *',
      });
      expect(validateRecurrence('@daily')).toEqual({
        ok: true,
        kind: 'cron',
        normalized: '0 0 * * *',
      });
      expect(validateRecurrence('@midnight')).toEqual({
        ok: true,
        kind: 'cron',
        normalized: '0 0 * * *',
      });
      expect(validateRecurrence('@weekly')).toEqual({
        ok: true,
        kind: 'cron',
        normalized: '0 0 * * 0',
      });
      expect(validateRecurrence('@monthly')).toEqual({
        ok: true,
        kind: 'cron',
        normalized: '0 0 1 * *',
      });
      expect(validateRecurrence('@yearly')).toEqual({
        ok: true,
        kind: 'cron',
        normalized: '0 0 1 1 *',
      });
      expect(validateRecurrence('@annually')).toEqual({
        ok: true,
        kind: 'cron',
        normalized: '0 0 1 1 *',
      });

      expect(validateRecurrence('  */15  9-17/2  1,15  1-12  5-7  ')).toEqual({
        ok: true,
        kind: 'cron',
        normalized: '*/15 9-17/2 1,15 1-12 5-7',
      });
    });

    it('rejects malformed cron expressions', () => {
      for (const bad of [
        '',
        '   ',
        '0 * * *',
        '0 * * * * *',
        '60 * * * *',
        '0 24 * * *',
        '0 0 0 * *',
        '0 0 32 * *',
        '0 0 * 13 *',
        '0 0 * * 8',
        '*/0 * * * *',
        '10-5 * * * *',
        'abc * * * *',
      ]) {
        expect(validateRecurrence(bad).ok).toBe(false);
      }
    });

    it('accepts valid ISO-8601 durations and normalizes to uppercase', () => {
      expect(validateRecurrence('p1d')).toEqual({ ok: true, kind: 'iso', normalized: 'P1D' });
      expect(validateRecurrence('r/pt30m')).toEqual({
        ok: true,
        kind: 'iso',
        normalized: 'R/PT30M',
      });
      expect(validateRecurrence('P1Y2M3DT4H5M6S')).toEqual({
        ok: true,
        kind: 'iso',
        normalized: 'P1Y2M3DT4H5M6S',
      });
    });

    it('rejects zero-length or malformed ISO durations', () => {
      for (const bad of ['P', 'PT', 'P0D', 'PT0S', 'P1DT', 'P-1D']) {
        expect(validateRecurrence(bad).ok).toBe(false);
      }
    });
  });

  describe('computeNextOccurrence', () => {
    it('adds ISO-8601 duration components in UTC with day-of-month clamping', () => {
      expect(computeNextOccurrence('P1M', new Date('2026-01-31T10:15:00Z')).toISOString()).toBe(
        '2026-02-28T10:15:00.000Z'
      );
      expect(computeNextOccurrence('P1M', new Date('2024-01-31T10:15:00Z')).toISOString()).toBe(
        '2024-02-29T10:15:00.000Z'
      );
      expect(computeNextOccurrence('P1Y', new Date('2024-02-29T00:00:00Z')).toISOString()).toBe(
        '2025-02-28T00:00:00.000Z'
      );
      expect(computeNextOccurrence('R/P1W', new Date('2026-11-22T08:00:00Z')).toISOString()).toBe(
        '2026-11-29T08:00:00.000Z'
      );
      expect(computeNextOccurrence('PT45M', new Date('2026-11-22T23:30:00Z')).toISOString()).toBe(
        '2026-11-23T00:15:00.000Z'
      );
    });

    it('advances strictly past fromDate for cron expressions', () => {
      // At exact match time, must advance to the next match
      expect(
        computeNextOccurrence('30 8 * * *', new Date('2026-11-22T08:30:00.000Z')).toISOString()
      ).toBe('2026-11-23T08:30:00.000Z');

      // Mid-minute advances to next matching minute
      expect(
        computeNextOccurrence('*/15 * * * *', new Date('2026-11-22T08:14:59.999Z')).toISOString()
      ).toBe('2026-11-22T08:15:00.000Z');

      // Sunday via dow=7
      expect(
        computeNextOccurrence('0 9 * * 7', new Date('2026-11-21T10:00:00Z')).toISOString()
      ).toBe('2026-11-22T09:00:00.000Z');
    });

    it('implements standard cron DOM/DOW union semantics when both are restricted', () => {
      // 2026-11-22 is Sunday (dow=0, dom=22). Cron restricts dom=25 AND dow=1 (Monday: Nov 23).
      // Since both are restricted, Monday Nov 23 triggers before Nov 25.
      expect(
        computeNextOccurrence('0 12 25 * 1', new Date('2026-11-22T00:00:00Z')).toISOString()
      ).toBe('2026-11-23T12:00:00.000Z');
    });

    it('throws SCHEMA_INVALID on impossible cron dates like Feb 30', () => {
      try {
        computeNextOccurrence('0 0 30 2 *', new Date('2026-01-01T00:00:00Z'));
        throw new Error('expected throw');
      } catch (err: any) {
        expect(err.code).toBe('SCHEMA_INVALID');
      }
    });
  });

  describe('parseDurationMs', () => {
    it('parses short and fixed-length ISO durations', () => {
      expect(parseDurationMs('30s')).toBe(30_000);
      expect(parseDurationMs('15m')).toBe(900_000);
      expect(parseDurationMs('2h')).toBe(7_200_000);
      expect(parseDurationMs('1d')).toBe(86_400_000);
      expect(parseDurationMs('1w')).toBe(604_800_000);
      expect(parseDurationMs('PT30M')).toBe(1_800_000);
      expect(parseDurationMs('PT2H')).toBe(7_200_000);
      expect(parseDurationMs('P1D')).toBe(86_400_000);
      expect(parseDurationMs('P1W')).toBe(604_800_000);
      expect(parseDurationMs('P1DT12H')).toBe(129_600_000);
    });

    it('returns null for variable-length ISO durations, zero, or invalid values', () => {
      expect(parseDurationMs('P1M')).toBeNull();
      expect(parseDurationMs('P1Y')).toBeNull();
      expect(parseDurationMs('0s')).toBeNull();
      expect(parseDurationMs('PT0S')).toBeNull();
      expect(parseDurationMs('invalid')).toBeNull();
    });
  });
});
