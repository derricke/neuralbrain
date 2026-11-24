/**
 * Zero-dependency deterministic temporal engine for:
 *  1. Ingest-time relative-date anchoring (`resolveRelativeDates`)
 *  2. Search-time temporal query window parsing (`parseTemporalQueryWindow`)
 *
 * All date arithmetic runs in UTC against an explicit anchor/reference timestamp.
 * Every regular expression is strictly linear-time O(N) (zero nested or quantified
 * groups) and bounded by `MAX_TEMPORAL_SCAN_CHARS` with UTF-16 surrogate-safe slicing.
 */

import { alignUtf16End, safeUtf16Slice } from './condenser';

export const MAX_TEMPORAL_SCAN_CHARS = 16_000;
const MAX_QUERY_TEMPORAL_SCAN_CHARS = 4_000;
const MAX_MATCHES_PER_PATTERN = 128;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface ResolvedDateAnnotation {
  phrase: string;
  start: number;
  end: number;
  resolved_date: string; // YYYY-MM-DD (UTC)
  window_start?: string; // YYYY-MM-DD (for week/month/year spans)
  window_end?: string;   // YYYY-MM-DD
  granularity: 'day' | 'week' | 'month' | 'year';
}

export interface ResolveRelativeDatesResult {
  resolved: ResolvedDateAnnotation[];
  annotatedText: string;
}

export interface ParsedTemporalWindow {
  windowStartIso: string; // UTC ISO-8601
  windowEndIso: string;   // UTC ISO-8601
  centerMs: number;
  halfWidthMs: number;
  expressions: string[];
  residualQuery: string;  // query with matched temporal phrase(s) stripped
}

interface UtcYmd {
  y: number;
  m: number; // 0..11
  d: number; // 1..31
}

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const AMBIGUOUS_LOWERCASE_WEEKDAY_ABBREVS = new Set(['wed', 'sat', 'sun']);

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

