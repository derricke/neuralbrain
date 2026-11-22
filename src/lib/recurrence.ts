/**
 * Zero-dependency UTC date/time normalization, cron & ISO-8601 recurrence validation,
 * next-occurrence calculation, and duration parsing.
 */

const CRON_MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const ISO_DURATION_RE =
  /^(?:R\/)?P(?=\d|T\d)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;

const FIXED_ISO_DURATION_RE =
  /^P(?=\d|T\d)(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;

const SHORT_DURATION_RE = /^(\d+)([smhdw])$/i;

function makeSchemaError(message: string): Error {
  const err = new Error(message);
  (err as any).code = 'SCHEMA_INVALID';
  return err;
}

export function normalizeUtcIso(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) {
      throw makeSchemaError(`${field} must be a valid Date`);
    }
    return raw.toISOString();
  }

  if (typeof raw !== 'string') {
    throw makeSchemaError(`${field} must be an ISO-8601 date/time string or Date`);
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw makeSchemaError(`${field} '${trimmed}' is not a valid ISO-8601 date/time`);
  }

  return parsed.toISOString();
}

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number>;
  months: Set<number>;
  dows: Set<number>;
  domWildcard: boolean;
  dowWildcard: boolean;
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  fieldName: string,
  mapValue?: (v: number) => number
): { values: Set<number>; isWildcard: boolean } | { error: string } {
  const trimmed = field.trim();
  if (!trimmed) {
    return { error: `Empty cron ${fieldName} field` };
  }

  const isWildcard = trimmed === '*';
  const values = new Set<number>();
  const addVal = (v: number) => {
    values.add(mapValue ? mapValue(v) : v);
  };

  for (const rawPart of trimmed.split(',')) {
    const part = rawPart.trim();
    if (!part) {
      return { error: `Empty list entry in cron ${fieldName} field '${field}'` };
    }

    if (part === '*') {
      for (let v = min; v <= max; v++) addVal(v);
      continue;
    }

    const starStep = /^\*\/(\d+)$/.exec(part);
    if (starStep) {
      const step = Number(starStep[1]);
      if (!Number.isInteger(step) || step <= 0) {
        return { error: `Invalid step in cron ${fieldName} field '${part}'` };
      }
      for (let v = min; v <= max; v += step) addVal(v);
      continue;
    }

    const rangeStep = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part);
    if (rangeStep) {
      const start = Number(rangeStep[1]);
      const end = Number(rangeStep[2]);
      const step = rangeStep[3] !== undefined ? Number(rangeStep[3]) : 1;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        !Number.isInteger(step) ||
        start < min ||
        end > max ||
        start > end ||
        step <= 0
      ) {
        return { error: `Invalid range '${part}' for cron ${fieldName} (${min}-${max})` };
      }
      for (let v = start; v <= end; v += step) addVal(v);
      continue;
    }

    const single = /^(\d+)$/.exec(part);
    if (single) {
      const val = Number(single[1]);
      if (!Number.isInteger(val) || val < min || val > max) {
        return { error: `Value '${part}' out of range for cron ${fieldName} (${min}-${max})` };
      }
      addVal(val);
      continue;
    }

    return { error: `Unsupported cron token '${part}' in ${fieldName} field` };
  }

  if (values.size === 0) {
    return { error: `Cron ${fieldName} field '${field}' produced no values` };
  }

  return { values, isWildcard };
}

function parseCronExpression(expr: string): { ok: true; parsed: ParsedCron; normalized: string } | { ok: false; error: string } {
  const trimmed = expr.trim();
  const macroExpanded = CRON_MACROS[trimmed.toLowerCase()];
  const canonical = (macroExpanded ?? trimmed).replace(/\s+/g, ' ');
  const parts = canonical.split(' ');
  if (parts.length !== 5) {
    return { ok: false, error: `Cron expression must have 5 fields, got ${parts.length}` };
  }

  const minRes = parseCronField(parts[0], 0, 59, 'minute');
  if ('error' in minRes) return { ok: false, error: minRes.error };

  const hourRes = parseCronField(parts[1], 0, 23, 'hour');
  if ('error' in hourRes) return { ok: false, error: hourRes.error };

  const domRes = parseCronField(parts[2], 1, 31, 'day-of-month');
  if ('error' in domRes) return { ok: false, error: domRes.error };

  const monthRes = parseCronField(parts[3], 1, 12, 'month');
  if ('error' in monthRes) return { ok: false, error: monthRes.error };

  const dowRes = parseCronField(parts[4], 0, 7, 'day-of-week', (v) => (v === 7 ? 0 : v));
  if ('error' in dowRes) return { ok: false, error: dowRes.error };

  return {
    ok: true,
    normalized: canonical,
    parsed: {
      minutes: minRes.values,
      hours: hourRes.values,
      doms: domRes.values,
      months: monthRes.values,
      dows: dowRes.values,
      domWildcard: domRes.isWildcard,
      dowWildcard: dowRes.isWildcard,
    },
  };
}

