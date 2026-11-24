/**
 * Deterministic, zero-dependency extractive text condenser, query-focused
 * snippet windowing engine, and information-density analyzer.
 *
 * Designed for both ingest-time observation condensation (zero generative model
 * calls; raw `input`/`output` remain untouched in SQLite) and search-time
 * passage extraction across arbitrarily long observations.
 */

export interface PassageSpan {
  text: string;
  start: number;
  end: number;
}

export interface CondenseTextOptions {
  maxChars?: number;
  kind?: 'prompt' | 'response' | 'tool_call' | string;
  preserveShortThreshold?: number;
}

export interface CondenseObservationInput {
  kind: 'prompt' | 'response' | 'tool_call' | string;
  toolName?: string | null;
  filePath?: string | null;
  input?: string | null;
  output?: string | null;
  maxChars?: number;
}

export interface QueryFocusedSnippetOptions {
  maxChars?: number;
  contextSentences?: number;
  preferredSpan?: { start: number; end: number };
}

export interface InformationDensityMetrics {
  density: number;
  uniqueContentRatio: number;
  boilerplateListRatio: number;
}

const MAX_SINGLE_PASSAGE_CHARS = 320;
const SUBCHUNK_TARGET_CHARS = 260;
const SUBCHUNK_MIN_BREAK_CHARS = 140;
const MAX_CONDENSE_CANDIDATE_PASSAGES = 160;
const JACCARD_WINDOW_SIZE = 20;
const MAX_QUERY_PARSE_CHARS = 8_000;
const MAX_DENSITY_SAMPLE_CHARS = 12_000;
const MAX_DENSITY_SAMPLE_LINES = 200;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Advances `index` past a trailing low surrogate when `index` splits a valid UTF-16 surrogate pair.
 */
export function alignUtf16Start(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  if (isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(text.charCodeAt(index - 1))) {
    return index + 1;
  }
  return index;
}

/**
 * Retreats `end` before a dangling high surrogate when `end` splits a valid UTF-16 surrogate pair.
 */
export function alignUtf16End(text: string, end: number, minStart = 0): number {
  if (end <= minStart) return minStart;
  if (end >= text.length) return text.length;
  if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
    return Math.max(minStart, end - 1);
  }
  return end;
}

/**
 * Slices `text` cleanly on UTF-16 code-point boundaries so lone surrogates are never emitted.
 */
export function safeUtf16Slice(text: string, start: number, end?: number): string {
  const len = text.length;
  const s = alignUtf16Start(text, Math.max(0, Math.min(len, start)));
  const rawEnd = end === undefined ? len : Math.max(s, Math.min(len, end));
  const e = alignUtf16End(text, rawEnd, s);
  return text.slice(s, e);
}

const NON_BREAKING_ABBREVIATIONS = new Set([
  'e.g',
  'i.e',
  'vs',
  'v',
  'etc',
  'cf',
  'al',
  'approx',
  'est',
  'min',
  'max',
  'fig',
  'figs',
  'eq',
  'no',
  'nos',
  'vol',
  'ch',
  'sec',
  'pp',
  'inc',
  'corp',
  'ltd',
  'co',
  'jr',
  'sr',
  'st',
  'ave',
  'blvd',
  'rd',
  'dr',
  'mr',
  'mrs',
  'ms',
  'prof',
  'rev',
  'gen',
  'col',
  'capt',
  'sgt',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
  'u.s',
  'u.k',
  'e.u',
  'a.m',
  'p.m',
]);

export const STOPWORDS = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'all',
  'also',
  'am',
  'an',
  'and',
  'any',
  'are',
  'aren',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'could',
  'did',
  'didn',
  'do',
  'does',
  'doesn',
  'doing',
  'don',
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'get',
  'got',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'isn',
  'it',
  'its',
  'itself',
  'just',
  'let',
  'make',
  'may',
  'me',
  'might',
  'more',
  'most',
  'must',
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'ought',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'please',
  'same',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'very',
  'was',
  'wasn',
  'we',
  'were',
  'weren',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
  // Assistant conversational filler words excluded from content-density vocabulary
  'sure',
  'certainly',
  'absolutely',
  'definitely',
  'happy',
  'glad',
  'help',
  'helps',
  'helping',
  'hope',
  'feel',
  'free',
  'ask',
  'questions',
  'question',
  'know',
  'need',
  'anything',
  'else',
  'further',
  'hesitate',
  'reach',
  'additionally',
  'furthermore',
  'moreover',
  'overall',
]);

const CODE_FENCE_ONLY_RE = /^`{3,}[a-zA-Z0-9_-]*$/;

function isHorizontalRule(trimmed: string): boolean {
  if (trimmed.length < 3 || trimmed.length > 500) return false;
  let markerChar = '';
  let markerCount = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === ' ' || ch === '\t') continue;
    if (ch !== '-' && ch !== '*' && ch !== '_') return false;
    if (!markerChar) markerChar = ch;
    else if (ch !== markerChar) return false;
    markerCount++;
  }
  return markerCount >= 3;
}

const PURE_BOILERPLATE_PATTERNS: RegExp[] = [
  /^(?:sure|certainly|absolutely|of course|definitely|great|awesome|no problem|gladly|happy to help)(?:[!,.:\s]+(?:i(?:'d| would) be (?:happy|glad|delighted) to (?:help|assist)[^.!?]{0,90}|i can (?:certainly |definitely )?(?:help|assist)[^.!?]{0,90}|here(?:'s| is| are)\b[^.!?]{0,90}))?[!.:]?$/i,
  /^i(?:'d| would) be (?:more than )?(?:happy|glad|delighted) to (?:help|assist)\b[^.!?]{0,90}[!.:]?$/i,
  /^i can (?:certainly |definitely )?(?:help|assist) you\b[^.!?]{0,90}[!.:]?$/i,
  /^(?:great|good|excellent|wonderful|interesting) question[!.]?$/i,
  /^(?:here(?:'s| is| are)|below (?:is|are)) (?:a |an |the |some )?(?:comprehensive |detailed |quick |brief |step-by-step |helpful |curated |complete |general )?(?:list|overview|breakdown|summary|guide|explanation|look|set|collection|comparison|suggestions?|recommendations?|tips?|steps?|ideas?|options?|ways?|things?|points?)(?: (?:of|on|for|to|about|that|you)[a-zA-Z\s,'-]{0,80})?[:.]$/i,
  /^(?:i )?hope (?:this|that|these)(?: (?:information|explanation|guide|list|suggestions?|tips?))? helps?(?: you)?[!.]?$/i,
  /^feel free to (?:ask|reach out|let me know)(?: if you have (?:any )?(?:more |further |other |additional )?questions?(?: or concerns?)?)?[!.]?$/i,
  /^(?:please )?let me know if (?:you (?:need|have|want|would like)|there(?:'s| is)) (?:anything else|any (?:other |more |further )?questions?|me to [a-zA-Z\s]{1,50})[!.]?$/i,
  /^don't hesitate to (?:ask|reach out)[^.!?]{0,60}[!.]?$/i,
  /^happy (?:coding|building|debugging|helping|travels|cooking)[!.]?$/i,
  /^good luck(?: with your [a-zA-Z\s]{1,40})?[!.]?$/i,
];

const GENERIC_SECTION_HEADING_RE =
  /^\s*#{1,6}\s*(?:overview|introduction|summary|conclusion|final thoughts|key takeaways|tips(?: and tricks)?|recommendations|things to consider|best practices|general advice|additional tips)\s*:?\s*$/i;

const GENERIC_BOLD_BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+\*\*[^*\n]{2,55}\*\*\s*[:—–-]\s*/;

const CLOSING_PUNCT_CHARS = new Set(['"', "'", '”', '’', ')', ']', '}', '`']);