function parseAnchorUtc(anchor: string | number | Date | null | undefined): Date | null {
  if (anchor === null || anchor === undefined) return null;

  if (anchor instanceof Date) {
    return Number.isNaN(anchor.getTime()) ? null : new Date(anchor.getTime());
  }

  if (typeof anchor === 'number') {
    if (!Number.isFinite(anchor)) return null;
    // Values in [1e8, 1e11) are Unix epoch seconds (1973..5138); >= 1e11 are epoch milliseconds.
    const ms = Math.abs(anchor) >= 1e8 && Math.abs(anchor) < 1e11 ? anchor * 1000 : anchor;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (typeof anchor === 'string') {
    const trimmed = anchor.trim();
    if (!trimmed) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const d = new Date(`${trimmed}T12:00:00.000Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
      ? `${trimmed.replace(' ', 'T')}Z`
      : trimmed;
    const d = new Date(normalized);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

function toUtcYmd(date: Date): UtcYmd {
  return {
    y: date.getUTCFullYear(),
    m: date.getUTCMonth(),
    d: date.getUTCDate(),
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatUtcYmd(ymd: UtcYmd): string {
  const dt = new Date(Date.UTC(ymd.y, ymd.m, ymd.d));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function daysInUtcMonth(year: number, monthZeroBased: number): number {
  return new Date(Date.UTC(year, monthZeroBased + 1, 0)).getUTCDate();
}

function addUtcDays(base: UtcYmd, deltaDays: number): UtcYmd {
  const dt = new Date(Date.UTC(base.y, base.m, base.d + deltaDays));
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth(),
    d: dt.getUTCDate(),
  };
}

function addUtcMonthsClamped(base: UtcYmd, deltaMonths: number): UtcYmd {
  const totalMonths = base.y * 12 + base.m + deltaMonths;
  const targetY = Math.floor(totalMonths / 12);
  const targetM = ((totalMonths % 12) + 12) % 12;
  const maxD = daysInUtcMonth(targetY, targetM);
  return {
    y: targetY,
    m: targetM,
    d: Math.min(base.d, maxD),
  };
}

function addUtcYearsClamped(base: UtcYmd, deltaYears: number): UtcYmd {
  return addUtcMonthsClamped(base, deltaYears * 12);
}

function getUtcWeekday(base: UtcYmd): number {
  return new Date(Date.UTC(base.y, base.m, base.d)).getUTCDay();
}

function startOfIsoWeek(base: UtcYmd): UtcYmd {
  const dow = getUtcWeekday(base); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  return addUtcDays(base, -daysSinceMonday);
}

function parseNumberToken(raw: string): number | null {
  const norm = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^\d{1,3}$/.test(norm)) {
    const val = parseInt(norm, 10);
    return Number.isFinite(val) ? val : null;
  }
  if (norm === 'a couple' || norm === 'a couple of') return 2;
  if (norm === 'a few') return 3;
  return WORD_NUMBERS[norm] ?? null;
}

// Strictly O(N) linear-time regular expressions (zero nested/repeating groups)
const NUM_TOKEN_SRC =
  'a\\s{1,4}couple(?:\\s{1,4}of)?|a\\s{1,4}few|twenty|nineteen|eighteen|seventeen|sixteen|fifteen|fourteen|thirteen|twelve|eleven|ten|nine|eight|seven|six|five|four|three|two|one|an|a|\\d{1,3}';

const NUM_TOKEN_NO_ARTICLE_SRC =
  'a\\s{1,4}couple(?:\\s{1,4}of)?|a\\s{1,4}few|twenty|nineteen|eighteen|seventeen|sixteen|fifteen|fourteen|thirteen|twelve|eleven|ten|nine|eight|seven|six|five|four|three|two|one|\\d{1,3}';

const DAY_ANCHOR_RE =
  /\b(the\s{1,4}day\s{1,4}before\s{1,4}yesterday|the\s{1,4}day\s{1,4}after\s{1,4}tomorrow|this\s{1,4}morning|this\s{1,4}afternoon|this\s{1,4}evening|yesterday|tomorrow|tonight|today)\b/gi;

const WEEKDAY_QUALIFIED_RE =
  /\b(this\s{1,4}past|previous|last|next|this|on)\s{1,4}(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues|thurs|thur|mon|tue|wed|thu|fri|sat|sun)(\.?)(?![a-zA-Z0-9_])/gi;

const REL_OFFSET_AGO_RE = new RegExp(
  `\\b(${NUM_TOKEN_SRC})\\s{1,4}(day|week|month|year)s?\\s{1,4}ago\\b`,
  'gi'
);

const REL_OFFSET_FUTURE_RE = new RegExp(
  `\\b(${NUM_TOKEN_SRC})\\s{1,4}(day|week|month|year)s?\\s{1,4}(?:from\\s{1,4}now|later)\\b`,
  'gi'
);

const REL_IN_OFFSET_RE = new RegExp(
  `\\bin\\s{1,4}(${NUM_TOKEN_SRC})\\s{1,4}(day|week|month|year)s?\\b(?![’']s\\b)`,
  'gi'
);

const PERIOD_SPAN_RE =
  /\b(earlier\s{1,4}this|this\s{1,4}past|previous|last|this|next)\s{1,4}(week|month|year)\b(?![’']s\b)/gi;

const EXPLICIT_DATE_AFTER_WEEKDAY_RE =
  /^\.?,?\s{1,4}(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,4}\b|the\s{1,4}\d{1,2}(?:st|nd|rd|th)\b)/i;

const FUTURE_CONTEXT_BEFORE_ON_RE =
  /\b(?:will|won't|going\s{1,3}to|gonna|plan(?:ning)?\s{1,3}to|scheduled(?:\s{1,3}for)?|due|deploying|launching|releasing|meet(?:ing)?|let'?s|can\s{1,3}we|see\s{1,3}you)\s{1,4}[a-z0-9_,'"-]{0,20}$/i;

const ALREADY_ANNOTATED_AFTER_RE = /^\s*\[\d{4}-\d{2}-\d{2}/;

function selectNonOverlappingLongest<T extends { start: number; end: number }>(
  candidates: T[]
): T[] {
  if (candidates.length <= 1) return candidates;
  const byLengthDesc = [...candidates].sort((a, b) => {
    const lenDiff = b.end - b.start - (a.end - a.start);
    return lenDiff !== 0 ? lenDiff : a.start - b.start;
  });

  // Maintain accepted intervals sorted by `start` so overlap check is O(log M) via binary search
  const accepted: T[] = [];
  for (const cand of byLengthDesc) {
    let lo = 0;
    let hi = accepted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (accepted[mid].start < cand.start) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    const overlapsPrev = lo > 0 && accepted[lo - 1].end > cand.start;
    const overlapsNext = lo < accepted.length && accepted[lo].start < cand.end;
    if (!overlapsPrev && !overlapsNext) {
      accepted.splice(lo, 0, cand);
    }
  }

  return accepted;
}

function resolveShiftedDay(
  base: UtcYmd,
  amount: number,
  unit: string
): UtcYmd {
  switch (unit) {
    case 'day':
      return addUtcDays(base, amount);
    case 'week':
      return addUtcDays(base, amount * 7);
    case 'month':
      return addUtcMonthsClamped(base, amount);
    case 'year':
      return addUtcYearsClamped(base, amount);
    default:
      return base;
  }
}

function resolveQualifiedWeekday(
  base: UtcYmd,
  qualifierLower: string,
  targetDow: number,
  precedingSlice: string
): UtcYmd {
  const anchorDow = getUtcWeekday(base);
  const normQual = qualifierLower.replace(/\s+/g, ' ');

  if (normQual === 'last' || normQual === 'this past' || normQual === 'previous') {
    const diff = (anchorDow - targetDow + 7) % 7;
    const delta = diff === 0 ? -7 : -diff;
    return addUtcDays(base, delta);
  }

  if (normQual === 'next') {
    const diff = (targetDow - anchorDow + 7) % 7;
    const delta = diff === 0 ? 7 : diff;
    return addUtcDays(base, delta);
  }

  if (normQual === 'this') {
    const anchorIso = (anchorDow + 6) % 7;
    const targetIso = (targetDow + 6) % 7;
    return addUtcDays(base, targetIso - anchorIso);
  }

  // 'on <weekday>': future in current/upcoming week if preceded by future cue, else most recent <= anchor
  if (FUTURE_CONTEXT_BEFORE_ON_RE.test(precedingSlice)) {
    const diff = (targetDow - anchorDow + 7) % 7;
    return addUtcDays(base, diff);
  }
  const backDiff = (anchorDow - targetDow + 7) % 7;
  return addUtcDays(base, -backDiff);
}

/**
 * Deterministically resolves relative date expressions in `text` against `anchor` (UTC)
 * and produces both structured annotations and an idempotent inline-annotated copy of `text`.
 */
export function resolveRelativeDates(
  text: string,
  anchor: string | number | Date
): ResolveRelativeDatesResult {
  if (!text || typeof text !== 'string') {
    return { resolved: [], annotatedText: text ?? '' };
  }

  const anchorDate = parseAnchorUtc(anchor);
  if (!anchorDate) {
    return { resolved: [], annotatedText: text };
  }

  const scanEnd = alignUtf16End(text, Math.min(text.length, MAX_TEMPORAL_SCAN_CHARS), 0);
  const scanText = scanEnd === text.length ? text : text.slice(0, scanEnd);
  const base = toUtcYmd(anchorDate);
  const candidates: ResolvedDateAnnotation[] = [];

  // 1. Day anchors
  DAY_ANCHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let count = 0;
  while (count < MAX_MATCHES_PER_PATTERN && (m = DAY_ANCHOR_RE.exec(scanText)) !== null) {
    count++;
    const phrase = m[0];
    const start = m.index;
    const end = start + phrase.length;
    const norm = phrase.toLowerCase().replace(/\s+/g, ' ');
    let delta = 0;
    if (norm === 'the day before yesterday') delta = -2;
    else if (norm === 'yesterday') delta = -1;
    else if (norm === 'tomorrow') delta = 1;
    else if (norm === 'the day after tomorrow') delta = 2;
    else delta = 0;

    candidates.push({
      phrase,
      start,
      end,
      resolved_date: formatUtcYmd(addUtcDays(base, delta)),
      granularity: 'day',
    });
  }

  // 2. Qualified weekday anchors
  WEEKDAY_QUALIFIED_RE.lastIndex = 0;
  count = 0;
  while (count < MAX_MATCHES_PER_PATTERN && (m = WEEKDAY_QUALIFIED_RE.exec(scanText)) !== null) {
    count++;
    const rawQual = m[1];
    const rawDay = m[2];
    const trailingDot = m[3] || '';
    const dayLower = rawDay.toLowerCase();

    // Protect common English words 'wed', 'sat', 'sun' when written lowercase
    if (
      AMBIGUOUS_LOWERCASE_WEEKDAY_ABBREVS.has(dayLower) &&
      rawDay[0] !== rawDay[0].toUpperCase()
    ) {
      continue;
    }

    const targetDow = WEEKDAY_INDEX[dayLower];
    if (targetDow === undefined) continue;

    const end = m.index + m[0].length - trailingDot.length;
    const start = m.index;
    const phrase = scanText.slice(start, end);

    const qualLower = rawQual.toLowerCase().replace(/\s+/g, ' ');
    if (qualLower === 'on' || qualLower === 'this') {
      const afterSlice = scanText.slice(end, Math.min(scanText.length, end + 32));
      if (EXPLICIT_DATE_AFTER_WEEKDAY_RE.test(afterSlice)) {
        continue;
      }
    }

    const beforeSlice = scanText.slice(Math.max(0, start - 50), start);
    const resolvedYmd = resolveQualifiedWeekday(base, qualLower, targetDow, beforeSlice);
    candidates.push({
      phrase,
      start,
      end,
      resolved_date: formatUtcYmd(resolvedYmd),
      granularity: 'day',
    });
  }

  // 3. Numeric & word-number past offsets: "<N> (day|week|month|year)s ago"
  REL_OFFSET_AGO_RE.lastIndex = 0;
  count = 0;
  while (count < MAX_MATCHES_PER_PATTERN && (m = REL_OFFSET_AGO_RE.exec(scanText)) !== null) {
    count++;
    const n = parseNumberToken(m[1]);
    if (n === null || n < 0) continue;
    const unit = m[2].toLowerCase();
    const phrase = m[0];
    const start = m.index;
    const end = start + phrase.length;
    const targetYmd = resolveShiftedDay(base, -n, unit);
    candidates.push({
      phrase,
      start,
      end,
      resolved_date: formatUtcYmd(targetYmd),
      granularity: 'day',
    });
  }

  // 4. Numeric & word-number future offsets: "<N> (day|week|month|year)s from now/later" & "in <N> ..."
  for (const futureRe of [REL_OFFSET_FUTURE_RE, REL_IN_OFFSET_RE]) {
    futureRe.lastIndex = 0;
    count = 0;
    while (count < MAX_MATCHES_PER_PATTERN && (m = futureRe.exec(scanText)) !== null) {
      count++;
      const n = parseNumberToken(m[1]);
      if (n === null || n < 0) continue;
      const unit = m[2].toLowerCase();
      const phrase = m[0];
      const start = m.index;
      const end = start + phrase.length;
      const targetYmd = resolveShiftedDay(base, n, unit);
      candidates.push({
        phrase,
        start,
        end,
        resolved_date: formatUtcYmd(targetYmd),
        granularity: 'day',
      });
    }
  }

  // 5. Period spans (week / month / year)
  PERIOD_SPAN_RE.lastIndex = 0;
  count = 0;
  while (count < MAX_MATCHES_PER_PATTERN && (m = PERIOD_SPAN_RE.exec(scanText)) !== null) {
    count++;
    const phrase = m[0];
    const start = m.index;
    const end = start + phrase.length;
    const qual = m[1].toLowerCase().replace(/\s+/g, ' ');
    const unit = m[2].toLowerCase() as 'week' | 'month' | 'year';

    let winStart: UtcYmd;
    let winEnd: UtcYmd;

    if (unit === 'week') {
      const curMon = startOfIsoWeek(base);
      if (qual === 'last' || qual === 'this past' || qual === 'previous') {
        winStart = addUtcDays(curMon, -7);
        winEnd = addUtcDays(curMon, -1);
      } else if (qual === 'earlier this') {
        winStart = curMon;
        winEnd = base;
      } else if (qual === 'next') {
        winStart = addUtcDays(curMon, 7);
        winEnd = addUtcDays(curMon, 13);
      } else {
        winStart = curMon;
        winEnd = addUtcDays(curMon, 6);
      }
    } else if (unit === 'month') {
      if (qual === 'last' || qual === 'this past' || qual === 'previous') {
        const prev = addUtcMonthsClamped({ y: base.y, m: base.m, d: 1 }, -1);
        winStart = { y: prev.y, m: prev.m, d: 1 };
        winEnd = { y: prev.y, m: prev.m, d: daysInUtcMonth(prev.y, prev.m) };
      } else if (qual === 'earlier this') {
        winStart = { y: base.y, m: base.m, d: 1 };
        winEnd = base;
      } else if (qual === 'next') {
        const nxt = addUtcMonthsClamped({ y: base.y, m: base.m, d: 1 }, 1);
        winStart = { y: nxt.y, m: nxt.m, d: 1 };
        winEnd = { y: nxt.y, m: nxt.m, d: daysInUtcMonth(nxt.y, nxt.m) };
      } else {
        winStart = { y: base.y, m: base.m, d: 1 };
        winEnd = { y: base.y, m: base.m, d: daysInUtcMonth(base.y, base.m) };
      }
    } else {
      if (qual === 'last' || qual === 'this past' || qual === 'previous') {
        winStart = { y: base.y - 1, m: 0, d: 1 };
        winEnd = { y: base.y - 1, m: 11, d: 31 };
      } else if (qual === 'earlier this') {
        winStart = { y: base.y, m: 0, d: 1 };
        winEnd = base;
      } else if (qual === 'next') {
        winStart = { y: base.y + 1, m: 0, d: 1 };
        winEnd = { y: base.y + 1, m: 11, d: 31 };
      } else {
        winStart = { y: base.y, m: 0, d: 1 };
        winEnd = { y: base.y, m: 11, d: 31 };
      }
    }

    const windowStartStr = formatUtcYmd(winStart);
    const windowEndStr = formatUtcYmd(winEnd);
    candidates.push({
      phrase,
      start,
      end,
      resolved_date: windowStartStr,
      window_start: windowStartStr,
      window_end: windowEndStr,
      granularity: unit,
    });
  }

  const resolved = selectNonOverlappingLongest(candidates);
  if (resolved.length === 0) {
    return { resolved: [], annotatedText: text };
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const ann of resolved) {
    parts.push(text.slice(cursor, ann.end));
    const lookahead = text.slice(ann.end, Math.min(text.length, ann.end + 28));
    if (!ALREADY_ANNOTATED_AFTER_RE.test(lookahead)) {
      if (ann.granularity === 'day') {
        parts.push(` [${ann.resolved_date}]`);
      } else {
        parts.push(` [${ann.window_start}..${ann.window_end}]`);
      }
    }
    cursor = ann.end;
  }
  parts.push(text.slice(cursor));

  return {
    resolved,
    annotatedText: parts.join(''),
  };
}

// ---------------------------------------------------------------------------
// Search-Time Temporal Query Window Parser
// ---------------------------------------------------------------------------

interface QueryWindowSpan {
  start: number;
  end: number;
  phrase: string;
  startMs: number;
  endMs: number;
}

const QUERY_TRAILING_DURATION_RE = new RegExp(
  `\\b(?:(?:in|over|during|within|for)\\s{1,4})?(?:the\\s{1,4})?(?:past|last)\\s{1,4}(${NUM_TOKEN_NO_ARTICLE_SRC})\\s{1,4}(day|week|month|year)s?\\b`,
  'gi'
);

const QUERY_PERIOD_SPAN_RE =
  /\b(?:(in|over|during|within)\s{1,4})?(?:(the)\s{1,4})?(earlier\s{1,4}this|this\s{1,4}past|previous|past|last|this|next)\s{1,4}(week|month|year)\b(?![’']s\b)/gi;

const QUERY_AGO_RE = new RegExp(
  `\\b(?:(?:around|about)\\s{1,4})?(${NUM_TOKEN_SRC})\\s{1,4}(day|week|month|year)s?\\s{1,4}ago\\b`,
  'gi'
);

const QUERY_FUTURE_OFFSET_RE = new RegExp(
  `\\b(?:in\\s{1,4}(${NUM_TOKEN_SRC})\\s{1,4}(day|week|month|year)s?(?![’']s\\b)|(${NUM_TOKEN_SRC})\\s{1,4}(day|week|month|year)s?\\s{1,4}(?:from\\s{1,4}now|later))\\b`,
  'gi'
);

const QUERY_ISO_DATE_RE =
  /(?<![0-9a-fA-F-])(?:(?:on|in|around|from|since|at)\s{1,4})?(\d{4})-(\d{2})-(\d{2})(?![0-9a-fA-F-])/gi;

const MONTH_NAMES_SRC =
  'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';

const QUERY_MONTH_DAY_YEAR_RE = new RegExp(
  `\\b(?:(on|around|in|from|since)\\s{1,4})?(${MONTH_NAMES_SRC})(\\.?)\\s{1,4}(\\d{1,2})(st|nd|rd|th)?(?:,?\\s{1,4}(\\d{4}))?\\b`,
  'gi'
);

const QUERY_DAY_MONTH_YEAR_RE = new RegExp(
  `\\b(?:(on|around|from|since)\\s{1,4})?(\\d{1,2})(st|nd|rd|th)?\\s{1,4}(of\\s{1,4})?(${MONTH_NAMES_SRC})(\\.?)(?:,?\\s{1,4}(\\d{4}))?\\b`,
  'gi'
);

const QUERY_MONTH_YEAR_OR_PREP_RE = new RegExp(
  `\\b(?:(in|during|of|from|around|since)\\s{1,4})?(${MONTH_NAMES_SRC})(\\.?)(?:,?\\s{1,4}(\\d{4}))?\\b`,
  'gi'
);

const QUERY_QUARTER_RE = /\b(?:(?:in|during|for|of)\s{1,4})?Q([1-4])\s{1,4}(\d{4})\b/gi;

const BETWEEN_PREFIX_RE = /\bbetween\s{1,4}$/i;
const FROM_PREFIX_RE = /\bfrom\s{1,4}$/i;
const AND_CONNECTOR_RE = /^\s{1,4}and\s{1,4}$/i;
const TO_CONNECTOR_RE = /^\s{1,4}(?:to|through|until)\s{1,4}$|^\s{0,2}[–—-]\s{0,2}$/i;

function resolveMostRecentMonthYear(monthZeroBased: number, refDate: Date): number {
  const refY = refDate.getUTCFullYear();
  const candidateStartMs = Date.UTC(refY, monthZeroBased, 1, 0, 0, 0, 0);
  return candidateStartMs <= refDate.getTime() ? refY : refY - 1;
}

function resolveMostRecentMonthDayYear(
  monthZeroBased: number,
  day: number,
  refDate: Date
): number | null {
  const refY = refDate.getUTCFullYear();
  for (const y of [refY, refY - 1, refY - 2, refY - 3, refY - 4]) {
    if (day >= 1 && day <= daysInUtcMonth(y, monthZeroBased)) {
      const candidateMs = Date.UTC(y, monthZeroBased, day, 0, 0, 0, 0);
      if (candidateMs <= refDate.getTime() + 12 * HOUR_MS) {
        return y;
      }
    }
  }
  return null;
}

function makeSymmetricSpan(
  start: number,
  end: number,
  phrase: string,
  centerMs: number,
  halfWidthMs: number
): QueryWindowSpan {
  return {
    start,
    end,
    phrase,
    startMs: centerMs - halfWidthMs,
    endMs: centerMs + halfWidthMs,
  };
}

function isResidualTrimChar(code: number): boolean {
  return (
    code === 32 || // ' '
    code === 9 || // '\t'
    code === 10 || // '\n'
    code === 13 || // '\r'
    code === 11 || // '\v'
    code === 12 || // '\f'
    code === 63 || // '?'
    code === 46 || // '.'
    code === 44 || // ','
    code === 33 || // '!'
    code === 59 || // ';'
    code === 58 || // ':'
    code === 45 // '-'
  );
}

function trimResidualQuery(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ');
  let start = 0;
  let end = collapsed.length;
  while (start < end && isResidualTrimChar(collapsed.charCodeAt(start))) {
    start++;
  }
  while (end > start && isResidualTrimChar(collapsed.charCodeAt(end - 1))) {
    end--;
  }
  return start >= end ? '' : collapsed.slice(start, end);
}

/**
 * Parses natural-language and explicit calendar temporal constraints in a search query
 * relative to `referenceDate` (defaults to `new Date()`).
 *
 * Returns `null` when no temporal constraint is present.
 */
export function parseTemporalQueryWindow(
  query: string,
  referenceDate?: string | number | Date | null
): ParsedTemporalWindow | null {
  if (!query || typeof query !== 'string') return null;

  const refDate =
    referenceDate === undefined || referenceDate === null
      ? new Date()
      : parseAnchorUtc(referenceDate);
  if (!refDate) return null;

  const scanText =
    query.length > MAX_QUERY_TEMPORAL_SCAN_CHARS
      ? safeUtf16Slice(query, 0, MAX_QUERY_TEMPORAL_SCAN_CHARS)
      : query;

  const refMs = refDate.getTime();
  const refYmd = toUtcYmd(refDate);
  const candidates: QueryWindowSpan[] = [];
  let m: RegExpExecArray | null;
  let count = 0;

  // 1. Trailing relative durations: "in the past two weeks", "last 3 months", "over the past 7 days"
  QUERY_TRAILING_DURATION_RE.lastIndex = 0;
  count = 0;
  while (count < MAX_MATCHES_PER_PATTERN && (m = QUERY_TRAILING_DURATION_RE.exec(scanText)) !== null) {
    count++;
    const n = parseNumberToken(m[1]);
    if (n === null || n <= 0) continue;
    const unit = m[2].toLowerCase();
    const phrase = m[0];
    const start = m.index;
    const end = start + phrase.length;

    let startMs: number;
    const endMs = refMs + 12 * HOUR_MS;
    if (unit === 'day') {
      startMs = refMs - n * DAY_MS - 12 * HOUR_MS;
    } else if (unit === 'week') {
      startMs = refMs - n * 7 * DAY_MS - DAY_MS;
    } else if (unit === 'month') {
      const sYmd = addUtcMonthsClamped(refYmd, -n);
      startMs = Date.UTC(sYmd.y, sYmd.m, sYmd.d, 0, 0, 0, 0) - 2 * DAY_MS;
    } else {
      const sYmd = addUtcYearsClamped(refYmd, -n);
      startMs = Date.UTC(sYmd.y, sYmd.m, sYmd.d, 0, 0, 0, 0) - 7 * DAY_MS;
    }
    candidates.push({ start, end, phrase, startMs, endMs });
  }

  // 2. Point-in-past offsets: "<N> (day|week|month|year)s ago"
  QUERY_AGO_RE.lastIndex = 0;
  count = 0;
  while (count < MAX_MATCHES_PER_PATTERN && (m = QUERY_AGO_RE.exec(scanText)) !== null) {
    count++;
    const n = parseNumberToken(m[1]);
    if (n === null || n < 0) continue;
    const unit = m[2].toLowerCase();
    const phrase = m[0];
    const start = m.index;
    const end = start + phrase.length;

    if (unit === 'week') {
      const centerMs = refMs - n * 7 * DAY_MS;
      candidates.push(makeSymmetricSpan(start, end, phrase, centerMs, 7 * DAY_MS));
    } else if (unit === 'day') {
      const centerMs = refMs - n * DAY_MS;
      const halfDays = Math.max(1.5, Math.ceil(n * 0.25));
      candidates.push(makeSymmetricSpan(start, end, phrase, centerMs, halfDays * DAY_MS));
    } else if (unit === 'month') {
      const tYmd = addUtcMonthsClamped(refYmd, -n);
      const centerMs = Date.UTC(
        tYmd.y,
        tYmd.m,
        tYmd.d,
        refDate.getUTCHours(),
        refDate.getUTCMinutes(),
        refDate.getUTCSeconds()
      );
      candidates.push(makeSymmetricSpan(start, end, phrase, centerMs, 14 * DAY_MS));
    } else {
      const tYmd = addUtcYearsClamped(refYmd, -n);
      const centerMs = Date.UTC(
        tYmd.y,
        tYmd.m,
        tYmd.d,
        refDate.getUTCHours(),
        refDate.getUTCMinutes(),
        refDate.getUTCSeconds()
      );
      candidates.push(makeSymmetricSpan(start, end, phrase, centerMs, 45 * DAY_MS));
    }
  }

  // 3. Point-in-future offsets: "in <N> days/weeks/...", "<N> weeks from now"
  QUERY_FUTURE_OFFSET_RE.lastIndex = 0;
  count = 0;
  while (count < MAX_MATCHES_PER_PATTERN && (m = QUERY_FUTURE_OFFSET_RE.exec(scanText)) !== null) {
    count++;
    const rawNum = m[1] ?? m[3];
    const rawUnit = m[2] ?? m[4];
    if (!rawNum || !rawUnit) continue;
    const n = parseNumberToken(rawNum);
    if (n === null || n < 0) continue;
    const unit = rawUnit.toLowerCase();
    const phrase = m[0];
    const start = m.index;
    const end = start + phrase.length;

    if (unit === 'week') {
      const centerMs = refMs + n * 7 * DAY_MS;
      candidates.push(makeSymmetricSpan(start, end, phrase, centerMs, 7 * DAY_MS));
    } else if (unit === 'day') {
      const centerMs = refMs + n * DAY_MS;
      const halfDays = Math.max(1.5, Math.ceil(n * 0.25));
      candidates.push(makeSymmetricSpan(start, end, phrase, centerMs, halfDays * DAY_MS));
    } else if (unit === 'month') {
      const tYmd = addUtcMonthsClamped(refYmd, n);
      const centerMs = Date.UTC(tYmd.y, tYmd.m, tYmd.d, 12, 0, 0, 0);
      candidates.push(makeSymmetricSpan(start, end, phrase, centerMs, 14 * DAY_MS));
    } else {
      const tYmd = addUtcYearsClamped(refYmd, n);
      const centerMs = Date.UTC(tYmd.y, tYmd.m, tYmd.d, 12, 0, 0, 0);
      candidates.push(makeSymmetricSpan(start, end, phrase, centerMs, 45 * DAY_MS));
    }
  }

  // 4. Day anchors: today, yesterday, the day before yesterday, tomorrow
  DAY_ANCHOR_RE.lastIndex = 0;
  count = 0;
  while (count < MAX_MATCHES_PER_PATTERN && (m = DAY_ANCHOR_RE.exec(scanText)) !== null) {
    count++;
    const phrase = m[0];
    const start = m.index;
    const end = start + phrase.length;
    const norm = phrase.toLowerCase().replace(/\s+/g, ' ');
    let deltaDays = 0;
    if (norm === 'the day before yesterday') deltaDays = -2;
    else if (norm === 'yesterday') deltaDays = -1;
    else if (norm === 'tomorrow') deltaDays = 1;
    else if (norm === 'the day after tomorrow') deltaDays = 2;

    const centerMs = refMs + deltaDays * DAY_MS;
    candidates.push(makeSymmetricSpan(start, end, phrase, centerMs, 1.5 * DAY_MS));
  }

  // 5. Qualified weekdays: "last Saturday", "this past Tuesday", "on Friday"
  WEEKDAY_QUALIFIED_RE.lastIndex = 0;
  count = 0;
  while (count < MAX_MATCHES_PER_PATTERN && (m = WEEKDAY_QUALIFIED_RE.exec(scanText)) !== null) {
    count++;
    const rawQual = m[1];
    const rawDay = m[2];
    const trailingDot = m[3] || '';
    const dayLower = rawDay.toLowerCase();

    if (
      AMBIGUOUS_LOWERCASE_WEEKDAY_ABBREVS.has(dayLower) &&
      rawDay[0] !== rawDay[0].toUpperCase()
    ) {
      continue;
    }

    const targetDow = WEEKDAY_INDEX[dayLower];
    if (targetDow === undefined) continue;

    const end = m.index + m[0].length - trailingDot.length;
    const start = m.index;
    const phrase = scanText.slice(start, end);
    const qualLower = rawQual.toLowerCase().replace(/\s+/g, ' ');

    if (qualLower === 'on' || qualLower === 'this') {
      const afterSlice = scanText.slice(end, Math.min(scanText.length, end + 32));
      if (EXPLICIT_DATE_AFTER_WEEKDAY_RE.test(afterSlice)) {
        continue;
      }
    }

    const beforeSlice = scanText.slice(Math.max(0, start - 50), start);
    const resolvedYmd = resolveQualifiedWeekday(refYmd, qualLower, targetDow, beforeSlice);
    const centerMs = Date.UTC(resolvedYmd.y, resolvedYmd.m, resolvedYmd.d, 12, 0, 0, 0);
    candidates.push(makeSymmetricSpan(start, end, phrase, centerMs, 1.5 * DAY_MS));
  }

  // 6. Relative period spans: "last week", "this week", "last month", "this month", "last year", "this year"
  QUERY_PERIOD_SPAN_RE.lastIndex = 0;
  count = 0;
  while (count < MAX_MATCHES_PER_PATTERN && (m = QUERY_PERIOD_SPAN_RE.exec(scanText)) !== null) {
    count++;
    const hasPrep = Boolean(m[1]);
    const hasThe = Boolean(m[2]);
    const qual = m[3].toLowerCase().replace(/\s+/g, ' ');
    const unit = m[4].toLowerCase() as 'week' | 'month' | 'year';

    // Bare "past week" without "the"/"this" is only natural with "the past week" or "this past week"
    if (qual === 'past' && !hasThe && !hasPrep) {
      continue;
    }

    const phrase = m[0];
    const start = m.index;
    const end = start + phrase.length;

    let startMs: number;
    let endMs: number;

    if (unit === 'week') {
      if (qual === 'last' || qual === 'this past' || qual === 'previous' || qual === 'past') {
        startMs = refMs - 14 * DAY_MS;
        endMs = refMs;
      } else if (qual === 'next') {
        const curMon = startOfIsoWeek(refYmd);
        const nextMon = addUtcDays(curMon, 7);
        const nextSun = addUtcDays(curMon, 13);
        startMs = Date.UTC(nextMon.y, nextMon.m, nextMon.d, 0, 0, 0, 0) - 12 * HOUR_MS;
        endMs = Date.UTC(nextSun.y, nextSun.m, nextSun.d, 23, 59, 59, 999) + 12 * HOUR_MS;
      } else {
        // "this week" / "earlier this week"
        const curMon = startOfIsoWeek(refYmd);
        startMs = Date.UTC(curMon.y, curMon.m, curMon.d, 0, 0, 0, 0) - DAY_MS;
        endMs = refMs + 12 * HOUR_MS;
      }
    } else if (unit === 'month') {
      if (qual === 'last' || qual === 'this past' || qual === 'previous' || qual === 'past') {
        const prev = addUtcMonthsClamped({ y: refYmd.y, m: refYmd.m, d: 1 }, -1);
        const lastDay = daysInUtcMonth(prev.y, prev.m);
        startMs = Date.UTC(prev.y, prev.m, 1, 0, 0, 0, 0) - 2 * DAY_MS;
        endMs = Date.UTC(prev.y, prev.m, lastDay, 23, 59, 59, 999) + 2 * DAY_MS;
      } else if (qual === 'next') {
        const nxt = addUtcMonthsClamped({ y: refYmd.y, m: refYmd.m, d: 1 }, 1);
        const lastDay = daysInUtcMonth(nxt.y, nxt.m);
        startMs = Date.UTC(nxt.y, nxt.m, 1, 0, 0, 0, 0) - 2 * DAY_MS;
        endMs = Date.UTC(nxt.y, nxt.m, lastDay, 23, 59, 59, 999) + 2 * DAY_MS;
      } else {
        startMs = Date.UTC(refYmd.y, refYmd.m, 1, 0, 0, 0, 0);
        endMs = refMs + 12 * HOUR_MS;
      }
    } else {
      if (qual === 'last' || qual === 'this past' || qual === 'previous' || qual === 'past') {
        startMs = Date.UTC(refYmd.y - 1, 0, 1, 0, 0, 0, 0);
        endMs = Date.UTC(refYmd.y - 1, 11, 31, 23, 59, 59, 999);
      } else if (qual === 'next') {
        startMs = Date.UTC(refYmd.y + 1, 0, 1, 0, 0, 0, 0);
        endMs = Date.UTC(refYmd.y + 1, 11, 31, 23, 59, 59, 999);
      } else {
        startMs = Date.UTC(refYmd.y, 0, 1, 0, 0, 0, 0);
        endMs = refMs + 12 * HOUR_MS;
      }
    }

    candidates.push({ start, end, phrase, startMs, endMs });
  }

  // 7. Explicit ISO date: YYYY-MM-DD
  QUERY_ISO_DATE_RE.lastIndex = 0;
  count = 0;
  while (count < MAX_MATCHES_PER_PATTERN && (m = QUERY_ISO_DATE_RE.exec(scanText)) !== null) {
    count++;
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    if (year < 1900 || year > 2200 || month < 1 || month > 12) continue;
    if (day < 1 || day > daysInUtcMonth(year, month - 1)) continue;

    const phrase = m[0];
    const start = m.index;
    const end = start + phrase.length;
    const centerMs = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
    candidates.push(makeSymmetricSpan(start, end, phrase, centerMs, 1.5 * DAY_MS));
  }

  // 8. Explicit "Month Day[, Year]" (e.g. "May 20, 2023", "May 20th, 2023", "on May 15")
  QUERY_MONTH_DAY_YEAR_RE.lastIndex = 0;
  count = 0;
  while (count < MAX_MATCHES_PER_PATTERN && (m = QUERY_MONTH_DAY_YEAR_RE.exec(scanText)) !== null) {
    count++;
    const prep = m[1];
    const rawMonth = m[2];
    const day = parseInt(m[4], 10);
    const ordinal = m[5];
    const rawYear = m[6];

    const monthIdx = MONTH_INDEX[rawMonth.toLowerCase()];
    if (monthIdx === undefined) continue;

    // Guard modal verb "may" when lowercase without explicit year, ordinal, or "on" preposition
    if (
      rawMonth.toLowerCase() === 'may' &&
      rawMonth[0] !== 'M' &&
      !rawYear &&
      !ordinal &&
      (!prep || prep.toLowerCase() !== 'on')
    ) {
      continue;
    }

    let year: number | null;
    if (rawYear) {
      year = parseInt(rawYear, 10);
      if (year < 1900 || year > 2200) continue;
      if (day < 1 || day > daysInUtcMonth(year, monthIdx)) continue;
    } else {
      // If day looks like a 4-digit year wouldn't reach here (\d{1,2}), validate day <= 31
      if (day < 1 || day > 31) continue;
      year = resolveMostRecentMonthDayYear(monthIdx, day, refDate);
      if (year === null) continue;
    }

    const phrase = m[0];
    const start = m.index;
    const end = start + phrase.length;
    const centerMs = Date.UTC(year, monthIdx, day, 12, 0, 0, 0);
    candidates.push(makeSymmetricSpan(start, end, phrase, centerMs, 1.5 * DAY_MS));
  }

  // 9. Explicit "Day Month [Year]" (e.g. "20 May 2023", "20th of May 2023")
  QUERY_DAY_MONTH_YEAR_RE.lastIndex = 0;
  count = 0;
  while (count < MAX_MATCHES_PER_PATTERN && (m = QUERY_DAY_MONTH_YEAR_RE.exec(scanText)) !== null) {
    count++;
    const prep = m[1];
    const day = parseInt(m[2], 10);
    const ordinal = m[3];
    const hasOf = Boolean(m[4]);
    const rawMonth = m[5];
    const rawYear = m[7];

    const monthIdx = MONTH_INDEX[rawMonth.toLowerCase()];
    if (monthIdx === undefined) continue;

    // Without year, require ordinal/of/prep, and protect lowercase modal "may"
    if (!rawYear && !ordinal && !hasOf && !prep) continue;
    if (rawMonth.toLowerCase() === 'may' && rawMonth[0] !== 'M' && !rawYear && !hasOf) {
      continue;
    }

    let year: number | null;
    if (rawYear) {
      year = parseInt(rawYear, 10);
      if (year < 1900 || year > 2200) continue;
      if (day < 1 || day > daysInUtcMonth(year, monthIdx)) continue;
    } else {
      if (day < 1 || day > 31) continue;
      year = resolveMostRecentMonthDayYear(monthIdx, day, refDate);
      if (year === null) continue;
    }

    const phrase = m[0];
    const start = m.index;
    const end = start + phrase.length;
    const centerMs = Date.UTC(year, monthIdx, day, 12, 0, 0, 0);
    candidates.push(makeSymmetricSpan(start, end, phrase, centerMs, 1.5 * DAY_MS));
  }

  // 10. Calendar Month (+ optional Year): "in March", "in May", "March 2023", "May 2023"
  QUERY_MONTH_YEAR_OR_PREP_RE.lastIndex = 0;
  count = 0;
  while (count < MAX_MATCHES_PER_PATTERN && (m = QUERY_MONTH_YEAR_OR_PREP_RE.exec(scanText)) !== null) {
    count++;
    const prep = m[1];
    const rawMonth = m[2];
    const trailingDot = m[3] || '';
    const rawYear = m[4];
    const monthIdx = MONTH_INDEX[rawMonth.toLowerCase()];
    if (monthIdx === undefined) continue;

    const beforeSlice = scanText.slice(Math.max(0, m.index - 16), m.index);
    const afterSlice = scanText.slice(
      m.index + m[0].length,
      Math.min(scanText.length, m.index + m[0].length + 16)
    );
    const inRangeConstruct =
      (BETWEEN_PREFIX_RE.test(beforeSlice) && /^(\s{1,4}and\s{1,4})/i.test(afterSlice)) ||
      (FROM_PREFIX_RE.test(beforeSlice) && /^(\s{1,4}(?:to|through|until)\s{1,4})/i.test(afterSlice)) ||
      AND_CONNECTOR_RE.test(beforeSlice) ||
      TO_CONNECTOR_RE.test(beforeSlice);

    let year: number;
    if (rawYear) {
      year = parseInt(rawYear, 10);
      if (year < 1900 || year > 2200) continue;
      // Guard lowercase "may 2023" unless preceded by preposition or range connector or capitalized "May"
      if (
        rawMonth.toLowerCase() === 'may' &&
        rawMonth[0] !== 'M' &&
        !prep &&
        !inRangeConstruct
      ) {
        continue;
      }
    } else {
      if (!prep && !inRangeConstruct) continue;
      // Strict modal-verb guard: bare "May" without year/day MUST be capitalized "May"
      if (rawMonth.toLowerCase() === 'may' && rawMonth[0] !== 'M') {
        continue;
      }
      const sharedTrailingYear =
        /^\s{1,4}(?:and|to|through|until)\s{1,4}[A-Za-z.]{3,10},?\s{1,4}(\d{4})\b/i.exec(
          scanText.slice(
            m.index + m[0].length,
            Math.min(scanText.length, m.index + m[0].length + 36)
          )
        );
      if (sharedTrailingYear) {
        const trailingY = parseInt(sharedTrailingYear[1], 10);
        year =
          trailingY >= 1900 && trailingY <= 2200
            ? trailingY
            : resolveMostRecentMonthYear(monthIdx, refDate);
      } else {
        year = resolveMostRecentMonthYear(monthIdx, refDate);
      }
    }

    const includeDot = Boolean(rawYear) || (trailingDot === '.' && rawMonth.length <= 4);
    const end = m.index + m[0].length - (!rawYear && trailingDot && !includeDot ? trailingDot.length : 0);
    const start = m.index;
    const phrase = scanText.slice(start, end);

    const lastDay = daysInUtcMonth(year, monthIdx);
    const startMs = Date.UTC(year, monthIdx, 1, 0, 0, 0, 0);
    const endMs = Date.UTC(year, monthIdx, lastDay, 23, 59, 59, 999);
    candidates.push({ start, end, phrase, startMs, endMs });
  }

  // 11. Quarters: "Q1 2023", "in Q4 2024"
  QUERY_QUARTER_RE.lastIndex = 0;
  count = 0;
  while (count < MAX_MATCHES_PER_PATTERN && (m = QUERY_QUARTER_RE.exec(scanText)) !== null) {
    count++;
    const qNum = parseInt(m[1], 10);
    const year = parseInt(m[2], 10);
    if (qNum < 1 || qNum > 4 || year < 1900 || year > 2200) continue;
    const startMonth = (qNum - 1) * 3;
    const endMonth = startMonth + 2;
    const endDay = daysInUtcMonth(year, endMonth);
    const phrase = m[0];
    const start = m.index;
    const end = start + phrase.length;
    const startMs = Date.UTC(year, startMonth, 1, 0, 0, 0, 0);
    const endMs = Date.UTC(year, endMonth, endDay, 23, 59, 59, 999);
    candidates.push({ start, end, phrase, startMs, endMs });
  }

  const selected = selectNonOverlappingLongest(candidates);
  if (selected.length === 0) return null;

  // Merge adjacent multi-bound range pairs: "between <A> and <B>" or "from <A> to <B>"
  const merged: QueryWindowSpan[] = [];
  let idx = 0;
  while (idx < selected.length) {
    if (idx + 1 < selected.length) {
      const a = selected[idx];
      const b = selected[idx + 1];
      if (b.start - a.end <= 16) {
        const connector = scanText.slice(a.end, b.start);
        const beforeA = scanText.slice(Math.max(0, a.start - 16), a.start);

        const betweenMatch = BETWEEN_PREFIX_RE.exec(beforeA);
        if (betweenMatch && AND_CONNECTOR_RE.test(connector)) {
          const rangeStart = a.start - betweenMatch[0].length;
          const rangeEnd = b.end;
          merged.push({
            start: rangeStart,
            end: rangeEnd,
            phrase: scanText.slice(rangeStart, rangeEnd),
            startMs: Math.min(a.startMs, b.startMs),
            endMs: Math.max(a.endMs, b.endMs),
          });
          idx += 2;
          continue;
        }

        const fromMatch = FROM_PREFIX_RE.exec(beforeA);
        const aStartsWithFrom = /^from\s{1,4}/i.test(a.phrase);
        if ((fromMatch || aStartsWithFrom) && TO_CONNECTOR_RE.test(connector)) {
          const rangeStart = aStartsWithFrom ? a.start : a.start - fromMatch![0].length;
          const rangeEnd = b.end;
          merged.push({
            start: rangeStart,
            end: rangeEnd,
            phrase: scanText.slice(rangeStart, rangeEnd),
            startMs: Math.min(a.startMs, b.startMs),
            endMs: Math.max(a.endMs, b.endMs),
          });
          idx += 2;
          continue;
        }
      }
    }
    merged.push(selected[idx]);
    idx++;
  }

  let overallStartMs = merged[0].startMs;
  let overallEndMs = merged[0].endMs;
  const expressions: string[] = [];

  for (const span of merged) {
    if (span.startMs < overallStartMs) overallStartMs = span.startMs;
    if (span.endMs > overallEndMs) overallEndMs = span.endMs;
    expressions.push(span.phrase);
  }

  // Build residualQuery from bounded scanText with O(N) character-index trimming
  const residualParts: string[] = [];
  let cursor = 0;
  for (const span of merged) {
    let seg = scanText.slice(cursor, span.start);
    seg = seg.replace(/\b(?:on|in|at|around|during|over|within|from|since)\s{0,16}$/i, ' ');
    residualParts.push(seg);
    cursor = span.end;
  }
  residualParts.push(scanText.slice(cursor));

  const residualQuery = trimResidualQuery(residualParts.join(' '));

  const centerMs = Math.round((overallStartMs + overallEndMs) / 2);
  const halfWidthMs = Math.max(HOUR_MS, Math.round((overallEndMs - overallStartMs) / 2));

  return {
    windowStartIso: new Date(overallStartMs).toISOString(),
    windowEndIso: new Date(overallEndMs).toISOString(),
    centerMs,
    halfWidthMs,
    expressions,
    residualQuery,
  };
}