interface ParsedIsoDuration {
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

function parseIsoDuration(expr: string): ParsedIsoDuration | null {
  const match = ISO_DURATION_RE.exec(expr.trim());
  if (!match) return null;

  const years = match[1] ? Number(match[1]) : 0;
  const months = match[2] ? Number(match[2]) : 0;
  const weeks = match[3] ? Number(match[3]) : 0;
  const days = match[4] ? Number(match[4]) : 0;
  const hours = match[5] ? Number(match[5]) : 0;
  const minutes = match[6] ? Number(match[6]) : 0;
  const seconds = match[7] ? Number(match[7]) : 0;

  if (years + months + weeks + days + hours + minutes + seconds <= 0) {
    return null;
  }

  return { years, months, weeks, days, hours, minutes, seconds };
}

export function validateRecurrence(
  expr: string
): { ok: true; kind: 'cron' | 'iso'; normalized: string } | { ok: false; error: string } {
  if (typeof expr !== 'string' || expr.trim() === '') {
    return { ok: false, error: 'Recurrence expression must be a non-empty string' };
  }

  const trimmed = expr.trim();
  const upper = trimmed.toUpperCase();

  if (upper.startsWith('P') || upper.startsWith('R/P')) {
    const iso = parseIsoDuration(trimmed);
    if (!iso) {
      return {
        ok: false,
        error: `Invalid ISO-8601 recurrence duration '${trimmed}' (must be non-zero duration)`,
      };
    }
    return { ok: true, kind: 'iso', normalized: upper };
  }

  const cron = parseCronExpression(trimmed);
  if (!cron.ok) {
    return cron;
  }
  return { ok: true, kind: 'cron', normalized: cron.normalized };
}

export function computeNextOccurrence(expr: string, fromDate: Date): Date {
  if (!(fromDate instanceof Date) || Number.isNaN(fromDate.getTime())) {
    throw makeSchemaError('fromDate must be a valid Date');
  }

  const validated = validateRecurrence(expr);
  if (!validated.ok) {
    throw makeSchemaError(validated.error);
  }

  if (validated.kind === 'iso') {
    const dur = parseIsoDuration(validated.normalized)!;
    const totalMonths =
      fromDate.getUTCFullYear() * 12 +
      fromDate.getUTCMonth() +
      dur.years * 12 +
      dur.months;
    const targetYear = Math.floor(totalMonths / 12);
    const targetMonth = totalMonths % 12;
    const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const clampedDay = Math.min(fromDate.getUTCDate(), daysInTargetMonth);

    const baseMs = Date.UTC(
      targetYear,
      targetMonth,
      clampedDay,
      fromDate.getUTCHours(),
      fromDate.getUTCMinutes(),
      fromDate.getUTCSeconds(),
      fromDate.getUTCMilliseconds()
    );
    const extraMs =
      (dur.weeks * 7 + dur.days) * 86_400_000 +
      dur.hours * 3_600_000 +
      dur.minutes * 60_000 +
      dur.seconds * 1_000;

    return new Date(baseMs + extraMs);
  }

  const cronRes = parseCronExpression(validated.normalized);
  if (!cronRes.ok) {
    throw makeSchemaError(cronRes.error);
  }
  const cron = cronRes.parsed;

  // Advance strictly past fromDate to the next whole UTC minute
  const startMs = Math.floor(fromDate.getTime() / 60_000) * 60_000 + 60_000;
  const maxMs = Date.UTC(
    fromDate.getUTCFullYear() + 5,
    fromDate.getUTCMonth(),
    fromDate.getUTCDate(),
    fromDate.getUTCHours(),
    fromDate.getUTCMinutes(),
    0,
    0
  );

  const cursor = new Date(startMs);
  while (cursor.getTime() <= maxMs) {
    const month = cursor.getUTCMonth() + 1;
    if (!cron.months.has(month)) {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const dom = cursor.getUTCDate();
    const dow = cursor.getUTCDay();
    const domMatch = cron.doms.has(dom);
    const dowMatch = cron.dows.has(dow);
    const dayMatches =
      !cron.domWildcard && !cron.dowWildcard
        ? domMatch || dowMatch
        : domMatch && dowMatch;

    if (!dayMatches) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const hour = cursor.getUTCHours();
    if (!cron.hours.has(hour)) {
      cursor.setUTCHours(hour + 1, 0, 0, 0);
      continue;
    }

    const minute = cursor.getUTCMinutes();
    if (!cron.minutes.has(minute)) {
      cursor.setUTCMinutes(minute + 1, 0, 0);
      continue;
    }

    return cursor;
  }

  throw makeSchemaError(`No matching occurrence found within 5 years for cron '${expr}'`);
}

export function parseDurationMs(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const shortMatch = SHORT_DURATION_RE.exec(trimmed);
  if (shortMatch) {
    const amount = Number(shortMatch[1]);
    const unit = shortMatch[2].toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const multipliers: Record<string, number> = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    };
    return amount * multipliers[unit];
  }

  const isoMatch = FIXED_ISO_DURATION_RE.exec(trimmed);
  if (isoMatch) {
    const weeks = isoMatch[1] ? Number(isoMatch[1]) : 0;
    const days = isoMatch[2] ? Number(isoMatch[2]) : 0;
    const hours = isoMatch[3] ? Number(isoMatch[3]) : 0;
    const minutes = isoMatch[4] ? Number(isoMatch[4]) : 0;
    const seconds = isoMatch[5] ? Number(isoMatch[5]) : 0;

    const totalMs =
      (weeks * 7 + days) * 86_400_000 +
      hours * 3_600_000 +
      minutes * 60_000 +
      seconds * 1_000;

    return totalMs > 0 ? totalMs : null;
  }

  return null;
}