function isWhitespaceChar(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12 || code === 11;
}

function isSentenceClosingChar(ch: string): boolean {
  return CLOSING_PUNCT_CHARS.has(ch);
}

function isWordTokenChar(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 46 || // .
    c === 95 || // _
    c === 45 // -
  );
}

function trimSpan(text: string, start: number, end: number): PassageSpan | null {
  let s = alignUtf16Start(text, start);
  let e = alignUtf16End(text, end, s);
  while (s < e && isWhitespaceChar(text.charCodeAt(s))) s++;
  while (e > s && isWhitespaceChar(text.charCodeAt(e - 1))) e--;
  s = alignUtf16Start(text, s);
  e = alignUtf16End(text, e, s);
  if (s >= e) return null;
  return { text: text.slice(s, e), start: s, end: e };
}

function pushBoundedSpan(out: PassageSpan[], fullText: string, start: number, end: number): void {
  const trimmed = trimSpan(fullText, start, end);
  if (!trimmed) return;
  if (trimmed.end - trimmed.start <= MAX_SINGLE_PASSAGE_CHARS) {
    out.push(trimmed);
    return;
  }

  let cur = trimmed.start;
  const limitEnd = trimmed.end;
  while (cur < limitEnd) {
    if (limitEnd - cur <= MAX_SINGLE_PASSAGE_CHARS) {
      const tail = trimSpan(fullText, cur, limitEnd);
      if (tail) out.push(tail);
      break;
    }

    const windowMax = Math.min(limitEnd, cur + MAX_SINGLE_PASSAGE_CHARS);
    const preferredEnd = Math.min(limitEnd, cur + SUBCHUNK_TARGET_CHARS);
    const minBreak = cur + SUBCHUNK_MIN_BREAK_CHARS;

    let splitAt = -1;
    // Prefer clause boundary (; or ,) followed by space
    for (let i = preferredEnd; i >= minBreak; i--) {
      const ch = fullText[i - 1];
      if ((ch === ';' || ch === ',') && i < limitEnd && isWhitespaceChar(fullText.charCodeAt(i))) {
        splitAt = i;
        break;
      }
    }
    // Otherwise split at whitespace near target
    if (splitAt === -1) {
      for (let i = windowMax; i >= minBreak; i--) {
        if (isWhitespaceChar(fullText.charCodeAt(i))) {
          splitAt = i;
          break;
        }
      }
    }
    // Hard cut for whitespace-free blobs (e.g. long hex/base64/emoji/repeated chars)
    if (splitAt === -1 || splitAt <= cur) {
      splitAt = alignUtf16End(fullText, preferredEnd, cur + 1);
      if (splitAt <= cur) {
        splitAt = Math.min(limitEnd, cur + 2);
      }
    } else {
      splitAt = alignUtf16End(fullText, splitAt, cur + 1);
    }

    const chunk = trimSpan(fullText, cur, splitAt);
    if (chunk) out.push(chunk);
    cur = alignUtf16Start(fullText, splitAt);
    while (cur < limitEnd && isWhitespaceChar(fullText.charCodeAt(cur))) cur++;
  }
}

/**
 * Splits text into sentence/line passages while preserving exact `{ start, end }`
 * character offsets into `text` (`text.slice(span.start, span.end) === span.text`).
 *
 * Avoids breaking decimals (`3.14`), version numbers (`v1.2.3`), file paths
 * (`src/learning/search.ts`), URLs, list item prefixes (`1. Item`), and common
 * abbreviations (`e.g.`, `i.e.`, `vs.`, `Mr.`, `Mrs.`, `Dr.`, `etc.`).
 */
export function splitIntoPassages(text: string): PassageSpan[] {
  if (!text || typeof text !== 'string') return [];

  const spans: PassageSpan[] = [];
  const len = text.length;
  let lineStart = 0;

  while (lineStart < len) {
    let lineEnd = lineStart;
    while (lineEnd < len && text.charCodeAt(lineEnd) !== 10 && text.charCodeAt(lineEnd) !== 13) {
      lineEnd++;
    }

    splitLineIntoSentences(text, lineStart, lineEnd, spans);

    lineStart = lineEnd;
    while (lineStart < len && (text.charCodeAt(lineStart) === 10 || text.charCodeAt(lineStart) === 13)) {
      lineStart++;
    }
  }

  return spans;
}

function splitLineIntoSentences(
  text: string,
  lineStart: number,
  lineEnd: number,
  out: PassageSpan[]
): void {
  let segStart = lineStart;
  while (segStart < lineEnd && isWhitespaceChar(text.charCodeAt(segStart))) segStart++;
  if (segStart >= lineEnd) return;

  let i = segStart;
  while (i < lineEnd) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') {
      i++;
      continue;
    }

    let pEnd = i;
    while (
      pEnd + 1 < lineEnd &&
      (text[pEnd + 1] === '.' || text[pEnd + 1] === '!' || text[pEnd + 1] === '?')
    ) {
      pEnd++;
    }

    let afterPunct = pEnd + 1;
    while (afterPunct < lineEnd && isSentenceClosingChar(text[afterPunct])) {
      afterPunct++;
    }

    // End of line: flush at outer loop completion
    if (afterPunct >= lineEnd) {
      break;
    }

    // Sentence-ending punctuation inside a line must be followed by whitespace.
    // This immediately protects `3.14`, `v1.2.3`, `src/learning/search.ts`, and URLs.
    if (!isWhitespaceChar(text.charCodeAt(afterPunct))) {
      i = afterPunct;
      continue;
    }

    let nextNonSpace = afterPunct;
    while (nextNonSpace < lineEnd && isWhitespaceChar(text.charCodeAt(nextNonSpace))) {
      nextNonSpace++;
    }
    if (nextNonSpace >= lineEnd) {
      break;
    }

    if (ch === '.' && pEnd === i) {
      // Inspect token immediately preceding '.'
      let tokStart = i;
      while (tokStart > segStart && isWordTokenChar(text[tokStart - 1])) {
        tokStart--;
      }
      const rawPrevToken = text.slice(tokStart, i);
      const cleanPrevLower = rawPrevToken.replace(/^\.+|\.+$/g, '').toLowerCase();

      // 1. Protect ordered list item markers at start of segment: `1. Foo`, `a. Bar`
      if (tokStart === segStart && /^(?:\d{1,3}|[a-zA-Z])$/.test(rawPrevToken)) {
        i = afterPunct;
        continue;
      }

      // 2. Protect known abbreviations (`e.g.`, `i.e.`, `vs.`, `Mr.`, `Mrs.`, `Dr.`, `etc.`)
      if (
        NON_BREAKING_ABBREVIATIONS.has(cleanPrevLower) ||
        /^(?:[a-z]\.)+[a-z]$/i.test(cleanPrevLower)
      ) {
        i = afterPunct;
        continue;
      }

      // 3. Protect single-letter initials (`J. K. Rowling`, `E. coli`)
      if (rawPrevToken.length === 1 && /[A-Z]/.test(rawPrevToken)) {
        const nextChar = text[nextNonSpace];
        if (/[A-Z]/.test(nextChar)) {
          i = afterPunct;
          continue;
        }
      }

      // 4. Do not split on '.' when the next token begins with a lowercase letter
      const nextChar = text[nextNonSpace];
      if (nextChar >= 'a' && nextChar <= 'z') {
        i = afterPunct;
        continue;
      }
    }

    pushBoundedSpan(out, text, segStart, afterPunct);
    segStart = nextNonSpace;
    i = segStart;
  }

  if (segStart < lineEnd) {
    pushBoundedSpan(out, text, segStart, lineEnd);
  }
}

const HIGH_SIGNAL_CONCRETE_RE =
  /(?:\b\d+(?:[.:/-]\d+)*\b|(?<![a-zA-Z0-9_.-])[a-z0-9_.-]+\/[a-z0-9_./-]+|\b[a-z]+_[a-z0-9_]+\b|\b[a-z]+[A-Z][a-zA-Z0-9]*\b|`[^`\n]+`|\b(?:ENOENT|ECONNREFUSED|EADDRINUSE|TypeError|SyntaxError|ReferenceError|SqliteError|Exception|HTTP\s+[45]\d\d)\b)/;

function stripLeadingListMarker(text: string): string {
  return text.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, '');
}

function hasConcreteSignal(text: string): boolean {
  return HIGH_SIGNAL_CONCRETE_RE.test(stripLeadingListMarker(text));
}

/**
 * Returns true if a passage is pure conversational filler, decorative divider,
 * or generic section heading carrying zero concrete domain facts.
 */
export function isBoilerplatePassage(text: string): boolean {
  if (!text || typeof text !== 'string') return true;
  // Fast scan of first/last non-whitespace indices before allocating a trimmed copy on huge blobs
  let start = 0;
  let end = text.length;
  while (start < end && isWhitespaceChar(text.charCodeAt(start))) start++;
  while (end > start && isWhitespaceChar(text.charCodeAt(end - 1))) end--;
  const trimmedLen = end - start;
  if (trimmedLen <= 0) return true;
  if (trimmedLen > 500) return false;

  const trimmed = start === 0 && end === text.length ? text : text.slice(start, end);
  if (isHorizontalRule(trimmed)) return true;
  if (trimmedLen <= 80 && CODE_FENCE_ONLY_RE.test(trimmed)) return true;
  if (trimmedLen > 280) return false;
  if (GENERIC_SECTION_HEADING_RE.test(trimmed)) return true;

  if (hasConcreteSignal(trimmed)) {
    return false;
  }

  for (const pat of PURE_BOILERPLATE_PATTERNS) {
    if (pat.test(trimmed)) return true;
  }
  return false;
}

const ASCII_ONLY_RE = /^[\x00-\x7f]*$/;
const ASCII_WORD_RE = /[a-z0-9_]+/g;
const UNICODE_WORD_RE = /[\p{L}\p{N}_]+/gu;
const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const NON_CJK_WORD_RE =
  /[^\P{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}0-9_]+|[\p{N}_]+/gu;

function extractNormalizedTokens(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  if (ASCII_ONLY_RE.test(lower)) {
    const matches = lower.match(ASCII_WORD_RE);
    return matches ? matches : [];
  }

  const wordRuns = lower.match(UNICODE_WORD_RE);
  if (!wordRuns) return [];

  const tokens: string[] = [];
  for (const run of wordRuns) {
    if (ASCII_ONLY_RE.test(run)) {
      tokens.push(run);
      continue;
    }

    let hadCjk = false;
    CJK_RUN_RE.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = CJK_RUN_RE.exec(run)) !== null) {
      hadCjk = true;
      const chars = Array.from(cm[0]);
      if (chars.length === 1) {
        tokens.push(chars[0]);
      } else {
        for (let i = 0; i + 1 < chars.length; i++) {
          tokens.push(chars[i] + chars[i + 1]);
        }
      }
    }

    if (!hadCjk) {
      tokens.push(run);
    } else {
      const nonCjk = run.replace(CJK_RUN_RE, ' ').trim();
      if (nonCjk) {
        const sub = nonCjk.match(UNICODE_WORD_RE);
        if (sub) tokens.push(...sub);
      }
      void NON_CJK_WORD_RE;
    }
  }
  return tokens;
}

function tokenSetJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const minSize = a.size <= b.size ? a.size : b.size;
  const maxSize = a.size <= b.size ? b.size : a.size;
  if (minSize / maxSize < 0.85) return 0;

  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const tok of smaller) {
    if (larger.has(tok)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const CODE_IDENTIFIER_RE =
  /\b(?:[a-z]+[A-Z][a-zA-Z0-9]*|[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*|[a-zA-Z0-9]+_[a-zA-Z0-9_]+|[A-Z]{2,}[0-9_]*)\b/g;
const FILE_OR_URL_RE =
  /(?:https?:\/\/[^\s)]+|(?<![a-zA-Z0-9_.-])(?:\.{0,2}\/)?[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+|\b[a-zA-Z0-9_-]+\.(?:ts|tsx|js|jsx|json|py|rs|go|sql|sh|yml|yaml|toml|md|env|conf|lock)\b)/g;
const CLI_FLAG_OR_CMD_RE =
  /(?:(?:^|\s)--?[a-zA-Z][a-zA-Z0-9_-]*|\b(?:npm|npx|node|git|docker|curl|jest|tsc|pytest|cargo|kubectl)\s+[a-z0-9_-]+)/g;
const NUMBER_DATE_UNIT_RE =
  /(?:[$€£¥]\s?\d+(?:[.,]\d+)*|\b\d+(?:[.,]\d+)?(?:\s?(?:%|ms|s|sec|secs|m|min|mins|h|hr|hrs|d|days?|weeks?|months?|years?|kb|mb|gb|tb|px|rem))?\b|\bv\d+\.\d+(?:\.\d+)*\b|\b\d{4}-\d{2}-\d{2}\b)/gi;
const ERROR_MARKER_RE =
  /\b(?:error|exception|failed|failure|enoent|econnrefused|eaddrinuse|eacces|etimedout|typeerror|syntaxerror|referenceerror|sqliteerror|panic|fatal|stderr|[45]\d\d)\b/gi;
const QUOTED_LITERAL_RE = /(?:"[^"\n]{2,80}"|'[^'\n]{2,80}'|`[^`\n]{1,100}`)/g;
const FIRST_PERSON_FACT_RE =
  /\b(?:i\s+(?:prefer|like|love|dislike|hate|use|switched|moved|chose|decided|set|configured|live|work|bought|booked|scheduled|started|stopped|want|need|always|never)|we\s+(?:decided|chose|switched|use|migrated|standardized|agreed|prefer|set)|my\s+[a-z]{2,}|always\b|never\b)\b/gi;

function countRegexMatches(text: string, re: RegExp, cap = 8): number {
  re.lastIndex = 0;
  let count = 0;
  while (count < cap && re.exec(text) !== null) {
    count++;
  }
  return count;
}

function countMidSentenceProperNouns(text: string): number {
  const words = text.split(/\s+/);
  let count = 0;
  for (let i = 1; i < words.length && count < 6; i++) {
    const cleaned = words[i].replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '');
    if (/^[A-Z][a-z]{2,}$/.test(cleaned) && !STOPWORDS.has(cleaned.toLowerCase())) {
      count++;
    }
  }
  return count;
}

/**
 * Scores a single passage deterministically by information density and position.
 */
export function scorePassageInformation(
  text: string,
  index = 0,
  totalSubstantive = 1
): number {
  const trimmed = text.trim();
  if (!trimmed || isBoilerplatePassage(trimmed)) return 0;

  let score = 1.0;

  const withoutMarker = stripLeadingListMarker(trimmed);
  const codeIds = countRegexMatches(withoutMarker, CODE_IDENTIFIER_RE, 6);
  const pathsUrls = countRegexMatches(withoutMarker, FILE_OR_URL_RE, 4);
  const cliFlags = countRegexMatches(withoutMarker, CLI_FLAG_OR_CMD_RE, 4);
  const numbersDates = countRegexMatches(withoutMarker, NUMBER_DATE_UNIT_RE, 6);
  const errors = countRegexMatches(withoutMarker, ERROR_MARKER_RE, 5);
  const quotes = countRegexMatches(withoutMarker, QUOTED_LITERAL_RE, 4);
  const firstPerson = countRegexMatches(withoutMarker, FIRST_PERSON_FACT_RE, 4);
  const properNouns = countMidSentenceProperNouns(withoutMarker);

  score += codeIds * 1.4;
  score += pathsUrls * 2.2;
  score += cliFlags * 1.5;
  score += numbersDates * 1.6;
  score += errors * 2.0;
  score += quotes * 1.3;
  score += firstPerson * 2.1;
  score += properNouns * 1.1;

  // Content token richness per character
  const tokens = extractNormalizedTokens(trimmed);
  if (tokens.length > 0) {
    const uniqueContent = new Set(tokens.filter((t) => !STOPWORDS.has(t) && t.length >= 2));
    const contentRatio = uniqueContent.size / tokens.length;
    score += contentRatio * 2.0;
  }

  // Position bonuses: lead sentence & conclusion sentence
  if (index === 0) {
    score += 1.35;
  } else if (totalSubstantive > 2 && index === totalSubstantive - 1) {
    score += 0.85;
  }

  // Dampen generic markdown `**Bold Title**: generic advice` list items lacking concrete signals
  const concreteCount = codeIds + pathsUrls + cliFlags + numbersDates + errors + firstPerson;
  if (GENERIC_BOLD_BULLET_RE.test(trimmed) && concreteCount === 0) {
    score *= 0.45;
  }

  // Normalize gently against ultra-wordy clauses so crisp high-signal lines win
  const lengthFactor = Math.max(1, Math.sqrt(trimmed.length / 90));
  return score / lengthFactor;
}

/**
 * Analyzes overall information density of a text to distinguish concise high-signal
 * memories/logs from verbose generic assistant essays and repetitive lists.
 */
export function computeInformationDensity(text: string): InformationDensityMetrics {
  if (!text || typeof text !== 'string') {
    return { density: 0, uniqueContentRatio: 0, boilerplateListRatio: 0 };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { density: 0, uniqueContentRatio: 0, boilerplateListRatio: 0 };
  }

  // Cap analyzed slice to guarantee sub-millisecond scoring on huge tool dumps
  const sample =
    trimmed.length > MAX_DENSITY_SAMPLE_CHARS
      ? safeUtf16Slice(trimmed, 0, MAX_DENSITY_SAMPLE_CHARS)
      : trimmed;

  const tokens = extractNormalizedTokens(sample);
  if (tokens.length === 0) {
    return { density: 0, uniqueContentRatio: 0, boilerplateListRatio: 0 };
  }

  const uniqueContent = new Set<string>();
  for (const tok of tokens) {
    if (tok.length >= 2 && !STOPWORDS.has(tok)) {
      uniqueContent.add(tok);
    }
  }
  const uniqueContentRatio = Math.min(1, uniqueContent.size / tokens.length);

  const allRawLines = sample
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let rawLines = allRawLines;
  if (allRawLines.length > MAX_DENSITY_SAMPLE_LINES) {
    const step = allRawLines.length / MAX_DENSITY_SAMPLE_LINES;
    rawLines = [];
    for (let i = 0; i < MAX_DENSITY_SAMPLE_LINES; i++) {
      rawLines.push(allRawLines[Math.floor(i * step)]);
    }
  }

  let boilerplateOrGenericLines = 0;
  for (const line of rawLines) {
    if (isBoilerplatePassage(line)) {
      boilerplateOrGenericLines++;
      continue;
    }
    if (GENERIC_BOLD_BULLET_RE.test(line) && !hasConcreteSignal(line)) {
      boilerplateOrGenericLines++;
      continue;
    }
    if (
      /^\s*(?:[-*+]|\d+[.)])\s+/.test(line) &&
      !hasConcreteSignal(line) &&
      !FIRST_PERSON_FACT_RE.test(line)
    ) {
      FIRST_PERSON_FACT_RE.lastIndex = 0;
      boilerplateOrGenericLines += 0.65;
    }
    FIRST_PERSON_FACT_RE.lastIndex = 0;
  }

  const boilerplateListRatio =
    rawLines.length > 0 ? Math.min(1, boilerplateOrGenericLines / rawLines.length) : 0;

  const concreteSignals =
    countRegexMatches(sample, CODE_IDENTIFIER_RE, 20) +
    countRegexMatches(sample, FILE_OR_URL_RE, 15) +
    countRegexMatches(sample, NUMBER_DATE_UNIT_RE, 20) +
    countRegexMatches(sample, ERROR_MARKER_RE, 15) +
    countRegexMatches(sample, FIRST_PERSON_FACT_RE, 12);

  const signalRate = Math.min(1, concreteSignals / Math.max(3, sample.length / 110));
  const rawDensity =
    0.50 * uniqueContentRatio + 0.45 * signalRate - 0.35 * boilerplateListRatio + 0.08;
  const density = Math.max(0, Math.min(1, rawDensity));

  return {
    density,
    uniqueContentRatio,
    boilerplateListRatio,
  };
}

function clipCleanly(text: string, maxChars: number): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  if (maxChars <= 4) return safeUtf16Slice(clean, 0, Math.max(0, maxChars));

  const sliceBudget = maxChars - 3;
  const rough = safeUtf16Slice(clean, 0, sliceBudget);
  const lastSpace = rough.lastIndexOf(' ');
  const cut =
    lastSpace >= Math.floor(sliceBudget * 0.6)
      ? safeUtf16Slice(rough, 0, lastSpace).trimEnd()
      : rough;
  return `${cut}...`;
}

function samplePassagesDeterministically(
  passages: PassageSpan[],
  maxCount: number
): PassageSpan[] {
  if (passages.length <= maxCount) return passages;
  const headCount = Math.floor(maxCount * 0.25);
  const tailCount = Math.floor(maxCount * 0.25);
  const midCount = maxCount - headCount - tailCount;
  const sampled: PassageSpan[] = [];

  for (let i = 0; i < headCount; i++) {
    sampled.push(passages[i]);
  }

  const midSpan = passages.length - headCount - tailCount;
  const step = midSpan / midCount;
  for (let i = 0; i < midCount; i++) {
    sampled.push(passages[headCount + Math.floor(i * step)]);
  }

  for (let i = passages.length - tailCount; i < passages.length; i++) {
    sampled.push(passages[i]);
  }
  return sampled;
}

/**
 * Deterministic extractive text condenser:
 * - Strips pure conversational filler/boilerplate and bare horizontal rules
 * - Deduplicates near-identical passages (normalized token Jaccard >= 0.85)
 * - Preserves concise prompts (`<= 500` chars) 100% verbatim
 * - Compacts verbose outputs/responses into original-order high-signal passages
 */
export function condenseText(text: string, options?: CondenseTextOptions): string {
  if (!text || typeof text !== 'string') return '';
  const rawTrimmed = text.trim();
  if (!rawTrimmed) return '';

  const kind = options?.kind;
  const shortPromptCap = options?.preserveShortThreshold ?? 500;
  const maxChars = Math.max(40, options?.maxChars ?? 380);

  // Concise user prompts (<= 500 chars) preserve 100% of substantive text verbatim
  if (kind === 'prompt' && rawTrimmed.length <= shortPromptCap) {
    const nonRuleLines = rawTrimmed
      .split(/\r?\n/)
      .filter((line) => !isHorizontalRule(line.trim()));
    const joined = nonRuleLines.join('\n').trim();
    return joined || rawTrimmed;
  }

  // Bound input scanning on massive multi-KB dumps by keeping head + strided middle + tail
  let sourceForSplit = rawTrimmed;
  if (rawTrimmed.length > 20_000) {
    const head = safeUtf16Slice(rawTrimmed, 0, 7_000);
    const midStart = Math.floor(rawTrimmed.length / 2) - 3_000;
    const mid = safeUtf16Slice(rawTrimmed, midStart, midStart + 6_000);
    const tail = safeUtf16Slice(rawTrimmed, rawTrimmed.length - 7_000, rawTrimmed.length);
    sourceForSplit = `${head}\n${mid}\n${tail}`;
  }

  const allPassages = samplePassagesDeterministically(
    splitIntoPassages(sourceForSplit),
    MAX_CONDENSE_CANDIDATE_PASSAGES
  );
  if (allPassages.length === 0) return clipCleanly(rawTrimmed, maxChars);

  // Filter pure boilerplate & deduplicate near-identical passages (O(1) exact + bounded Jaccard window)
  const substantive: Array<{
    span: PassageSpan;
    tokens: Set<string>;
    normKey: string;
  }> = [];
  const seenNormKeys = new Set<string>();

  for (const span of allPassages) {
    if (isBoilerplatePassage(span.text)) continue;
    const tokArr = extractNormalizedTokens(span.text);
    const normKey = tokArr.join(' ');
    if (normKey && seenNormKeys.has(normKey)) {
      continue;
    }
    const tokSet = new Set(tokArr);

    let isDup = false;
    if (tokSet.size >= 3) {
      const winStart = Math.max(0, substantive.length - JACCARD_WINDOW_SIZE);
      for (let w = substantive.length - 1; w >= winStart; w--) {
        if (tokenSetJaccard(tokSet, substantive[w].tokens) >= 0.85) {
          isDup = true;
          break;
        }
      }
    }
    if (!isDup) {
      if (normKey) seenNormKeys.add(normKey);
      substantive.push({ span, tokens: tokSet, normKey });
    }
  }

  if (substantive.length === 0) {
    const compactSample = safeUtf16Slice(rawTrimmed, 0, Math.min(rawTrimmed.length, maxChars * 3));
    return clipCleanly(compactSample.replace(/\s+/g, ' '), maxChars);
  }

  // If already within budget after boilerplate removal + deduplication, keep all substantive spans
  const cleanedFull = substantive.map((s) => s.span.text).join(' ');
  if (cleanedFull.length <= maxChars) {
    return cleanedFull;
  }

  // Score each substantive passage and select highest-density passages within maxChars
  const scored = substantive.map((entry, idx) => ({
    idx,
    span: entry.span,
    score: scorePassageInformation(entry.span.text, idx, substantive.length),
  }));

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

  const chosen: typeof scored = [];
  let usedChars = 0;

  for (const cand of scored) {
    const sepChars = chosen.length > 0 ? 1 : 0;
    const needed = sepChars + cand.span.text.length;
    if (usedChars + needed <= maxChars) {
      chosen.push(cand);
      usedChars += needed;
    } else if (chosen.length === 0) {
      return clipCleanly(cand.span.text, maxChars);
    }
  }

  chosen.sort((a, b) => a.span.start - b.span.start);
  return chosen.map((c) => c.span.text).join(' ');
}

/**
 * Computes an additive, deterministic `condensed_text` representation for an observation
 * without mutating raw `input` or `output`.
 */
export function condenseObservation(obs: CondenseObservationInput): string | null {
  const kind = obs.kind || 'tool_call';
  const toolName = obs.toolName?.trim() || '';
  const filePath = obs.filePath?.trim() || '';
  const input = obs.input?.trim() || '';
  const output = obs.output?.trim() || '';

  if (!input && !output && !toolName && !filePath) {
    return null;
  }

  if (kind === 'prompt') {
    const combined = [input, output].filter(Boolean).join('\n').trim();
    if (!combined) return null;
    if (combined.length <= 500) {
      return condenseText(combined, { kind: 'prompt', preserveShortThreshold: 500 });
    }
    return condenseText(combined, {
      kind: 'prompt',
      maxChars: obs.maxChars ?? 450,
      preserveShortThreshold: 500,
    });
  }

  const maxChars = obs.maxChars ?? 380;

  if (kind === 'response') {
    const combined = [input, output].filter(Boolean).join('\n').trim();
    if (!combined) return null;
    return condenseText(combined, { kind: 'response', maxChars });
  }

  // kind === 'tool_call'
  const headerParts = [toolName, filePath].filter(Boolean);
  const header = headerParts.length > 0 ? `[${headerParts.join(' ')}]` : '';
  const remainingBudget = Math.max(80, maxChars - (header ? header.length + 1 : 0));

  let body = '';
  if (input && output) {
    const inBudget = Math.min(input.length, Math.max(80, Math.floor(remainingBudget * 0.4)));
    const condensedIn =
      input.length <= inBudget ? input : condenseText(input, { kind: 'tool_call', maxChars: inBudget });
    const outBudget = Math.max(60, remainingBudget - condensedIn.length - 4);
    const condensedOut =
      output.length <= outBudget
        ? output
        : condenseText(output, { kind: 'tool_call', maxChars: outBudget });
    body = `${condensedIn} -> ${condensedOut}`;
  } else if (input) {
    body =
      input.length <= remainingBudget
        ? input
        : condenseText(input, { kind: 'tool_call', maxChars: remainingBudget });
  } else if (output) {
    body =
      output.length <= remainingBudget
        ? output
        : condenseText(output, { kind: 'tool_call', maxChars: remainingBudget });
  }

  const assembled = [header, body].filter(Boolean).join(' ').trim();
  if (!assembled) return null;
  return assembled.length <= maxChars ? assembled : clipCleanly(assembled, maxChars);
}

export interface ParsedQuerySignals {
  contentTokens: string[];
  allTokens: string[];
  phrases: string[];
  specialLiterals: string[];
}

function lightStem(token: string): string {
  if (token.length < 5) return token;
  if (token.endsWith('ing') && token.length >= 6) return token.slice(0, -3);
  if (token.endsWith('tion') && token.length >= 7) return token.slice(0, -4);
  if (token.endsWith('ed') && token.length >= 5) return token.slice(0, -2);
  if (token.endsWith('es') && token.length >= 5) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && token.length >= 5) return token.slice(0, -1);
  return token;
}

/**
 * Extracts query content tokens (with stopword fallback), quoted phrases,
 * and technical/numeric literals for query-focused passage ranking.
 */
export function parseQuerySignals(query: string): ParsedQuerySignals {
  if (!query || typeof query !== 'string') {
    return { contentTokens: [], allTokens: [], phrases: [], specialLiterals: [] };
  }

  const bounded =
    query.length > MAX_QUERY_PARSE_CHARS ? safeUtf16Slice(query, 0, MAX_QUERY_PARSE_CHARS) : query;

  const phrases: string[] = [];
  const quoteRe = /"([^"\n]{2,120})"|'([^'\n]{2,120})'/g;
  let m: RegExpExecArray | null;
  while ((m = quoteRe.exec(bounded)) !== null && phrases.length < 16) {
    const p = (m[1] || m[2] || '').trim().toLowerCase();
    if (p.length >= 2) phrases.push(p);
  }

  const specialLiterals: string[] = [];
  const specialRe =
    /(?:(?<![a-zA-Z0-9_.-])[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+|\b[a-zA-Z0-9_-]+\.[a-zA-Z0-9]{1,8}\b|\bv?\d+(?:\.\d+)+\b|\b[a-z]+_[a-z0-9_]+\b|\b[a-z]+[A-Z][a-zA-Z0-9]*\b)/g;
  while ((m = specialRe.exec(bounded)) !== null && specialLiterals.length < 24) {
    const lit = m[0].toLowerCase();
    if (lit.length >= 2) specialLiterals.push(lit);
  }

  const rawTokens = extractNormalizedTokens(bounded);
  const allTokens = Array.from(new Set(rawTokens.filter(Boolean))).slice(0, 64);
  const nonStop = allTokens.filter((t) => !STOPWORDS.has(t));
  const contentTokens = nonStop.length > 0 ? nonStop : allTokens;

  return {
    contentTokens,
    allTokens,
    phrases: Array.from(new Set(phrases)),
    specialLiterals: Array.from(new Set(specialLiterals)),
  };
}

function windowAroundMatch(
  passageText: string,
  signals: ParsedQuerySignals,
  maxChars: number
): string {
  if (passageText.length <= maxChars) return passageText;
  const lower = passageText.toLowerCase();
  let matchIdx = -1;

  for (const phrase of signals.phrases) {
    const idx = lower.indexOf(phrase);
    if (idx !== -1) {
      matchIdx = idx;
      break;
    }
  }
  if (matchIdx === -1) {
    for (const tok of signals.contentTokens) {
      const idx = lower.indexOf(tok);
      if (idx !== -1) {
        matchIdx = idx;
        break;
      }
    }
  }

  if (matchIdx === -1) {
    return clipCleanly(passageText, maxChars);
  }

  const ellipsisFront = '[...] ';
  const ellipsisBack = ' [...]';
  const reserve = ellipsisFront.length + ellipsisBack.length;
  if (maxChars <= reserve + 16) {
    return clipCleanly(passageText, maxChars);
  }

  const innerBudget = maxChars - reserve;
  let winStart = Math.max(0, matchIdx - Math.floor(innerBudget * 0.35));
  let winEnd = Math.min(passageText.length, winStart + innerBudget);
  if (winEnd - winStart < innerBudget) {
    winStart = Math.max(0, winEnd - innerBudget);
  }

  winStart = alignUtf16Start(passageText, winStart);
  winEnd = alignUtf16End(passageText, winEnd, winStart);

  const needFront = winStart > 0;
  const needBack = winEnd < passageText.length;

  if (needFront) {
    const nextSpace = passageText.indexOf(' ', winStart);
    if (nextSpace !== -1 && nextSpace < matchIdx && nextSpace - winStart <= 20) {
      winStart = alignUtf16Start(passageText, nextSpace + 1);
    }
  }
  if (needBack) {
    const prevSpace = passageText.lastIndexOf(' ', winEnd);
    if (prevSpace !== -1 && prevSpace > matchIdx + 8 && winEnd - prevSpace <= 20) {
      winEnd = alignUtf16End(passageText, prevSpace, winStart);
    }
  }

  const core = passageText.slice(winStart, winEnd).trim();
  const rendered = `${needFront ? ellipsisFront : ''}${core}${needBack ? ellipsisBack : ''}`;
  return rendered.length <= maxChars ? rendered : safeUtf16Slice(rendered, 0, maxChars);
}

/**
 * Extracts a query-focused snippet from the full untruncated `text`.
 *
 * - Returns `text` unchanged when `!text` or `text.length <= maxChars`.
 * - Scores every passage across the full document (including tail offsets at 4KB–50KB+)
 *   by query content-token IDF coverage, phrase/identifier/number match bonuses,
 *   optional `preferredSpan` overlap, and intrinsic density tie-breaker.
 * - Falls back to `condenseText(text, { maxChars })` when zero passages match the query.
 * - Selects top 2–4 anchor spans (plus `±contextSentences` neighbors when budget allows),
 *   orders chronologically, joins non-adjacent spans with ` [...] `, and enforces `<= maxChars`.
 */
export function extractQueryFocusedSnippet(
  text: string,
  query: string,
  options?: QueryFocusedSnippetOptions
): string {
  const maxChars = Math.max(32, options?.maxChars ?? 600);
  if (!text || typeof text !== 'string') return '';
  if (text.length <= maxChars) return text;

  const contextSentences = Math.max(0, options?.contextSentences ?? 1);
  const preferredSpan = options?.preferredSpan;

  const passages = splitIntoPassages(text);
  if (passages.length === 0) {
    return clipCleanly(text, maxChars);
  }

  const signals = parseQuerySignals(query);
  const stems = signals.contentTokens.map(lightStem);
  const cleanFullQuery =
    query.length > MAX_QUERY_PARSE_CHARS
      ? safeUtf16Slice(query, 0, MAX_QUERY_PARSE_CHARS).trim().toLowerCase()
      : query.trim().toLowerCase();

  // Fast SIMD substring prefilter: only tokenize passages that actually contain a query stem/phrase/literal
  // or overlap preferredSpan (since `stem` is always a prefix of `qt`, `!lower.includes(stem)` implies 0 token/stem match).
  const searchNeedles = Array.from(
    new Set([...stems, ...signals.phrases, ...signals.specialLiterals].filter(Boolean))
  );

  const passageTokenSets: Array<Set<string> | null> = new Array(passages.length).fill(null);
  const passageStemSets: Array<Set<string> | null> = new Array(passages.length).fill(null);
  const passageLowers: string[] = new Array(passages.length);
  const candidatePassageIndices: number[] = [];
  const docFreq = new Map<string, number>();

  for (let i = 0; i < passages.length; i++) {
    const p = passages[i];
    const lower = p.text.toLowerCase();
    passageLowers[i] = lower;

    let maybeMatches =
      Boolean(preferredSpan && p.start < preferredSpan.end && p.end > preferredSpan.start) ||
      (cleanFullQuery.length >= 4 && lower.includes(cleanFullQuery));

    if (!maybeMatches) {
      for (let n = 0; n < searchNeedles.length; n++) {
        if (lower.includes(searchNeedles[n])) {
          maybeMatches = true;
          break;
        }
      }
    }

    if (!maybeMatches) continue;

    candidatePassageIndices.push(i);
    const toks = extractNormalizedTokens(lower);
    const tokSet = new Set(toks);
    const stemSet = new Set(toks.map(lightStem));
    passageTokenSets[i] = tokSet;
    passageStemSets[i] = stemSet;

    for (const qt of signals.contentTokens) {
      if (tokSet.has(qt)) {
        docFreq.set(qt, (docFreq.get(qt) ?? 0) + 1);
      }
    }
  }

  if (candidatePassageIndices.length === 0) {
    return condenseText(text, { maxChars });
  }

  // Score candidate passages
  const matchScores: number[] = new Array(passages.length).fill(0);
  let anyQueryMatch = false;

  for (const i of candidatePassageIndices) {
    const p = passages[i];
    const lower = passageLowers[i];
    const tokSet = passageTokenSets[i]!;
    const stemSet = passageStemSets[i]!;

    let qScore = 0;
    let matchedCount = 0;

    for (let tIdx = 0; tIdx < signals.contentTokens.length; tIdx++) {
      const qt = signals.contentTokens[tIdx];
      const stem = stems[tIdx];
      const df = docFreq.get(qt) ?? 0;
      const idf = Math.log(1 + passages.length / (1 + df));
      const specificity =
        1 +
        Math.min(qt.length, 12) / 6 +
        (/\d/.test(qt) ? 1.2 : 0) +
        (qt.includes('_') ? 0.8 : 0);

      if (tokSet.has(qt)) {
        qScore += specificity * (1 + idf);
        matchedCount++;
      } else if (qt.length >= 4 && lower.includes(qt)) {
        qScore += specificity * 0.75 * (1 + idf * 0.5);
        matchedCount += 0.7;
      } else if (stem.length >= 4 && stemSet.has(stem)) {
        qScore += specificity * 0.55;
        matchedCount += 0.5;
      }
    }

    // Coverage ratio bonus when multiple distinct query terms co-occur in one passage
    if (signals.contentTokens.length > 1 && matchedCount > 1) {
      const coverage = matchedCount / signals.contentTokens.length;
      qScore += coverage * 4.5;
    }

    // Consecutive query content-term bigram bonus
    for (let tIdx = 0; tIdx + 1 < signals.contentTokens.length; tIdx++) {
      const bigram = `${signals.contentTokens[tIdx]} ${signals.contentTokens[tIdx + 1]}`;
      if (lower.includes(bigram)) {
        qScore += 3.5;
      }
    }

    // Exact full query or quoted phrase bonus
    if (cleanFullQuery.length >= 4 && lower.includes(cleanFullQuery)) {
      qScore += 6.0;
    }
    for (const phrase of signals.phrases) {
      if (lower.includes(phrase)) {
        qScore += 5.5;
      }
    }

    // Exact path / version / snake_case / camelCase literal bonus
    for (const lit of signals.specialLiterals) {
      if (lower.includes(lit)) {
        qScore += 4.0;
      }
    }

    // Preferred span overlap bonus
    if (preferredSpan && p.start < preferredSpan.end && p.end > preferredSpan.start) {
      const overlap =
        Math.min(p.end, preferredSpan.end) - Math.max(p.start, preferredSpan.start);
      if (overlap > 0) {
        qScore += 5.0;
      }
    }

    if (qScore > 0) {
      anyQueryMatch = true;
      const densityTieBreaker =
        Math.min(2.5, scorePassageInformation(p.text, i, passages.length) * 0.2);
      const boilerplatePenalty = isBoilerplatePassage(p.text) ? 0.35 : 1.0;
      matchScores[i] = (qScore + densityTieBreaker) * boilerplatePenalty;
    }
  }

  if (!anyQueryMatch) {
    return condenseText(text, { maxChars });
  }

  // Rank matching passages
  const rankedIndices = passages
    .map((_, idx) => idx)
    .filter((idx) => matchScores[idx] > 0)
    .sort((a, b) => matchScores[b] - matchScores[a] || a - b);

  const JOINER = ' [...] ';
  const LEAD_ELLIPSIS = '[...] ';
  const TAIL_ELLIPSIS = ' [...]';

  const renderSelection = (indices: Set<number>): string => {
    const sorted = Array.from(indices).sort((a, b) => a - b);
    if (sorted.length === 0) return '';

    const parts: string[] = [];
    const startsAfterBeginning = passages[sorted[0]].start > 0;
    const endsBeforeFinish = passages[sorted[sorted.length - 1]].end < text.trimEnd().length;

    let hasInternalGap = false;
    for (let k = 0; k < sorted.length; k++) {
      if (k > 0) {
        const prevIdx = sorted[k - 1];
        const curIdx = sorted[k];
        if (curIdx > prevIdx + 1) {
          parts.push(JOINER);
          hasInternalGap = true;
        } else {
          parts.push(' ');
        }
      }
      parts.push(passages[sorted[k]].text);
    }

    let core = parts.join('');
    if (startsAfterBeginning && !hasInternalGap) {
      core = `${LEAD_ELLIPSIS}${core}`;
    } else if (startsAfterBeginning && core.length + LEAD_ELLIPSIS.length <= maxChars) {
      core = `${LEAD_ELLIPSIS}${core}`;
    }

    if (endsBeforeFinish && core.length + TAIL_ELLIPSIS.length <= maxChars && !core.endsWith('...')) {
      core = `${core}${TAIL_ELLIPSIS}`;
    }
    return core;
  };

  const selected = new Set<number>();
  const selectedTokenSets: Array<Set<string>> = [];

  // 1. Always admit the single highest-scoring anchor first
  const primaryIdx = rankedIndices[0];
  const primaryPassage = passages[primaryIdx];

  if (primaryPassage.text.length + LEAD_ELLIPSIS.length > maxChars) {
    return windowAroundMatch(primaryPassage.text, signals, maxChars);
  }

  selected.add(primaryIdx);
  selectedTokenSets.push(passageTokenSets[primaryIdx] ?? new Set());

  // 2. Select up to 3 additional distinct high-scoring anchor spans (2-4 total anchors)
  const maxAnchors = 4;
  let anchorCount = 1;
  for (let r = 1; r < rankedIndices.length && anchorCount < maxAnchors; r++) {
    const idx = rankedIndices[r];
    const candToks = passageTokenSets[idx] ?? new Set(extractNormalizedTokens(passageLowers[idx]));
    let nearDup = false;
    for (const existingSet of selectedTokenSets) {
      if (candToks.size >= 3 && tokenSetJaccard(candToks, existingSet) >= 0.85) {
        nearDup = true;
        break;
      }
    }
    if (nearDup) continue;

    const trial = new Set(selected);
    trial.add(idx);
    if (renderSelection(trial).length <= maxChars) {
      selected.add(idx);
      selectedTokenSets.push(candToks);
      anchorCount++;
    }
  }

  // 3. Expand ±contextSentences around top anchors when budget permits
  if (contextSentences > 0) {
    const anchorsInPriority = Array.from(selected).sort(
      (a, b) => matchScores[b] - matchScores[a] || a - b
    );
    for (let dist = 1; dist <= contextSentences; dist++) {
      for (const anchor of anchorsInPriority) {
        for (const neighbor of [anchor - dist, anchor + dist]) {
          if (neighbor < 0 || neighbor >= passages.length || selected.has(neighbor)) continue;
          if (isBoilerplatePassage(passages[neighbor].text)) continue;

          const trial = new Set(selected);
          trial.add(neighbor);
          if (renderSelection(trial).length <= maxChars) {
            selected.add(neighbor);
          }
        }
      }
    }
  }

  const finalSnippet = renderSelection(selected);
  if (finalSnippet.length <= maxChars) {
    return finalSnippet;
  }
  return windowAroundMatch(primaryPassage.text, signals, maxChars);
}
