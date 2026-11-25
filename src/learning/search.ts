import { getDb } from '../lib/db';
import {
  computeInformationDensity,
  condenseObservation,
  condenseText,
  extractQueryFocusedSnippet,
  parseQuerySignals,
  safeUtf16Slice,
  type ParsedQuerySignals,
} from '../lib/condenser';
import { logger } from '../lib/logger';
import { normalizeUtcIso } from '../lib/recurrence';
import { detectQuerySignalIntent } from '../lib/signalTags';
import {
  parseTemporalQueryWindow,
  resolveRelativeDates,
  type ParsedTemporalWindow,
  type ResolvedDateAnnotation,
} from '../lib/temporal';
import {
  buildHierarchicalScopeSql,
  classifyMatchTier,
  getProjectAncestors,
  getProjectChildRange,
  normalizeProjectId,
  type MatchTier,
} from '../lib/scope';
import { deserializeEmbedding, embedQuery, resolveEmbedderRecipe } from './embedding';
import { verifyOrCreateStoreMeta } from './storeMeta';
import { getQdrantClient } from './embedWorker';
import type {
  MemoryRecordType,
  ObservationSearchKind,
  SearchRequest,
  SearchResponse,
  SearchResultItem,
  SearchSummarySource,
  SnippetMode,
} from './types';

const DEFAULT_RAW_SAFETY_CAP_CHARS = 32_000;
const MAX_SOURCE_PREVIEW_CHARS = 160;
const MAX_ENTITY_SEEDS = 15;
const MIN_ENTITY_DENSE_SIM = 0.55;
const RRF_K = 60;

export type QueryKindIntent = 'assistant' | 'tool' | 'general';

const OBSERVATION_KINDS: readonly ObservationSearchKind[] = ['prompt', 'response', 'tool_call'];

const ASSISTANT_INTENT_RE =
  /\b(?:did\s{1,3}you|what\s{1,3}did\s{1,3}you|have\s{1,3}you\s{1,3}(?:suggest\w{0,10}|recommend\w{0,10}|said|mention\w{0,10}|told|given|advis\w{0,10}|explain\w{0,10}|list\w{0,10}|provid\w{0,10}|written|share\w{0,10}|shown)|you\s{1,3}(?:suggested|recommended|said|mentioned|told|gave|advised|explained|listed|provided|wrote|shared|showed)|your\s{1,3}(?:recipe|advice|recommendation\w{0,10}|suggestion\w{0,10}|list|explanation|answer|response|plan|outline|summary))\b/i;

const TOOL_FILE_OR_SYMBOL_RE =
  /(?:(?:^|[\s"'`(])(?:\.{0,2}\/)?[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+|\b[a-zA-Z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|py|rs|go|java|rb|php|sh|bash|zsh|yml|yaml|toml|sql|md|css|scss|html|lock|env|conf|ini|xml|c|cpp|h|hpp)\b|\b[a-z0-9]+_[a-z0-9_]+\b|\b[a-z]+[A-Z][a-zA-Z0-9]*\b)/;

const TOOL_ERROR_OR_CLI_RE =
  /\b(?:error|errors|failed|failure|exception|traceback|stack\s*trace|stderr|stdout|exit\s*code|command|enoent|econnrefused|eaddrinuse|eacces|etimedout|typeerror|referenceerror|syntaxerror|sqliteerror|npm|npx|jest|tsc|git|docker|kubectl|curl|grep|bash)\b/i;

const INTENT_DEFAULT_KIND_WEIGHTS: Record<
  QueryKindIntent,
  Record<ObservationSearchKind, number>
> = {
  assistant: { response: 1.20, prompt: 1.0, tool_call: 0.95 },
  tool: { tool_call: 1.18, prompt: 1.08, response: 0.95 },
  general: { prompt: 1.15, tool_call: 1.05, response: 0.90 },
};

export function detectQueryKindIntent(q: string, hasFileFilter = false): QueryKindIntent {
  const sample = typeof q === 'string' ? (q.length > 4_000 ? safeUtf16Slice(q, 0, 4_000) : q) : '';
  if (sample && ASSISTANT_INTENT_RE.test(sample)) {
    return 'assistant';
  }
  if (
    hasFileFilter ||
    (sample && (TOOL_FILE_OR_SYMBOL_RE.test(sample) || TOOL_ERROR_OR_CLI_RE.test(sample)))
  ) {
    return 'tool';
  }
  return 'general';
}

function resolveKindWeights(
  intent: QueryKindIntent,
  callerWeights?: Partial<Record<ObservationSearchKind, number>>
): Record<ObservationSearchKind, number> {
  const weights: Record<ObservationSearchKind, number> = {
    ...INTENT_DEFAULT_KIND_WEIGHTS[intent],
  };
  if (callerWeights && typeof callerWeights === 'object') {
    for (const k of OBSERVATION_KINDS) {
      if (Object.prototype.hasOwnProperty.call(callerWeights, k)) {
        const raw = callerWeights[k];
        if (typeof raw === 'number' && Number.isFinite(raw)) {
          weights[k] = Math.min(5.0, Math.max(0.1, raw));
        }
      }
    }
  }
  return weights;
}

function cleanOptionalString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function resolveMaxKindShare(
  params: SearchRequest,
  recordTypes: MemoryRecordType[],
  intent: QueryKindIntent,
  limit: number
): Partial<Record<ObservationSearchKind, number>> | null {
  if (params.max_kind_share !== undefined && params.max_kind_share !== null) {
    if (typeof params.max_kind_share === 'object' && !Array.isArray(params.max_kind_share)) {
      const ownKeys = Object.keys(params.max_kind_share);
      if (ownKeys.length === 0) {
        return null;
      }
      const explicit: Partial<Record<ObservationSearchKind, number>> = {};
      let hasAny = false;
      for (const k of OBSERVATION_KINDS) {
        if (Object.prototype.hasOwnProperty.call(params.max_kind_share, k)) {
          const raw = params.max_kind_share[k];
          if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
            explicit[k] = Math.min(1, raw);
            hasAny = true;
          }
        }
      }
      if (hasAny) {
        return explicit;
      }
    }
  }

  if (
    recordTypes.includes('observation') &&
    !cleanOptionalString(params.filters?.kind) &&
    intent !== 'assistant' &&
    limit >= 5
  ) {
    return { response: 0.6 };
  }
  return null;
}

function computeObservationDensityMultiplier(
  record: Record<string, any>,
  querySignals: ParsedQuerySignals
): number {
  const rawBody = [record.input, record.output].filter(Boolean).join('\n');
  if (rawBody.length <= 800) {
    return 1.0;
  }

  const lowerBody = rawBody.toLowerCase();
  let matchedTerms = 0;
  for (const tok of querySignals.contentTokens) {
    if (lowerBody.includes(tok)) {
      matchedTerms++;
    }
  }
  const coverage =
    querySignals.contentTokens.length > 0
      ? matchedTerms / querySignals.contentTokens.length
      : 0;

  if (coverage >= 0.5) {
    return 1.0;
  }

  const info = computeInformationDensity(rawBody);
  const lowUnique = Math.max(0, (0.45 - info.uniqueContentRatio) / 0.45);
  const highBoilerplate = Math.min(1, info.boilerplateListRatio / 0.55);
  const lowDensity = Math.max(0, (0.38 - info.density) / 0.38);
  const bloatSignal = Math.min(1, 0.45 * lowUnique + 0.35 * highBoilerplate + 0.20 * lowDensity);

  if (bloatSignal <= 0.05) {
    return 1.0;
  }

  const lenScale = 0.5 + 0.5 * Math.min(1, (rawBody.length - 800) / 3200);
  const covScale = 1 - coverage;
  const severity = Math.min(1, bloatSignal * lenScale * covScale * 1.25);
  return Math.max(0.82, Math.min(0.95, 0.95 - 0.13 * severity));
}

function hasAnyQueryTerm(text: string | null | undefined, signals: ParsedQuerySignals): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  for (const phrase of signals.phrases) {
    if (lower.includes(phrase)) return true;
  }
  for (const tok of signals.contentTokens) {
    if (lower.includes(tok)) return true;
  }
  return false;
}

function allocateFieldBudgets(
  inLen: number,
  outLen: number,
  inMatches: boolean,
  outMatches: boolean,
  totalCap: number
): [number, number] {
  if (inLen === 0) return [0, totalCap];
  if (outLen === 0) return [totalCap, 0];
  if (inLen + outLen <= totalCap) return [inLen, outLen];

  const quarter = Math.max(32, Math.floor(totalCap * 0.25));
  if (inLen <= quarter) {
    return [inLen, Math.max(32, totalCap - inLen)];
  }
  if (outLen <= quarter) {
    return [Math.max(32, totalCap - outLen), outLen];
  }

  if (outMatches && !inMatches) {
    const inShare = Math.max(36, Math.floor(totalCap * 0.22));
    return [inShare, Math.max(36, totalCap - inShare)];
  }
  if (inMatches && !outMatches) {
    const outShare = Math.max(36, Math.floor(totalCap * 0.22));
    return [Math.max(36, totalCap - outShare), outShare];
  }

  const inShare = Math.max(36, Math.floor(totalCap * 0.45));
  return [inShare, Math.max(36, totalCap - inShare)];
}

function capRawField(value: string | null | undefined, cap: number): string | null {
  if (value === null || value === undefined) return null;
  if (value.length <= cap) return value;
  if (cap <= 3) return safeUtf16Slice(value, 0, Math.max(0, cap));
  return `${safeUtf16Slice(value, 0, cap - 3)}...`;
}

function formatObservationResult(
  rawRecord: Record<string, any>,
  q: string,
  signals: ParsedQuerySignals,
  snippetMode: SnippetMode,
  explicitMaxChars?: number,
  parsedWindow?: ParsedTemporalWindow | null
): { record: Record<string, any>; snippet: string } {
  const obsKind = (rawRecord.kind as ObservationSearchKind) || 'tool_call';
  const rawInput: string | null = typeof rawRecord.input === 'string' ? rawRecord.input : null;
  const rawOutput: string | null = typeof rawRecord.output === 'string' ? rawRecord.output : null;

  const obsAnchor: string | number | null =
    typeof rawRecord.event_at === 'string' && rawRecord.event_at.trim() !== ''
      ? rawRecord.event_at
      : typeof rawRecord.created_at === 'number' && Number.isFinite(rawRecord.created_at)
        ? rawRecord.created_at
        : null;

  const annotatedInput =
    rawInput !== null && obsAnchor !== null
      ? resolveRelativeDates(rawInput, obsAnchor).annotatedText
      : rawInput;
  const annotatedOutput =
    rawOutput !== null && obsAnchor !== null
      ? resolveRelativeDates(rawOutput, obsAnchor).annotatedText
      : rawOutput;

  const toolPrefix = [rawRecord.tool_name, rawRecord.file_path].filter(Boolean).join(' ');
  const combinedAnnotated = [
    toolPrefix ? `[${toolPrefix}]` : '',
    annotatedInput || '',
    annotatedOutput || '',
  ]
    .filter(Boolean)
    .join('\n');

  const snippetQuery = parsedWindow
    ? `${q} ${new Date(parsedWindow.centerMs).toISOString().slice(0, 10)}`
    : q;

  const previewCap = explicitMaxChars ?? (obsKind === 'prompt' ? 1000 : 600);

  if (snippetMode === 'raw') {
    const rawCap = explicitMaxChars ?? DEFAULT_RAW_SAFETY_CAP_CHARS;
    const snippet = combinedAnnotated
      ? extractQueryFocusedSnippet(combinedAnnotated, snippetQuery, { maxChars: previewCap })
      : '';
    return {
      record: {
        ...rawRecord,
        input: capRawField(rawInput, rawCap),
        output: capRawField(rawOutput, rawCap),
      },
      snippet,
    };
  }

  if (snippetMode === 'condensed') {
    const maxChars = explicitMaxChars ?? 600;
    const storedOrComputed =
      (typeof rawRecord.condensed_text === 'string' && rawRecord.condensed_text.trim() !== ''
        ? rawRecord.condensed_text
        : condenseObservation({
            kind: obsKind,
            toolName: rawRecord.tool_name,
            filePath: rawRecord.file_path,
            input: annotatedInput,
            output: annotatedOutput,
            maxChars,
          })) || '';
    const snippet =
      storedOrComputed.length <= maxChars
        ? storedOrComputed
        : condenseText(storedOrComputed, { kind: obsKind, maxChars });

    const [inBudget, outBudget] = allocateFieldBudgets(
      annotatedInput?.length ?? 0,
      annotatedOutput?.length ?? 0,
      hasAnyQueryTerm(annotatedInput, signals),
      hasAnyQueryTerm(annotatedOutput, signals),
      maxChars
    );

    const formattedInput =
      annotatedInput === null
        ? null
        : annotatedInput.length <= inBudget && obsKind === 'prompt' && annotatedInput.length <= 500
          ? annotatedInput
          : condenseText(annotatedInput, { kind: obsKind, maxChars: Math.max(40, inBudget) });
    const formattedOutput =
      annotatedOutput === null
        ? null
        : annotatedOutput.length <= outBudget && obsKind === 'prompt' && annotatedOutput.length <= 500
          ? annotatedOutput
          : condenseText(annotatedOutput, { kind: obsKind, maxChars: Math.max(40, outBudget) });

    return {
      record: {
        ...rawRecord,
        input: formattedInput !== null ? capRawField(formattedInput, inBudget) : null,
        output: formattedOutput !== null ? capRawField(formattedOutput, outBudget) : null,
      },
      snippet: capRawField(snippet, maxChars) || '',
    };
  }

  // Default: 'query_focused'
  const maxChars = previewCap;
  const effectiveSignals = parsedWindow ? parseQuerySignals(snippetQuery) : signals;
  const [inBudget, outBudget] = allocateFieldBudgets(
    annotatedInput?.length ?? 0,
    annotatedOutput?.length ?? 0,
    hasAnyQueryTerm(annotatedInput, effectiveSignals),
    hasAnyQueryTerm(annotatedOutput, effectiveSignals),
    maxChars
  );

  const formattedInput =
    annotatedInput === null
      ? null
      : extractQueryFocusedSnippet(annotatedInput, snippetQuery, {
          maxChars: Math.max(32, inBudget),
        });
  const formattedOutput =
    annotatedOutput === null
      ? null
      : extractQueryFocusedSnippet(annotatedOutput, snippetQuery, {
          maxChars: Math.max(32, outBudget),
        });

  const snippet = combinedAnnotated
    ? extractQueryFocusedSnippet(combinedAnnotated, snippetQuery, { maxChars })
    : '';

  return {
    record: {
      ...rawRecord,
      input: formattedInput,
      output: formattedOutput,
    },
    snippet,
  };
}

const SEMANTIC_NOTE_TYPES = ['fact', 'architecture', 'preference'] as const;
const PROCEDURAL_NOTE_TYPES = ['workflow', 'pattern', 'lesson', 'bug'] as const;
const VALID_RECORD_TYPES = new Set<MemoryRecordType>([
  'note',
  'trajectory',
  'observation',
  'summary',
  'entity',
  'action',
]);

function docKey(recordType: string, id: string): string {
  return `${recordType}:${id}`;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function parseTimestampMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw * 1000;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
      ? `${trimmed.replace(' ', 'T')}Z`
      : trimmed;
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

const MAX_FTS_QUERY_CHARS = 4_000;
const MAX_FTS_TOKENS = 48;
const FTS_TOKEN_RE = /[\p{L}\p{N}_]+/gu;
const FTS_HAS_ALNUM_RE = /[\p{L}\p{N}]/u;
const FTS_DIGIT_OR_UNDERSCORE_RE = /[0-9_]/;
const FTS_INTERNAL_UPPER_RE = /\p{Ll}\p{Lu}|\p{Lu}{2,}/u;
const FTS_INITIAL_UPPER_RE = /^\p{Lu}/u;
const FTS_TRAILING_LETTER_RE = /\p{L}$/u;
const FTS_PURE_CJK_RE =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30fc\u3005]{2,}$/u;
const FTS_DOUBLE_QUOTED_RE = /"([^"\r\n]*)"/g;
const FTS_SINGLE_QUOTED_RE = /(?:^|[^\p{L}\p{N}_])'([^'\r\n]*)'(?=$|[^\p{L}\p{N}_])/gu;
const FTS_APOSTROPHE_CLITICS = new Set(['s', 't', 'm', 'd', 're', 've', 'll']);

const FTS_STOPWORDS = new Set([
  'i',
  'me',
  'my',
  'you',
  'your',
  'we',
  'our',
  'he',
  'him',
  'his',
  'she',
  'her',
  'hers',
  'they',
  'them',
  'their',
  'theirs',
  'the',
  'a',
  'an',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'from',
  'by',
  'about',
  'as',
  'into',
  'is',
  'am',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'can',
  'could',
  'will',
  'would',
  'should',
  'may',
  'might',
  'don',
  'doesn',
  'didn',
  'isn',
  'aren',
  'wasn',
  'weren',
  'hasn',
  'haven',
  'hadn',
  'won',
  'wouldn',
  'couldn',
  'shouldn',
  'mustn',
  'ain',
  'how',
  'what',
  'when',
  'where',
  'who',
  'which',
  'why',
  'many',
  'much',
  'some',
  'any',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'and',
  'or',
  'not',
  'but',
  'if',
  'so',
  'than',
  'then',
  'there',
  'here',
]);

const STRICT_QUERY_META_VERBS = new Set([
  'mention',
  'mentioned',
  'mentions',
  'say',
  'said',
  'tell',
  'told',
  'talk',
  'talked',
  'discuss',
  'discussed',
  'remember',
  'recall',
  'happen',
  'happened',
  'recommend',
  'recommended',
  'recommends',
  'suggest',
  'suggested',
  'suggestions',
]);

interface ScannedFtsToken {
  tok: string;
  firstIndex: number;
  hasDigitOrUnderscore: boolean;
  hasInternalUpper: boolean;
  isMidSentenceCap: boolean;
  isInitialCap: boolean;
}

function quoteFtsToken(tok: string): string {
  return `"${tok.replace(/"/g, '""')}"`;
}

function scoreFtsTokenSpecificity(info: ScannedFtsToken): number {
  let score = 0;
  if (info.hasDigitOrUnderscore) score += 5.0;
  if (info.hasInternalUpper) score += 4.0;
  else if (info.isMidSentenceCap) score += 3.5;
  else if (info.isInitialCap) score += 1.5;

  if (info.tok.length >= 4) {
    score += Math.min(info.tok.length, 16) * 0.35;
  } else if (info.tok.length === 3) {
    score += 0.3;
  } else {
    score -= 1.0;
  }
  return score;
}

function isApostropheClitic(text: string, matchIndex: number, lowerTok: string): boolean {
  if (!FTS_APOSTROPHE_CLITICS.has(lowerTok) || matchIndex < 2) return false;
  const quoteChar = text[matchIndex - 1];
  if (quoteChar !== "'" && quoteChar !== '\u2019' && quoteChar !== '\u2018') return false;
  const beforeQuote = text.slice(Math.max(0, matchIndex - 3), matchIndex - 1);
  return FTS_TRAILING_LETTER_RE.test(beforeQuote);
}

function scanBoundedFtsTokens(q: string): {
  sample: string;
  allTokens: ScannedFtsToken[];
  contentTokens: ScannedFtsToken[];
} {
  const sample = q.length > MAX_FTS_QUERY_CHARS ? safeUtf16Slice(q, 0, MAX_FTS_QUERY_CHARS) : q;
  const byTok = new Map<string, ScannedFtsToken>();
  const tokenRe = new RegExp(FTS_TOKEN_RE.source, 'gu');
  let match: RegExpExecArray | null;
  let ordinal = 0;

  while ((match = tokenRe.exec(sample)) !== null) {
    const surface = match[0];
    if (!FTS_HAS_ALNUM_RE.test(surface)) continue;
    const lower = surface.toLowerCase();
    if (isApostropheClitic(sample, match.index, lower)) continue;
    const isUpperStart = FTS_INITIAL_UPPER_RE.test(surface);
    const hasInternalUpper = FTS_INTERNAL_UPPER_RE.test(surface);
    const existing = byTok.get(lower);
    if (!existing) {
      byTok.set(lower, {
        tok: lower,
        firstIndex: ordinal,
        hasDigitOrUnderscore: FTS_DIGIT_OR_UNDERSCORE_RE.test(lower),
        hasInternalUpper,
        isMidSentenceCap: ordinal > 0 && isUpperStart,
        isInitialCap: ordinal === 0 && isUpperStart,
      });
    } else {
      if (hasInternalUpper) existing.hasInternalUpper = true;
      if (ordinal > 0 && isUpperStart) existing.isMidSentenceCap = true;
    }
    ordinal++;
  }

  const allTokens = Array.from(byTok.values());
  const contentTokens = allTokens.filter((t) => !FTS_STOPWORDS.has(t.tok));
  return { sample, allTokens, contentTokens };
}

/**
 * Safely convert an arbitrary user query string into a stopword-filtered FTS5 OR
 * expression. Bounds scan length to 4,000 chars and token count to <= 48 so huge
 * pasted stack traces run in linear O(N) time and never approach SQLite's
 * SQLITE_MAX_EXPR_DEPTH limit. Falls back to unfiltered tokens on pure-stopword queries.
 */
export function buildSafeFtsQuery(q: string): string | null {
  if (typeof q !== 'string') return null;
  const { allTokens, contentTokens } = scanBoundedFtsTokens(q);
  if (allTokens.length === 0) return null;

  const active = contentTokens.length > 0 ? contentTokens : allTokens;
  let selected: ScannedFtsToken[];
  if (active.length <= MAX_FTS_TOKENS) {
    selected = active;
  } else {
    selected = [...active]
      .sort((a, b) => {
        const diff = scoreFtsTokenSpecificity(b) - scoreFtsTokenSpecificity(a);
        return Math.abs(diff) > 1e-6 ? diff : a.firstIndex - b.firstIndex;
      })
      .slice(0, MAX_FTS_TOKENS)
      .sort((a, b) => a.firstIndex - b.firstIndex);
  }

  return selected
    .map((t) =>
      FTS_PURE_CJK_RE.test(t.tok) ? `${quoteFtsToken(t.tok)}*` : quoteFtsToken(t.tok)
    )
    .join(' OR ');
}

function extractQuotedPhraseClauses(
  sample: string
): { clauses: string[]; coveredTokens: Set<string> } {
  const clauses: string[] = [];
  const coveredTokens = new Set<string>();
  const seenClause = new Set<string>();

  const collectFromRegex = (re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sample)) !== null && clauses.length < 2) {
      const inner = m[1];
      if (inner.length < 3 || inner.length > 120) continue;
      const innerTokenRe = new RegExp(FTS_TOKEN_RE.source, 'gu');
      const phraseToks: string[] = [];
      const seenInPhrase = new Set<string>();
      let rawTokenCount = 0;
      let tokMatch: RegExpExecArray | null;
      while ((tokMatch = innerTokenRe.exec(inner)) !== null) {
        const raw = tokMatch[0];
        if (!FTS_HAS_ALNUM_RE.test(raw)) continue;
        const lower = raw.toLowerCase();
        if (isApostropheClitic(inner, tokMatch.index, lower)) continue;
        rawTokenCount++;
        if (FTS_STOPWORDS.has(lower) || seenInPhrase.has(lower)) continue;
        seenInPhrase.add(lower);
        phraseToks.push(lower);
        if (phraseToks.length > 4) break;
      }
      if (rawTokenCount < 2) continue;
      if (phraseToks.length >= 2 && phraseToks.length <= 4) {
        const clause = `NEAR(${phraseToks.map(quoteFtsToken).join(' ')}, 6)`;
        if (!seenClause.has(clause)) {
          seenClause.add(clause);
          clauses.push(clause);
          for (const pt of phraseToks) {
            coveredTokens.add(pt);
          }
        }
      }
    }
  };

  collectFromRegex(FTS_DOUBLE_QUOTED_RE);
  if (clauses.length < 2) {
    collectFromRegex(FTS_SINGLE_QUOTED_RE);
  }

  return { clauses, coveredTokens };
}

/**
 * Build a Tier-1 strict FTS5 query (`AND` over top specific content terms plus
 * `NEAR(..., 6)` on explicit quoted multi-word titles/phrases) when >= 2 content
 * tokens exist. Returns null for empty, pure-stopword, or single-token queries.
 */
export function buildStrictFtsQuery(q: string): string | null {
  if (typeof q !== 'string') return null;
  const { sample, contentTokens } = scanBoundedFtsTokens(q);
  if (contentTokens.length < 2) return null;

  const { clauses: nearClauses, coveredTokens } = extractQuotedPhraseClauses(sample);
  const remaining = contentTokens.filter((t) => !coveredTokens.has(t.tok));

  const withoutMeta = remaining.filter((t) => !STRICT_QUERY_META_VERBS.has(t.tok));
  const pool =
    coveredTokens.size + withoutMeta.length >= 2 ? withoutMeta : remaining;

  const maxTotalClauses = contentTokens.length > 5 && nearClauses.length === 0 ? 3 : 4;
  const slotsLeft = Math.max(0, maxTotalClauses - nearClauses.length);

  let chosenTerms: ScannedFtsToken[] = [];
  if (slotsLeft > 0 && pool.length > 0) {
    if (pool.length <= slotsLeft) {
      chosenTerms = pool;
    } else {
      chosenTerms = [...pool]
        .sort((a, b) => {
          const diff = scoreFtsTokenSpecificity(b) - scoreFtsTokenSpecificity(a);
          return Math.abs(diff) > 1e-6 ? diff : a.firstIndex - b.firstIndex;
        })
        .slice(0, slotsLeft)
        .sort((a, b) => a.firstIndex - b.firstIndex);
    }
  }

  const allClauses = [
    ...nearClauses,
    ...chosenTerms.map((t) => quoteFtsToken(t.tok)),
  ];
  if (allClauses.length === 0) return null;
  if (nearClauses.length === 0 && chosenTerms.length < 2) return null;

  return allClauses.join(' AND ');
}

function resolveEffectiveNoteTypes(params: SearchRequest): string[] | null {
  const layer = params.filters?.memory_layer;
  const rawTypeParam = params.filters?.type;
  const rawTypes = Array.isArray(rawTypeParam)
    ? rawTypeParam.map(cleanOptionalString).filter((t): t is string => t !== null)
    : undefined;

  let layerSet: Set<string> | null = null;
  if (layer === 'semantic') {
    layerSet = new Set(SEMANTIC_NOTE_TYPES);
  } else if (layer === 'procedural') {
    layerSet = new Set(PROCEDURAL_NOTE_TYPES);
  }

  if (layerSet && rawTypes && rawTypes.length > 0) {
    return rawTypes.filter((t) => layerSet!.has(t));
  }
  if (layerSet) {
    return Array.from(layerSet);
  }
  if (rawTypes && rawTypes.length > 0) {
    return rawTypes;
  }
  return null;
}

export function buildQdrantFilter(
  params: SearchRequest,
  recordTypes: string[],
  includeGlobal: boolean,
  childProjectIds?: string[]
): Record<string, any> | undefined {
  const must: any[] = [];

  if (recordTypes.length === 1) {
    must.push({ key: 'record_type', match: { value: recordTypes[0] } });
  } else if (recordTypes.length > 1) {
    must.push({ key: 'record_type', match: { any: recordTypes } });
  }

  const cleanProjectId = cleanOptionalString(params.project_id) ?? '';

  if (params.scope === 'unknown') {
    must.push({ key: 'scope', match: { value: 'unknown' } });
  } else if (params.scope === 'global' || !cleanProjectId) {
    must.push({ key: 'scope', match: { value: 'global' } });
  } else {
    const normRes = normalizeProjectId(cleanProjectId);
    const norm = normRes.ok ? normRes.projectId : cleanProjectId;
    const includeAncestors = params.include_ancestors !== false;
    const includeChildren = params.include_children === true;
    const targetIds = includeAncestors ? getProjectAncestors(norm) : [norm];

    const ancestorMatch =
      targetIds.length === 1
        ? { key: 'project_id', match: { value: targetIds[0] } }
        : { key: 'project_id', match: { any: targetIds } };

    const projectMust: any[] = [{ key: 'scope', match: { value: 'project' } }];
    if (includeChildren) {
      const childShould: any[] = [
        ancestorMatch,
        { key: 'project_ancestors', match: { value: norm } },
      ];
      if (childProjectIds && childProjectIds.length > 0) {
        childShould.push(
          childProjectIds.length === 1
            ? { key: 'project_id', match: { value: childProjectIds[0] } }
            : { key: 'project_id', match: { any: childProjectIds } }
        );
      }
      projectMust.push({ should: childShould });
    } else {
      projectMust.push(ancestorMatch);
    }

    if (includeGlobal) {
      must.push({
        should: [
          { must: projectMust },
          { key: 'scope', match: { value: 'global' } },
        ],
      });
    } else {
      must.push(...projectMust);
    }
  }

  const userId = cleanOptionalString(params.user_id) ?? cleanOptionalString(params.filters?.user_id);
  if (userId) {
    must.push({ key: 'user_id', match: { value: userId } });
  }

  const entityType = cleanOptionalString(params.filters?.entity_type);
  if (entityType) {
    must.push({ key: 'entity_type', match: { value: entityType } });
  }

  const cleanFilterTypes = Array.isArray(params.filters?.type)
    ? params.filters.type.map(cleanOptionalString).filter((t): t is string => t !== null)
    : [];
  const effectiveNoteTypes = resolveEffectiveNoteTypes(params);
  if (cleanFilterTypes.length > 0) {
    const typesToFilter =
      params.filters?.memory_layer && effectiveNoteTypes ? effectiveNoteTypes : cleanFilterTypes;
    if (typesToFilter.length === 0) {
      must.push({ key: 'type', match: { value: '__none__' } });
    } else {
      must.push(
        typesToFilter.length === 1
          ? { key: 'type', match: { value: typesToFilter[0] } }
          : { key: 'type', match: { any: typesToFilter } }
      );
    }
  } else if (params.filters?.memory_layer && effectiveNoteTypes && recordTypes.length === 1 && recordTypes[0] === 'note') {
    must.push(
      effectiveNoteTypes.length === 1
        ? { key: 'type', match: { value: effectiveNoteTypes[0] } }
        : { key: 'type', match: { any: effectiveNoteTypes } }
    );
  }

  const kind = cleanOptionalString(params.filters?.kind);
  if (kind) {
    must.push({ key: 'kind', match: { value: kind } });
  }
  const taskType = cleanOptionalString(params.filters?.task_type);
  if (taskType) {
    must.push({ key: 'task_type', match: { value: taskType } });
  }
  const filePath = cleanOptionalString(params.filters?.file_path);
  if (filePath) {
    must.push({ key: 'file_path', match: { value: filePath } });
  }
  const agent = cleanOptionalString(params.filters?.agent);
  if (agent) {
    must.push({ key: 'agent', match: { value: agent } });
  }
  if (params.filters?.success !== undefined) {
    must.push({ key: 'success', match: { value: !!params.filters.success } });
  }
  const noteRef = cleanOptionalString(params.filters?.note_ref);
  if (noteRef) {
    must.push({ key: 'note_ref', match: { value: noteRef } });
  }
  const taskRef = cleanOptionalString(params.filters?.task_ref);
  if (taskRef) {
    must.push({ key: 'task_ref', match: { value: taskRef } });
  }
  const sessionId = cleanOptionalString((params.filters as any)?.session_id);
  if (sessionId) {
    must.push({ key: 'session_id', match: { value: sessionId } });
  }

  if (must.length === 0) return undefined;
  return { must };
}

interface CandidateDoc {
  id: string;
  record_type: MemoryRecordType;
  record: Record<string, any>;
  text: string;
  embedding: Buffer | null;
  claims?: Array<{ id: string; summary_id: string; text: string; ordinal: number }>;
  bm25Score?: number;
  denseScore?: number;
  entityLinkScore?: number;
  temporalRecallScore?: number;
  matchedEntities?: string[];
  matchTier?: MatchTier;
  rrfScore?: number;
}

interface FilterContext {
  params: SearchRequest;
  queryIntent: QueryKindIntent;
  includeGlobal: boolean;
  includeAncestors: boolean;
  includeChildren: boolean;
  userId: string | null;
  afterIso: string | null;
  beforeIso: string | null;
  asOfIso: string | null;
}

interface SqlConditionsResult {
  impossible?: boolean;
  conditions: string[];
  queryParams: unknown[];
}

interface RecordTypeSpec {
  table: string;
  alias: string;
  ftsTable: string;
  hasEmbedding: boolean;
  scanOrderCol: string;
  temporalExpr: (alias: string) => string;
  buildExtraConditions: (ctx: FilterContext) => SqlConditionsResult;
  hydrate: (db: ReturnType<typeof getDb>, rows: any[]) => CandidateDoc[];
}

function hydrateNotes(db: ReturnType<typeof getDb>, rows: any[]): CandidateDoc[] {
  if (rows.length === 0) return [];
  const noteIds = rows.map((r) => r.id);
  const placeholders = noteIds.map(() => '?').join(',');

  const allConcepts = db
    .prepare(`SELECT note_id, concept FROM note_concepts WHERE note_id IN (${placeholders})`)
    .all(...noteIds) as Array<{ note_id: string; concept: string }>;
  const conceptsByNoteId = new Map<string, string[]>();
  for (const row of allConcepts) {
    let list = conceptsByNoteId.get(row.note_id);
    if (!list) {
      list = [];
      conceptsByNoteId.set(row.note_id, list);
    }
    list.push(row.concept);
  }

  const allFiles = db
    .prepare(`SELECT note_id, file_path FROM note_files WHERE note_id IN (${placeholders})`)
    .all(...noteIds) as Array<{ note_id: string; file_path: string }>;
  const filesByNoteId = new Map<string, string[]>();
  for (const row of allFiles) {
    let list = filesByNoteId.get(row.note_id);
    if (!list) {
      list = [];
      filesByNoteId.set(row.note_id, list);
    }
    list.push(row.file_path);
  }

  return rows.map((row) => {
    const concepts = conceptsByNoteId.get(row.id) || [];
    const files = filesByNoteId.get(row.id) || [];
    const { embedding, fts_bm25, ...rowWithoutEmbedding } = row;
    const record = { ...rowWithoutEmbedding, concepts, files };
    const text = `${row.title}\n\n${row.content}\n${concepts.join(' ')}\n${files.join(' ')}`;
    return {
      id: row.id,
      record_type: 'note' as const,
      record,
      text,
      embedding: embedding ?? null,
      ...(typeof fts_bm25 === 'number' ? { bm25Score: Math.max(fts_bm25, 1e-6) } : {}),
    };
  });
}

function hydrateSummaries(db: ReturnType<typeof getDb>, rows: any[]): CandidateDoc[] {
  if (rows.length === 0) return [];
  const summaryIds = rows.map((r) => r.id);
  const placeholders = summaryIds.map(() => '?').join(',');

  const allClaims = db
    .prepare(
      `SELECT id, summary_id, text, ordinal FROM summary_claims WHERE summary_id IN (${placeholders}) ORDER BY ordinal ASC`
    )
    .all(...summaryIds) as Array<{ id: string; summary_id: string; text: string; ordinal: number }>;
  const claimsBySummaryId = new Map<string, typeof allClaims>();
  for (const c of allClaims) {
    let list = claimsBySummaryId.get(c.summary_id);
    if (!list) {
      list = [];
      claimsBySummaryId.set(c.summary_id, list);
    }
    list.push(c);
  }

  return rows.map((row) => {
    const claims = claimsBySummaryId.get(row.id) || [];
    const { embedding, fts_bm25, ...rowWithoutEmbedding } = row;
    const text = claims.map((c) => c.text).join('\n');
    return {
      id: row.id,
      record_type: 'summary' as const,
      record: rowWithoutEmbedding,
      text,
      embedding: embedding ?? null,
      claims,
      ...(typeof fts_bm25 === 'number' ? { bm25Score: Math.max(fts_bm25, 1e-6) } : {}),
    };
  });
}

const RECORD_SPECS: Record<MemoryRecordType, RecordTypeSpec> = {
  note: {
    table: 'notes',
    alias: 'n',
    ftsTable: 'fts_notes',
    hasEmbedding: true,
    scanOrderCol: 'n.updated_at',
    temporalExpr: (a) => `COALESCE(${a}.event_at, strftime('%Y-%m-%dT%H:%M:%fZ', ${a}.created_at, 'unixepoch'))`,
    buildExtraConditions: ({ params, asOfIso }) => {
      const conditions: string[] = [];
      const queryParams: unknown[] = [];
      if (params.include_history !== true) {
        conditions.push('n.is_latest = 1');
      }
      if (asOfIso) {
        conditions.push('(n.valid_from IS NULL OR n.valid_from <= ?) AND (n.valid_until IS NULL OR n.valid_until >= ?)');
        queryParams.push(asOfIso, asOfIso);
      }
      const effectiveTypes = resolveEffectiveNoteTypes(params);
      if (effectiveTypes !== null) {
        if (effectiveTypes.length === 0) {
          return { impossible: true, conditions, queryParams };
        }
        conditions.push(`n.type IN (${effectiveTypes.map(() => '?').join(',')})`);
        queryParams.push(...effectiveTypes);
      }
      const filePath = cleanOptionalString(params.filters?.file_path);
      if (filePath) {
        conditions.push('EXISTS (SELECT 1 FROM note_files nf WHERE nf.note_id = n.id AND nf.file_path = ?)');
        queryParams.push(filePath);
      }
      const agent = cleanOptionalString(params.filters?.agent);
      if (agent) {
        conditions.push('n.author = ?');
        queryParams.push(agent);
      }
      return { conditions, queryParams };
    },
    hydrate: hydrateNotes,
  },

  trajectory: {
    table: 'trajectories',
    alias: 't',
    ftsTable: 'fts_trajectories',
    hasEmbedding: true,
    scanOrderCol: 't.created_at',
    temporalExpr: (a) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${a}.created_at, 'unixepoch')`,
    buildExtraConditions: ({ params }) => {
      const conditions: string[] = [];
      const queryParams: unknown[] = [];
      const taskType = cleanOptionalString(params.filters?.task_type);
      if (taskType) {
        conditions.push('t.task_type = ?');
        queryParams.push(taskType);
      }
      const agent = cleanOptionalString(params.filters?.agent);
      if (agent) {
        conditions.push('t.agent = ?');
        queryParams.push(agent);
      }
      if (params.filters?.success !== undefined) {
        conditions.push('t.success = ?');
        queryParams.push(params.filters.success ? 1 : 0);
      }
      const noteRef = cleanOptionalString(params.filters?.note_ref);
      if (noteRef) {
        conditions.push('t.note_ref = ?');
        queryParams.push(noteRef);
      }
      const taskRef = cleanOptionalString(params.filters?.task_ref);
      if (taskRef) {
        conditions.push('t.task_ref = ?');
        queryParams.push(taskRef);
      }
      const sessionId = cleanOptionalString((params.filters as any)?.session_id);
      if (sessionId) {
        conditions.push('t.session_id = ?');
        queryParams.push(sessionId);
      }
      return { conditions, queryParams };
    },
    hydrate: (_db, rows) =>
      rows.map((row) => {
        const { embedding, fts_bm25, ...record } = row;
        const text = `${row.description || ''}\n${row.result || ''}\n${row.task_type || ''}`;
        return {
          id: row.id,
          record_type: 'trajectory' as const,
          record,
          text,
          embedding: embedding ?? null,
          ...(typeof fts_bm25 === 'number' ? { bm25Score: Math.max(fts_bm25, 1e-6) } : {}),
        };
      }),
  },

  observation: {
    table: 'observations',
    alias: 'o',
    ftsTable: 'fts_observations',
    hasEmbedding: false,
    scanOrderCol: 'o.created_at',
    temporalExpr: (a) => `COALESCE(${a}.event_at, strftime('%Y-%m-%dT%H:%M:%fZ', ${a}.created_at, 'unixepoch'))`,
    buildExtraConditions: ({ params }) => {
      const conditions: string[] = [];
      const queryParams: unknown[] = [];
      const kind = cleanOptionalString(params.filters?.kind);
      if (kind) {
        conditions.push('o.kind = ?');
        queryParams.push(kind);
      }
      const filePath = cleanOptionalString(params.filters?.file_path);
      if (filePath) {
        conditions.push('o.file_path = ?');
        queryParams.push(filePath);
      }
      const agent = cleanOptionalString(params.filters?.agent);
      if (agent) {
        conditions.push('o.agent = ?');
        queryParams.push(agent);
      }
      if (params.filters?.success !== undefined) {
        conditions.push('o.failed = ?');
        queryParams.push(params.filters.success ? 0 : 1);
      }
      const noteRef = cleanOptionalString(params.filters?.note_ref);
      if (noteRef) {
        conditions.push('o.note_ref = ?');
        queryParams.push(noteRef);
      }
      const taskRef = cleanOptionalString(params.filters?.task_ref);
      if (taskRef) {
        conditions.push('o.task_ref = ?');
        queryParams.push(taskRef);
      }
      const sessionId = cleanOptionalString((params.filters as any)?.session_id);
      if (sessionId) {
        conditions.push('o.session_id = ?');
        queryParams.push(sessionId);
      }
      const signalTag = cleanOptionalString(params.filters?.signal_tag);
      if (signalTag) {
        conditions.push(
          "o.signal_tags IS NOT NULL AND json_valid(o.signal_tags) = 1 AND json_type(o.signal_tags) = 'array' AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(o.signal_tags) = 1 AND json_type(o.signal_tags) = 'array' THEN o.signal_tags ELSE '[]' END) je WHERE je.type = 'text' AND je.value = ?)"
        );
        queryParams.push(signalTag);
      }
      return { conditions, queryParams };
    },
    hydrate: (_db, rows) =>
      rows.map((row) => {
        const { fts_bm25, ...record } = row;
        const text = `${row.tool_name || ''}\n${row.file_path || ''}\n${row.input || ''}\n${row.output || ''}\n${row.condensed_text || ''}`;
        return {
          id: row.id,
          record_type: 'observation' as const,
          record,
          text,
          embedding: null,
          ...(typeof fts_bm25 === 'number' ? { bm25Score: Math.max(fts_bm25, 1e-6) } : {}),
        };
      }),
  },

  summary: {
    table: 'summaries',
    alias: 's',
    ftsTable: 'fts_summaries',
    hasEmbedding: true,
    scanOrderCol: 's.created_at',
    temporalExpr: (a) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${a}.created_at, 'unixepoch')`,
    buildExtraConditions: ({ params }) => {
      const conditions: string[] = [];
      const queryParams: unknown[] = [];
      if (params.include_history !== true) {
        conditions.push('s.is_latest = 1');
      }
      const kind = cleanOptionalString(params.filters?.kind);
      if (kind) {
        conditions.push('s.kind = ?');
        queryParams.push(kind);
      }
      const agent = cleanOptionalString(params.filters?.agent);
      if (agent) {
        conditions.push('(s.producer_model = ? OR s.producer_tier = ?)');
        queryParams.push(agent, agent);
      }
      if (params.filters?.success !== undefined) {
        conditions.push('s.outcome = ?');
        queryParams.push(params.filters.success ? 'success' : 'failure');
      }
      return { conditions, queryParams };
    },
    hydrate: hydrateSummaries,
  },

  entity: {
    table: 'entities',
    alias: 'e',
    ftsTable: 'fts_entities',
    hasEmbedding: true,
    scanOrderCol: 'e.updated_at',
    temporalExpr: (a) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${a}.created_at, 'unixepoch')`,
    buildExtraConditions: ({ params }) => {
      const conditions: string[] = [];
      const queryParams: unknown[] = [];
      const entityType = cleanOptionalString(params.filters?.entity_type);
      if (entityType) {
        conditions.push('e.entity_type = ?');
        queryParams.push(entityType);
      }
      return { conditions, queryParams };
    },
    hydrate: (_db, rows) =>
      rows.map((row) => {
        const { embedding, fts_bm25, ...record } = row;
        const text = [row.entity_type, row.name, row.description, row.external_ref]
          .filter(Boolean)
          .join('\n');
        return {
          id: row.id,
          record_type: 'entity' as const,
          record,
          text,
          embedding: embedding ?? null,
          ...(typeof fts_bm25 === 'number' ? { bm25Score: Math.max(fts_bm25, 1e-6) } : {}),
        };
      }),
  },

  action: {
    table: 'actions',
    alias: 'a',
    ftsTable: 'fts_actions',
    hasEmbedding: true,
    scanOrderCol: 'a.created_at',
    temporalExpr: (al) => `COALESCE(${al}.due_at, strftime('%Y-%m-%dT%H:%M:%fZ', ${al}.created_at))`,
    buildExtraConditions: ({ params }) => {
      const conditions: string[] = [];
      const queryParams: unknown[] = [];
      const kind = cleanOptionalString(params.filters?.kind);
      if (kind) {
        conditions.push('a.status = ?');
        queryParams.push(kind);
      }
      const cleanPriorities = Array.isArray(params.filters?.type)
        ? params.filters.type.map(cleanOptionalString).filter((t): t is string => t !== null)
        : [];
      if (cleanPriorities.length > 0) {
        conditions.push(`a.priority IN (${cleanPriorities.map(() => '?').join(',')})`);
        queryParams.push(...cleanPriorities);
      }
      const sessionId = cleanOptionalString((params.filters as any)?.session_id);
      if (sessionId) {
        conditions.push('a.session_id = ?');
        queryParams.push(sessionId);
      }
      return { conditions, queryParams };
    },
    hydrate: (_db, rows) =>
      rows.map((row) => {
        const { embedding, fts_bm25, ...record } = row;
        const text = [row.title, row.description, row.blocked_reason].filter(Boolean).join('\n');
        return {
          id: row.id,
          record_type: 'action' as const,
          record,
          text,
          embedding: embedding ?? null,
          ...(typeof fts_bm25 === 'number' ? { bm25Score: Math.max(fts_bm25, 1e-6) } : {}),
        };
      }),
  },
};

function buildWhereForType(
  spec: RecordTypeSpec,
  ctx: FilterContext
): SqlConditionsResult {
  const scopeSql = buildHierarchicalScopeSql({
    tableAlias: spec.alias,
    scope: ctx.params.scope,
    projectId: cleanOptionalString(ctx.params.project_id),
    includeAncestors: ctx.includeAncestors,
    includeChildren: ctx.includeChildren,
    includeGlobal: ctx.includeGlobal,
    userId: ctx.userId,
  });

  const conditions: string[] = [scopeSql.clause];
  const queryParams: unknown[] = [...scopeSql.params];

  if (ctx.afterIso) {
    conditions.push(`${spec.temporalExpr(spec.alias)} >= ?`);
    queryParams.push(ctx.afterIso);
  }
  if (ctx.beforeIso) {
    conditions.push(`${spec.temporalExpr(spec.alias)} <= ?`);
    queryParams.push(ctx.beforeIso);
  }

  const extra = spec.buildExtraConditions(ctx);
  if (extra.impossible) {
    return { impossible: true, conditions, queryParams };
  }
  conditions.push(...extra.conditions);
  queryParams.push(...extra.queryParams);

  return { conditions, queryParams };
}

function getBm25Expr(recordType: MemoryRecordType, queryIntent: QueryKindIntent): string {
  switch (recordType) {
    case 'observation':
      if (queryIntent === 'assistant') {
        return '-bm25(fts_observations, 0.0, 1.2, 1.2, 1.0, 1.4, 1.6)';
      }
      if (queryIntent === 'tool') {
        return '-bm25(fts_observations, 0.0, 2.0, 2.2, 1.4, 1.0, 1.5)';
      }
      return '-bm25(fts_observations, 0.0, 1.5, 1.6, 1.6, 0.75, 1.8)';
    case 'note':
      return '-bm25(fts_notes, 0.0, 2.2, 1.0, 1.6)';
    case 'trajectory':
      return '-bm25(fts_trajectories, 0.0, 1.6, 1.0, 1.4)';
    case 'summary':
      return '-bm25(fts_summaries, 0.0, 1.0)';
    case 'entity':
      return '-bm25(fts_entities, 0.0, 2.5, 1.4, 1.0, 1.8)';
    case 'action':
      return '-bm25(fts_actions, 0.0, 2.0, 1.0, 1.2)';
  }
}

function queryTypeFts(
  db: ReturnType<typeof getDb>,
  recordType: MemoryRecordType,
  ctx: FilterContext,
  safeFtsQuery: string,
  strictFtsQuery: string | null,
  ftsLimit: number
): CandidateDoc[] {
  const spec = RECORD_SPECS[recordType];
  if (!spec) return [];
  const built = buildWhereForType(spec, ctx);
  if (built.impossible) return [];

  const bm25Expr = getBm25Expr(recordType, ctx.queryIntent);
  const sql = `
    SELECT ${spec.alias}.*, ${bm25Expr} AS fts_bm25
    FROM ${spec.ftsTable}
    JOIN ${spec.table} ${spec.alias} ON ${spec.alias}.id = ${spec.ftsTable}.record_id
    WHERE ${spec.ftsTable} MATCH ? AND ${built.conditions.join(' AND ')}
    ORDER BY fts_bm25 DESC
    LIMIT ?
  `;
  const stmt = db.prepare(sql);
  const relaxedRows = stmt.all(safeFtsQuery, ...built.queryParams, ftsLimit) as any[];

  if (!strictFtsQuery) {
    return spec.hydrate(db, relaxedRows);
  }

  const strictLimit = Math.min(ftsLimit, 100);
  const strictRows = stmt.all(strictFtsQuery, ...built.queryParams, strictLimit) as any[];
  if (strictRows.length === 0) {
    return spec.hydrate(db, relaxedRows);
  }

  const mergedById = new Map<string, any>();
  for (const r of relaxedRows) {
    mergedById.set(r.id, r);
  }

  for (const sRow of strictRows) {
    const strictBm25 = Math.max(Number(sRow.fts_bm25) || 0, 1e-6);
    const existing = mergedById.get(sRow.id);
    if (existing) {
      const relaxedBm25 = Math.max(Number(existing.fts_bm25) || 0, 1e-6);
      existing.fts_bm25 = Math.max(strictBm25 * 1.6, relaxedBm25 * 1.35);
    } else {
      mergedById.set(sRow.id, {
        ...sRow,
        fts_bm25: strictBm25 * 1.6,
      });
    }
  }

  const mergedRows = Array.from(mergedById.values())
    .sort((a, b) => (Number(b.fts_bm25) || 0) - (Number(a.fts_bm25) || 0))
    .slice(0, ftsLimit);

  return spec.hydrate(db, mergedRows);
}

function queryTypeEmbeddedScan(
  db: ReturnType<typeof getDb>,
  recordType: MemoryRecordType,
  ctx: FilterContext,
  scanLimit = 500
): CandidateDoc[] {
  const spec = RECORD_SPECS[recordType];
  if (!spec || !spec.hasEmbedding) return [];
  const built = buildWhereForType(spec, ctx);
  if (built.impossible) return [];

  const sql = `
    SELECT ${spec.alias}.*
    FROM ${spec.table} ${spec.alias}
    WHERE ${spec.alias}.embedding IS NOT NULL AND ${built.conditions.join(' AND ')}
    ORDER BY ${spec.scanOrderCol} DESC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...built.queryParams, scanLimit) as any[];
  return spec.hydrate(db, rows);
}

function queryTypeByIds(
  db: ReturnType<typeof getDb>,
  recordType: MemoryRecordType,
  ctx: FilterContext,
  ids: string[]
): CandidateDoc[] {
  if (ids.length === 0) return [];
  const spec = RECORD_SPECS[recordType];
  if (!spec) return [];
  const built = buildWhereForType(spec, ctx);
  if (built.impossible) return [];

  const placeholders = ids.map(() => '?').join(',');
  const sql = `
    SELECT ${spec.alias}.*
    FROM ${spec.table} ${spec.alias}
    WHERE ${built.conditions.join(' AND ')} AND ${spec.alias}.id IN (${placeholders})
  `;
  const rows = db.prepare(sql).all(...built.queryParams, ...ids) as any[];
  return spec.hydrate(db, rows);
}

function assignCompetitionRanks<T>(
  items: T[],
  getKey: (item: T) => string,
  getScore: (item: T) => number
): Map<string, number> {
  const sorted = [...items].sort((a, b) => getScore(b) - getScore(a));
  const rankMap = new Map<string, number>();
  let prevScore: number | null = null;
  let prevRank = 1;
  for (let i = 0; i < sorted.length; i++) {
    const score = getScore(sorted[i]);
    const rank = prevScore !== null && Math.abs(score - prevScore) <= 1e-9 ? prevRank : i + 1;
    rankMap.set(getKey(sorted[i]), rank);
    prevScore = score;
    prevRank = rank;
  }
  return rankMap;
}

interface EntitySeed {
  entityName: string;
  entityScore: number;
}

function findEntitySeeds(
  db: ReturnType<typeof getDb>,
  ctx: FilterContext,
  safeFtsQuery: string | null,
  strictFtsQuery: string | null,
  mode: 'hybrid' | 'bm25',
  queryVec: number[],
  denseScoresMap: Map<string, number>
): Map<string, EntitySeed> {
  const scopeSql = buildHierarchicalScopeSql({
    tableAlias: 'e',
    scope: ctx.params.scope,
    projectId: cleanOptionalString(ctx.params.project_id),
    includeAncestors: ctx.includeAncestors,
    includeChildren: ctx.includeChildren,
    includeGlobal: ctx.includeGlobal,
    userId: ctx.userId,
  });

  const conditions: string[] = [scopeSql.clause];
  const queryParams: unknown[] = [...scopeSql.params];
  const entityType = cleanOptionalString(ctx.params.filters?.entity_type);
  if (entityType) {
    conditions.push('e.entity_type = ?');
    queryParams.push(entityType);
  }

  const nameById = new Map<string, string>();
  const ftsScoreById = new Map<string, number>();
  if (safeFtsQuery) {
    const entFtsStmt = db.prepare(
      `
      SELECT e.id, e.name, -bm25(fts_entities, 0.0, 2.5, 1.4, 1.0, 1.8) AS fts_bm25
      FROM fts_entities
      JOIN entities e ON e.id = fts_entities.record_id
      WHERE fts_entities MATCH ? AND ${conditions.join(' AND ')}
      ORDER BY fts_bm25 DESC
      LIMIT 30
      `
    );
    const ftsRows = entFtsStmt.all(safeFtsQuery, ...queryParams) as Array<{
      id: string;
      name: string;
      fts_bm25: number;
    }>;

    for (const r of ftsRows) {
      nameById.set(r.id, r.name);
      ftsScoreById.set(r.id, Math.max(Number(r.fts_bm25) || 0, 1e-6));
    }

    if (strictFtsQuery) {
      const strictEntRows = entFtsStmt.all(strictFtsQuery, ...queryParams) as Array<{
        id: string;
        name: string;
        fts_bm25: number;
      }>;
      for (const r of strictEntRows) {
        nameById.set(r.id, r.name);
        const strictBm25 = Math.max(Number(r.fts_bm25) || 0, 1e-6);
        const relaxedBm25 = ftsScoreById.get(r.id) ?? 0;
        ftsScoreById.set(r.id, Math.max(strictBm25 * 1.6, relaxedBm25 * 1.35));
      }
    }
  }
  const ftsHits: Array<{ id: string; score: number }> = Array.from(ftsScoreById.entries()).map(
    ([id, score]) => ({ id, score })
  );

  const denseHitsMap = new Map<string, number>();
  if (mode === 'hybrid' && queryVec.length > 0) {
    const embRows = db
      .prepare(
        `
        SELECT e.id, e.name, e.embedding
        FROM entities e
        WHERE e.embedding IS NOT NULL AND ${conditions.join(' AND ')}
        ORDER BY e.updated_at DESC
        LIMIT 500
        `
      )
      .all(...queryParams) as Array<{ id: string; name: string; embedding: Buffer }>;

    for (const r of embRows) {
      const qdrantScore = denseScoresMap.get(docKey('entity', r.id));
      const sim = qdrantScore !== undefined
        ? qdrantScore
        : cosineSimilarity(queryVec, deserializeEmbedding(r.embedding));
      if (sim >= MIN_ENTITY_DENSE_SIM) {
        nameById.set(r.id, r.name);
        denseHitsMap.set(r.id, sim);
      }
    }
  }

  if (ftsHits.length === 0 && denseHitsMap.size === 0) {
    return new Map();
  }

  const ftsRankMap = assignCompetitionRanks(ftsHits, (x) => x.id, (x) => x.score);
  const denseHits = Array.from(denseHitsMap.entries()).map(([id, score]) => ({ id, score }));
  const denseRankMap = assignCompetitionRanks(denseHits, (x) => x.id, (x) => x.score);

  const scored: Array<{ id: string; entityName: string; entityScore: number }> = [];
  for (const [id, entityName] of nameById.entries()) {
    const rFts = ftsRankMap.get(id);
    const rDense = denseRankMap.get(id);
    const entityScore =
      (rFts !== undefined ? 1 / (RRF_K + rFts) : 0) +
      (rDense !== undefined ? 1 / (RRF_K + rDense) : 0);
    if (entityScore > 0) {
      scored.push({ id, entityName, entityScore });
    }
  }

  scored.sort((a, b) => b.entityScore - a.entityScore);
  const seeds = new Map<string, EntitySeed>();
  for (const item of scored.slice(0, MAX_ENTITY_SEEDS)) {
    seeds.set(item.id, { entityName: item.entityName, entityScore: item.entityScore });
  }
  return seeds;
}

function normalizeEdgeRecordType(edgeNodeType: string): MemoryRecordType | null {
  if (edgeNodeType === 'lesson') return 'note';
  return VALID_RECORD_TYPES.has(edgeNodeType as MemoryRecordType)
    ? (edgeNodeType as MemoryRecordType)
    : null;
}

function collectChildProjectIds(db: ReturnType<typeof getDb>, normalizedProjectId: string): string[] {
  const range = getProjectChildRange(normalizedProjectId);
  const tables = ['notes', 'trajectories', 'observations', 'summaries', 'entities', 'actions'];
  const ids = new Set<string>();
  for (const table of tables) {
    const rows = db
      .prepare(
        `SELECT DISTINCT project_id FROM ${table} WHERE scope = 'project' AND project_id >= ? AND project_id < ?`
      )
      .all(range.gte, range.lt) as Array<{ project_id: string }>;
    for (const r of rows) {
      if (r.project_id) ids.add(r.project_id);
    }
  }
  return Array.from(ids);
}

function computeTierMultiplier(
  matchTier: MatchTier,
  ancestorDistance: number | undefined,
  hasQueryProject: boolean
): number {
  if (!hasQueryProject) return 1.0;
  switch (matchTier) {
    case 'exact':
      return 1.15;
    case 'ancestor':
      return 1.0 + 0.1 / Math.max(1, ancestorDistance ?? 1);
    case 'global':
      return 1.02;
    case 'child':
      return 0.98;
    default:
      return 1.0;
  }
}

function getCandidateCreatedMs(c: CandidateDoc): number | null {
  if ((c.record_type === 'note' || c.record_type === 'observation') && c.record.event_at) {
    const eventMs = parseTimestampMs(c.record.event_at);
    if (eventMs !== null) return eventMs;
  }
  return parseTimestampMs(c.record.created_at);
}

const YMD_STRICT_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseYmdUtcMs(ymd: unknown, hour: number, min: number, sec: number, ms: number): number | null {
  if (typeof ymd !== 'string') return null;
  const m = YMD_STRICT_RE.exec(ymd.trim());
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Date.UTC(year, month - 1, day, hour, min, sec, ms);
}

function parseResolvedDateAnnotations(rawJson: unknown): ResolvedDateAnnotation[] {
  if (typeof rawJson !== 'string' || rawJson.trim() === '') return [];
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (el): el is ResolvedDateAnnotation =>
        Boolean(el) &&
        typeof el === 'object' &&
        !Array.isArray(el) &&
        typeof (el as Record<string, unknown>).resolved_date === 'string'
    );
  } catch {
    return [];
  }
}

export function parseSignalTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((el): el is string => typeof el === 'string' && el.length > 0);
  }
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((el): el is string => typeof el === 'string' && el.length > 0);
  } catch {
    return [];
  }
}

function getBestTemporalWindowDistanceMs(
  c: CandidateDoc,
  parsedWindow: ParsedTemporalWindow
): number | null {
  const createdMs = getCandidateCreatedMs(c);
  let bestDist: number | null =
    createdMs !== null ? Math.abs(createdMs - parsedWindow.centerMs) : null;

  if (c.record_type === 'observation' && c.record.resolved_dates_json) {
    const annotations = parseResolvedDateAnnotations(c.record.resolved_dates_json);
    for (const ann of annotations) {
      let dist: number | null = null;
      if (ann.granularity !== 'day' && ann.window_start && ann.window_end) {
        const sMs = parseYmdUtcMs(ann.window_start, 0, 0, 0, 0);
        const eMs = parseYmdUtcMs(ann.window_end, 23, 59, 59, 999);
        if (sMs !== null && eMs !== null) {
          if (parsedWindow.centerMs >= sMs && parsedWindow.centerMs <= eMs) {
            dist = Math.min(parsedWindow.halfWidthMs * 0.25, (eMs - sMs) * 0.1);
          } else {
            dist =
              parsedWindow.centerMs < sMs
                ? sMs - parsedWindow.centerMs
                : parsedWindow.centerMs - eMs;
          }
        }
      } else if (ann.resolved_date) {
        const midMs = parseYmdUtcMs(ann.resolved_date, 12, 0, 0, 0);
        if (midMs !== null) {
          dist = Math.abs(midMs - parsedWindow.centerMs);
        }
      }

      if (dist !== null) {
        bestDist = bestDist === null ? dist : Math.min(bestDist, dist);
      }
    }
  }

  return bestDist;
}

function queryTemporalWindowCandidates(
  db: ReturnType<typeof getDb>,
  recordTypes: MemoryRecordType[],
  ctx: FilterContext,
  parsedWindow: ParsedTemporalWindow
): CandidateDoc[] {
  const out: CandidateDoc[] = [];
  const centerIso = new Date(parsedWindow.centerMs).toISOString();
  const windowStartDate = parsedWindow.windowStartIso.slice(0, 10);
  const windowEndDate = parsedWindow.windowEndIso.slice(0, 10);

  const targetTypes: Array<'observation' | 'note'> = ['observation', 'note'];
  for (const rType of targetTypes) {
    if (!recordTypes.includes(rType)) continue;
    const spec = RECORD_SPECS[rType];
    const built = buildWhereForType(spec, ctx);
    if (built.impossible) continue;

    const tExpr = spec.temporalExpr(spec.alias);
    const windowSql = `
      SELECT ${spec.alias}.*
      FROM ${spec.table} ${spec.alias}
      WHERE ${built.conditions.join(' AND ')}
        AND ${tExpr} >= ?
        AND ${tExpr} <= ?
      ORDER BY ABS(julianday(${tExpr}) - julianday(?)) ASC, ${spec.scanOrderCol} DESC
      LIMIT 150
    `;
    const windowRows = db
      .prepare(windowSql)
      .all(
        ...built.queryParams,
        parsedWindow.windowStartIso,
        parsedWindow.windowEndIso,
        centerIso
      ) as any[];
    out.push(...spec.hydrate(db, windowRows));

    if (rType === 'observation') {
      const resolvedOverlapSql = `
        SELECT o.*
        FROM observations o
        WHERE ${built.conditions.join(' AND ')}
          AND o.resolved_dates_json IS NOT NULL
          AND json_valid(o.resolved_dates_json) = 1
          AND json_type(o.resolved_dates_json) = 'array'
          AND EXISTS (
            SELECT 1
            FROM json_each(
              CASE
                WHEN json_valid(o.resolved_dates_json) = 1 AND json_type(o.resolved_dates_json) = 'array'
                THEN o.resolved_dates_json
                ELSE '[]'
              END
            ) je
            WHERE je.type = 'object'
              AND COALESCE(
                    CASE WHEN je.type = 'object' THEN json_extract(je.value, '$.window_start') END,
                    CASE WHEN je.type = 'object' THEN json_extract(je.value, '$.resolved_date') END
                  ) <= ?
              AND COALESCE(
                    CASE WHEN je.type = 'object' THEN json_extract(je.value, '$.window_end') END,
                    CASE WHEN je.type = 'object' THEN json_extract(je.value, '$.resolved_date') END
                  ) >= ?
          )
        ORDER BY o.created_at DESC
        LIMIT 100
      `;
      const resolvedRows = db
        .prepare(resolvedOverlapSql)
        .all(...built.queryParams, windowEndDate, windowStartDate) as any[];
      out.push(...spec.hydrate(db, resolvedRows));
    }
  }

  return out;
}

const TEMPORAL_RECALL_META_VERBS = new Set([
  'mention',
  'mentioned',
  'mentions',
  'say',
  'said',
  'tell',
  'told',
  'happen',
  'happened',
  'happening',
  'talk',
  'talked',
  'discuss',
  'discussed',
  'remember',
  'recall',
  'log',
  'logged',
  'record',
  'recorded',
  'occur',
  'occurred',
]);

const EXPLICIT_CALENDAR_TOKEN_RE =
  /^(?:\d{4}|\d{1,2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|q[1-4])$/i;

function computeTemporalMultiplier(
  c: CandidateDoc,
  params: SearchRequest,
  nowMs: number,
  parsedWindow: ParsedTemporalWindow | null
): number {
  let mult = 1.0;

  if (!params.as_of && !params.include_history && c.record_type === 'note' && c.record.valid_until) {
    const validUntilMs = parseTimestampMs(c.record.valid_until);
    if (validUntilMs !== null && validUntilMs < nowMs) {
      mult *= 0.75;
    }
  }

  if (parsedWindow) {
    const distMs = getBestTemporalWindowDistanceMs(c, parsedWindow);
    if (distMs !== null) {
      const hw = Math.max(parsedWindow.halfWidthMs, 1);
      if (distMs <= hw) {
        // Inside [windowStart, windowEnd]: 1.40x at window center down to 1.22x at window edge
        mult *= 1.22 + 0.18 * Math.cos((Math.PI / 2) * (distMs / hw));
      } else if (distMs <= 2 * hw) {
        // 1x halfWidthMs grace zone: smooth cosine taper from 1.22x down to 1.0x
        const t = (distMs - hw) / hw;
        mult *= 1.0 + 0.22 * Math.cos((Math.PI / 2) * t);
      }
    }
  }

  if (params.temporal_bias === 'recent') {
    const createdMs = getCandidateCreatedMs(c);
    if (createdMs !== null) {
      const ageDays = Math.max(0, (nowMs - createdMs) / 86_400_000);
      mult *= 1.0 + 0.08 / (1 + ageDays / 30);
    }
  } else if (params.temporal_bias === 'upcoming') {
    if (c.record_type === 'action' && c.record.due_at) {
      const dueMs = parseTimestampMs(c.record.due_at);
      if (dueMs !== null && dueMs >= nowMs) {
        mult *= 1.12;
      }
    } else if ((c.record_type === 'note' || c.record_type === 'observation') && c.record.event_at) {
      const eventMs = parseTimestampMs(c.record.event_at);
      if (eventMs !== null && eventMs >= nowMs) {
        mult *= 1.08;
      }
    }
  }

  return mult;
}

export async function hybridSearch(params: SearchRequest): Promise<SearchResponse> {
  const q = typeof params.q === 'string' ? params.q.trim() : '';
  const requestedTypesRaw =
    Array.isArray(params.record_types) && params.record_types.length > 0
      ? params.record_types
      : Array.isArray(params.grains) && params.grains.length > 0
        ? params.grains
        : typeof (params.record_types as unknown) === 'string' &&
            (params.record_types as unknown as string).trim() !== ''
          ? [(params.record_types as unknown as string).trim()]
          : typeof (params.grains as unknown) === 'string' &&
              (params.grains as unknown as string).trim() !== ''
            ? [(params.grains as unknown as string).trim()]
            : null;
  const recordTypes: MemoryRecordType[] = (requestedTypesRaw ?? ['note', 'trajectory']).filter(
    (t): t is MemoryRecordType =>
      typeof t === 'string' && VALID_RECORD_TYPES.has(t as MemoryRecordType)
  );

  const parsedLimit =
    typeof params.limit === 'number'
      ? params.limit
      : typeof (params.limit as unknown) === 'string' &&
          (params.limit as unknown as string).trim() !== ''
        ? Number(params.limit)
        : Number.NaN;
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(Math.trunc(parsedLimit), 1), 100)
    : 10;
  const includeGlobal = params.include_global !== false;
  const includeAncestors = params.include_ancestors !== false;
  const includeChildren = params.include_children === true;
  const userId = cleanOptionalString(params.user_id) ?? cleanOptionalString(params.filters?.user_id);

  const afterIso = normalizeUtcIso(params.after, 'after');
  const beforeIso = normalizeUtcIso(params.before, 'before');
  const asOfIso = normalizeUtcIso(params.as_of, 'as_of');
  const referenceIso = normalizeUtcIso(params.reference_date, 'reference_date');
  const nowMs = referenceIso ? Date.parse(referenceIso) : Date.now();
  const parsedWindow = parseTemporalQueryWindow(q, referenceIso ?? new Date(nowMs).toISOString());
  const temporalWindowMeta = parsedWindow
    ? {
        start: parsedWindow.windowStartIso,
        end: parsedWindow.windowEndIso,
        expressions: parsedWindow.expressions,
      }
    : undefined;

  const db = getDb();

  if (recordTypes.length === 0) {
    return {
      results: [],
      mode: 'bm25',
      ...(temporalWindowMeta ? { temporal_window: temporalWindowMeta } : {}),
    };
  }

  const hasFileFilter = cleanOptionalString(params.filters?.file_path) !== null;
  const intent = detectQueryKindIntent(q, hasFileFilter);

  const ctx: FilterContext = {
    params,
    queryIntent: intent,
    includeGlobal,
    includeAncestors,
    includeChildren,
    userId,
    afterIso,
    beforeIso,
    asOfIso,
  };

  const candidateMap = new Map<string, CandidateDoc>();
  const addCandidate = (doc: CandidateDoc) => {
    const key = docKey(doc.record_type, doc.id);
    const existing = candidateMap.get(key);
    if (!existing) {
      candidateMap.set(key, doc);
    } else {
      if (doc.bm25Score !== undefined && (existing.bm25Score ?? 0) < doc.bm25Score) {
        existing.bm25Score = doc.bm25Score;
      }
      if (
        doc.temporalRecallScore !== undefined &&
        (existing.temporalRecallScore ?? 0) < doc.temporalRecallScore
      ) {
        existing.temporalRecallScore = doc.temporalRecallScore;
      }
    }
  };

  // 1. Signal 1: Two-tier SQLite FTS5 BM25 retrieval across all requested record types
  const safeFtsQuery = buildSafeFtsQuery(q);
  const strictFtsQuery = buildStrictFtsQuery(q);
  const ftsLimit = Math.max(limit * 10, 200);
  if (safeFtsQuery) {
    for (const recordType of recordTypes) {
      for (const doc of queryTypeFts(db, recordType, ctx, safeFtsQuery, strictFtsQuery, ftsLimit)) {
        addCandidate(doc);
      }
    }
  }

  // 1b. Auxiliary Temporal Window Recall (when query expresses a temporal window)
  if (parsedWindow) {
    for (const doc of queryTemporalWindowCandidates(db, recordTypes, ctx, parsedWindow)) {
      addCandidate(doc);
    }
  }

  // 2. Signal 2: Dense vector retrieval (Qdrant + bounded SQLite scan fallback)
  const recipe = resolveEmbedderRecipe();
  const verification = verifyOrCreateStoreMeta();
  const isMismatch = !verification.match && recipe.embed_tier !== 'none';

  let mode: 'hybrid' | 'bm25' = 'hybrid';
  let degradedMessage: string | undefined;

  if (recipe.embed_tier === 'none') {
    mode = 'bm25';
  } else if (isMismatch) {
    mode = 'bm25';
    degradedMessage = verification.mismatchReason;
  }

  const denseScoresMap = new Map<string, number>();
  let queryVec: number[] = [];

  if (mode === 'hybrid') {
    try {
      queryVec = await embedQuery(q);
      let qdrantReturnedHits = false;

      if (queryVec && queryVec.length > 0) {
        const qdrant = getQdrantClient();
        if (qdrant) {
          const alias = verification.meta?.qdrant_alias || 'brain';
          try {
            let childProjectIds: string[] | undefined;
            const rawChildProject = cleanOptionalString(params.project_id);
            if (includeChildren && rawChildProject) {
              const normRes = normalizeProjectId(rawChildProject);
              const norm = normRes.ok ? normRes.projectId : rawChildProject;
              childProjectIds = collectChildProjectIds(db, norm);
            }
            const filter = buildQdrantFilter(params, recordTypes, includeGlobal, childProjectIds);
            const searchRes = await qdrant.search(alias, {
              vector: queryVec,
              limit: Math.max(limit * 2, 50),
              with_payload: true,
              ...(filter ? { filter } : {}),
            });

            if (searchRes.length > 0) {
              qdrantReturnedHits = true;
              const missingByType = new Map<MemoryRecordType, string[]>();

              for (const pt of searchRes) {
                const ptId =
                  typeof pt.payload?.record_id === 'string' ? pt.payload.record_id : String(pt.id);
                const ptType =
                  typeof pt.payload?.record_type === 'string'
                    ? pt.payload.record_type
                    : typeof pt.payload?.grain === 'string'
                      ? pt.payload.grain
                      : undefined;

                const typesForPt: MemoryRecordType[] =
                  ptType && VALID_RECORD_TYPES.has(ptType as MemoryRecordType)
                    ? [ptType as MemoryRecordType]
                    : recordTypes;

                for (const rType of typesForPt) {
                  const key = docKey(rType, ptId);
                  denseScoresMap.set(key, pt.score);
                  if (recordTypes.includes(rType) && !candidateMap.has(key)) {
                    let list = missingByType.get(rType);
                    if (!list) {
                      list = [];
                      missingByType.set(rType, list);
                    }
                    list.push(ptId);
                  }
                }
              }

              for (const [rType, ids] of missingByType.entries()) {
                for (const doc of queryTypeByIds(db, rType, ctx, ids)) {
                  addCandidate(doc);
                }
              }
            }
          } catch {
            // Fallback to bounded SQLite embedding scan below
          }
        }

        if (!qdrantReturnedHits) {
          for (const recordType of recordTypes) {
            for (const doc of queryTypeEmbeddedScan(db, recordType, ctx, 500)) {
              addCandidate(doc);
            }
          }
        }
      }
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'dense query embedding failed, falling back to BM25'
      );
      mode = 'bm25';
    }
  }

  // 3. Signal 3: Entity-Graph 1-hop discovery & boosting
  const entitySeeds = findEntitySeeds(
    db,
    ctx,
    safeFtsQuery,
    strictFtsQuery,
    mode,
    queryVec,
    denseScoresMap
  );
  if (entitySeeds.size > 0) {
    const seedIds = Array.from(entitySeeds.keys());
    const seedPlaceholders = seedIds.map(() => '?').join(',');
    const edges = db
      .prepare(
        `
        SELECT source_type, source_id, target_type, target_id
        FROM entity_edges
        WHERE source_id IN (${seedPlaceholders}) OR target_id IN (${seedPlaceholders})
        `
      )
      .all(...seedIds, ...seedIds) as Array<{
      source_type: string;
      source_id: string;
      target_type: string;
      target_id: string;
    }>;

    const recordTypeSet = new Set<MemoryRecordType>(recordTypes);
    const linksByDocKey = new Map<string, Map<string, EntitySeed>>();
    const missingByType = new Map<MemoryRecordType, Set<string>>();

    const recordLink = (targetTypeRaw: string, targetId: string, seedId: string, seed: EntitySeed) => {
      if (targetId === seedId) return;
      const targetType = normalizeEdgeRecordType(targetTypeRaw);
      if (!targetType || !recordTypeSet.has(targetType)) return;
      const key = docKey(targetType, targetId);
      let linkedSeeds = linksByDocKey.get(key);
      if (!linkedSeeds) {
        linkedSeeds = new Map();
        linksByDocKey.set(key, linkedSeeds);
      }
      linkedSeeds.set(seedId, seed);

      if (!candidateMap.has(key)) {
        let missing = missingByType.get(targetType);
        if (!missing) {
          missing = new Set();
          missingByType.set(targetType, missing);
        }
        missing.add(targetId);
      }
    };

    for (const edge of edges) {
      const srcSeed = entitySeeds.get(edge.source_id);
      if (srcSeed) {
        recordLink(edge.target_type, edge.target_id, edge.source_id, srcSeed);
      }
      const tgtSeed = entitySeeds.get(edge.target_id);
      if (tgtSeed) {
        recordLink(edge.source_type, edge.source_id, edge.target_id, tgtSeed);
      }
    }

    for (const [rType, idSet] of missingByType.entries()) {
      for (const doc of queryTypeByIds(db, rType, ctx, Array.from(idSet))) {
        addCandidate(doc);
      }
    }

    for (const [key, linkedSeeds] of linksByDocKey.entries()) {
      const cand = candidateMap.get(key);
      if (!cand) continue;
      const ordered = Array.from(linkedSeeds.values()).sort(
        (a, b) => b.entityScore - a.entityScore
      );
      cand.entityLinkScore = ordered[0]?.entityScore;
      cand.matchedEntities = Array.from(new Set(ordered.map((s) => s.entityName)));
    }
  }

  const candidates = Array.from(candidateMap.values());
  if (candidates.length === 0) {
    return {
      results: [],
      mode,
      degraded: degradedMessage,
      ...(temporalWindowMeta ? { temporal_window: temporalWindowMeta } : {}),
    };
  }

  // Compute SQLite cosine similarity for any candidate not scored by Qdrant
  if (mode === 'hybrid' && queryVec.length > 0) {
    for (const c of candidates) {
      const key = docKey(c.record_type, c.id);
      if (!denseScoresMap.has(key) && c.embedding) {
        const vec = deserializeEmbedding(c.embedding);
        if (vec.length === queryVec.length) {
          denseScoresMap.set(key, cosineSimilarity(queryVec, vec));
        }
      }
    }
  }

  // Score auxiliary temporal recall for candidates inside [windowStart, windowEnd]
  let residualTopicalTokens: string[] = [];
  let residualPhrases: string[] = [];
  let explicitCalendarTokens: string[] = [];
  if (parsedWindow) {
    const residualSignals = parseQuerySignals(parsedWindow.residualQuery);
    residualPhrases = residualSignals.phrases;
    residualTopicalTokens = residualSignals.contentTokens.filter(
      (tok) => !TEMPORAL_RECALL_META_VERBS.has(tok)
    );
    const exprWords = parsedWindow.expressions.join(' ').toLowerCase().match(/[a-z0-9]+/g) ?? [];
    explicitCalendarTokens = Array.from(
      new Set(exprWords.filter((w) => EXPLICIT_CALENDAR_TOKEN_RE.test(w)))
    );

    const hw = Math.max(parsedWindow.halfWidthMs, 1);
    for (const c of candidates) {
      const distMs = getBestTemporalWindowDistanceMs(c, parsedWindow);
      if (distMs !== null && distMs <= hw) {
        const proximity = 0.35 + 0.65 * Math.cos((Math.PI / 2) * (distMs / hw));
        let residualOverlap = 0;
        if (residualTopicalTokens.length > 0) {
          const lower = c.text.toLowerCase();
          let matched = 0;
          for (const tok of residualTopicalTokens) {
            if (lower.includes(tok)) matched++;
          }
          residualOverlap = matched / residualTopicalTokens.length;
        }
        c.temporalRecallScore = proximity + 1.5 * residualOverlap;
      }
    }
  }

  const hasSubstantiveTemporalQueryLexicalMatch = (c: CandidateDoc): boolean => {
    if (!parsedWindow) return true;
    const lower = c.text.toLowerCase();
    for (const phrase of residualPhrases) {
      if (lower.includes(phrase)) return true;
    }
    for (const tok of residualTopicalTokens) {
      if (lower.includes(tok)) return true;
    }
    if (explicitCalendarTokens.length >= 2) {
      let calMatches = 0;
      for (const calTok of explicitCalendarTokens) {
        if (lower.includes(calTok)) calMatches++;
      }
      if (calMatches >= 2) return true;
    }
    return false;
  };

  // 4. Rank each signal independently (competition ranking prevents arbitrary tie skew)
  const bm25Matched = candidates.filter((c) => (c.bm25Score ?? 0) > 0);
  const bm25RankMap = assignCompetitionRanks(
    bm25Matched,
    (c) => docKey(c.record_type, c.id),
    (c) => c.bm25Score ?? 0
  );

  const denseRankMap =
    mode === 'hybrid'
      ? assignCompetitionRanks(
          candidates.filter((c) => (denseScoresMap.get(docKey(c.record_type, c.id)) ?? 0) > 0),
          (c) => docKey(c.record_type, c.id),
          (c) => denseScoresMap.get(docKey(c.record_type, c.id)) ?? 0
        )
      : new Map<string, number>();

  const entityRankMap = assignCompetitionRanks(
    candidates.filter((c) => (c.entityLinkScore ?? 0) > 0),
    (c) => docKey(c.record_type, c.id),
    (c) => c.entityLinkScore ?? 0
  );

  const temporalRankMap = parsedWindow
    ? assignCompetitionRanks(
        candidates.filter((c) => (c.temporalRecallScore ?? 0) > 0),
        (c) => docKey(c.record_type, c.id),
        (c) => c.temporalRecallScore ?? 0
      )
    : new Map<string, number>();

  const maxBm25 = bm25Matched.reduce((m, c) => Math.max(m, c.bm25Score ?? 0), 0);

  const queryProjectRaw = cleanOptionalString(params.project_id);
  let queryProjectNorm: string | null = null;
  if (queryProjectRaw && params.scope !== 'global' && params.scope !== 'unknown') {
    const res = normalizeProjectId(queryProjectRaw);
    queryProjectNorm = res.ok ? res.projectId : queryProjectRaw;
  }

  const kindWeights = resolveKindWeights(intent, params.kind_weights);
  const querySignals = parseQuerySignals(q);
  const signalIntent = detectQuerySignalIntent(q);
  const snippetMode: SnippetMode =
    params.snippet_mode === 'condensed' || params.snippet_mode === 'raw'
      ? params.snippet_mode
      : 'query_focused';
  const explicitMaxChars =
    typeof params.max_record_chars === 'number' &&
    Number.isFinite(params.max_record_chars) &&
    params.max_record_chars > 0
      ? Math.max(32, Math.trunc(params.max_record_chars))
      : undefined;

  for (const c of candidates) {
    const key = docKey(c.record_type, c.id);
    const rankDense = denseRankMap.get(key);
    const rankBm25 = bm25RankMap.get(key);
    const rankEntity = entityRankMap.get(key);
    const rankTemporal = temporalRankMap.get(key);
    const bm25LexicalScale =
      rankBm25 !== undefined && parsedWindow && !hasSubstantiveTemporalQueryLexicalMatch(c)
        ? 0.2
        : 1.0;

    let baseScore = 0;
    if (mode === 'hybrid') {
      if (rankDense !== undefined) baseScore += 1 / (RRF_K + rankDense);
      if (rankBm25 !== undefined) baseScore += bm25LexicalScale / (RRF_K + rankBm25);
      if (rankEntity !== undefined) baseScore += 1 / (RRF_K + rankEntity);
      if (rankTemporal !== undefined) baseScore += 0.75 / (RRF_K + rankTemporal);
    } else {
      const bm25Norm =
        maxBm25 > 0 && (c.bm25Score ?? 0) > 0 ? (c.bm25Score! / maxBm25) * bm25LexicalScale : 0;
      const entityBoost =
        rankEntity !== undefined ? 0.25 * ((RRF_K + 1) / (RRF_K + rankEntity)) : 0;
      const temporalBoost =
        rankTemporal !== undefined ? 0.35 * ((RRF_K + 1) / (RRF_K + rankTemporal)) : 0;
      baseScore = bm25Norm + entityBoost + temporalBoost;
    }

    const tierInfo = classifyMatchTier(c.record.scope, c.record.project_id, queryProjectNorm);
    c.matchTier = tierInfo.match_tier;

    if (baseScore > 0) {
      const tierMult = computeTierMultiplier(
        tierInfo.match_tier,
        tierInfo.ancestor_distance,
        queryProjectNorm !== null
      );
      const temporalMult = computeTemporalMultiplier(c, params, nowMs, parsedWindow);
      let obsMult = 1.0;
      if (c.record_type === 'observation') {
        const obsKind = c.record.kind as ObservationSearchKind;
        const kindMult =
          obsKind === 'prompt' || obsKind === 'response' || obsKind === 'tool_call'
            ? kindWeights[obsKind]
            : 1.0;
        const densityMult = computeObservationDensityMultiplier(c.record, querySignals);
        let signalMult = 1.0;
        if (signalIntent.wantsPreference || signalIntent.wantsStateUpdate) {
          const tags = parseSignalTags(c.record.signal_tags);
          if (tags.length > 0) {
            if (
              intent !== 'assistant' &&
              signalIntent.wantsPreference &&
              tags.includes('preference')
            ) {
              signalMult *= 1.22;
            }
            if (signalIntent.wantsStateUpdate && tags.includes('state_update')) {
              signalMult *= 1.18;
              const createdMs = getCandidateCreatedMs(c);
              if (createdMs !== null) {
                const ageDays = Math.max(0, (nowMs - createdMs) / 86_400_000);
                signalMult *= 1.0 + 0.06 / (1 + ageDays / 60);
              }
            }
          }
        }
        obsMult = kindMult * densityMult * signalMult;
      }
      c.rrfScore = baseScore * tierMult * temporalMult * obsMult;
    } else {
      c.rrfScore = 0;
    }
  }

  const matched = candidates.filter((c) => (c.rrfScore ?? 0) > 0);
  matched.sort((a, b) => (b.rrfScore ?? 0) - (a.rrfScore ?? 0));

  const maxKindShare = resolveMaxKindShare(params, recordTypes, intent, limit);
  let sliced: CandidateDoc[];
  if (!maxKindShare) {
    sliced = matched.slice(0, limit);
  } else {
    const selected: CandidateDoc[] = [];
    const deferred: CandidateDoc[] = [];
    const countsByKind: Record<ObservationSearchKind, number> = {
      prompt: 0,
      response: 0,
      tool_call: 0,
    };

    for (const c of matched) {
      if (selected.length >= limit) break;
      if (c.record_type === 'observation') {
        const obsKind = c.record.kind as ObservationSearchKind;
        const shareCap =
          obsKind === 'prompt' || obsKind === 'response' || obsKind === 'tool_call'
            ? maxKindShare[obsKind]
            : undefined;
        if (shareCap !== undefined) {
          const maxForKind = Math.max(1, Math.floor(limit * shareCap));
          if (countsByKind[obsKind] >= maxForKind) {
            deferred.push(c);
            continue;
          }
          countsByKind[obsKind]++;
        }
      }
      selected.push(c);
    }

    if (selected.length < limit && deferred.length > 0) {
      selected.push(...deferred.slice(0, limit - selected.length));
      selected.sort((a, b) => (b.rrfScore ?? 0) - (a.rrfScore ?? 0));
    }

    sliced = selected;
  }

  const results: SearchResultItem[] = sliced.map((c) => {
    let recordOut = c.record;
    let snippetOut: string | undefined;
    if (c.record_type === 'observation') {
      const formatted = formatObservationResult(
        c.record,
        q,
        querySignals,
        snippetMode,
        explicitMaxChars,
        parsedWindow
      );
      recordOut = formatted.record;
      snippetOut = formatted.snippet;
    }

    const item: SearchResultItem = {
      id: c.id,
      record_type: c.record_type,
      score: c.rrfScore ?? 0,
      project_id: recordOut.project_id ?? null,
      match_tier: c.matchTier,
      ...(c.matchedEntities && c.matchedEntities.length > 0
        ? { matched_entities: c.matchedEntities }
        : {}),
      ...(snippetOut !== undefined ? { snippet: snippetOut } : {}),
      record: recordOut,
    };
    if (c.record_type === 'summary') {
      item.claims = c.claims;
    }
    return item;
  });

  if (params.include_sources === true) {
    const rawLimit = params.sources_limit;
    const sourcesLimit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(Math.trunc(rawLimit), 100))
        : 20;
    const rawOffset = params.sources_offset;
    const sourcesOffset =
      typeof rawOffset === 'number' && Number.isFinite(rawOffset)
        ? Math.max(0, Math.trunc(rawOffset))
        : 0;
    attachPaginatedSummarySources(db, results, sourcesLimit, sourcesOffset);
  }

  return {
    results,
    mode,
    degraded: degradedMessage,
    ...(temporalWindowMeta ? { temporal_window: temporalWindowMeta } : {}),
  };
}

function truncateSourcePreview(value: string | null | undefined, maxChars = MAX_SOURCE_PREVIEW_CHARS): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars)}...`;
}

function attachPaginatedSummarySources(
  db: ReturnType<typeof getDb>,
  results: SearchResultItem[],
  sourcesLimit: number,
  sourcesOffset: number
): void {
  const summaryItems = results.filter((r) => r.record_type === 'summary');
  if (summaryItems.length === 0) return;

  const summaryIds = summaryItems.map((r) => r.id);
  const placeholders = summaryIds.map(() => '?').join(',');
  const allSources = db
    .prepare(
      `SELECT summary_id, claim_id, record_id, record_type FROM summary_sources WHERE summary_id IN (${placeholders}) ORDER BY rowid ASC`
    )
    .all(...summaryIds) as Array<{ summary_id: string; claim_id: string | null; record_id: string; record_type: string }>;

  const sourcesBySummaryId = new Map<string, typeof allSources>();
  for (const s of allSources) {
    let list = sourcesBySummaryId.get(s.summary_id);
    if (!list) {
      list = [];
      sourcesBySummaryId.set(s.summary_id, list);
    }
    list.push(s);
  }

  const pagedBySummaryId = new Map<string, { page: typeof allSources; total: number }>();
  const idsByType = new Map<string, Set<string>>();

  for (const item of summaryItems) {
    const all = sourcesBySummaryId.get(item.id) || [];
    const page = all.slice(sourcesOffset, sourcesOffset + sourcesLimit);
    pagedBySummaryId.set(item.id, { page, total: all.length });
    for (const s of page) {
      let set = idsByType.get(s.record_type);
      if (!set) {
        set = new Set<string>();
        idsByType.set(s.record_type, set);
      }
      set.add(s.record_id);
    }
  }

  const metaByKey = new Map<string, Partial<SearchSummarySource>>();

  const obsIds = Array.from(idsByType.get('observation') ?? []);
  if (obsIds.length > 0) {
    const obsPlaceholders = obsIds.map(() => '?').join(',');
    const obsRows = db
      .prepare(
        `SELECT id, kind, tool_name, file_path, input, output, failed FROM observations WHERE id IN (${obsPlaceholders})`
      )
      .all(...obsIds) as Array<{
      id: string;
      kind: string;
      tool_name: string | null;
      file_path: string | null;
      input: string | null;
      output: string | null;
      failed: number;
    }>;

    const foundObsIds = new Set<string>();
    const mapObsRow = (row: (typeof obsRows)[number]) => {
      const title =
        row.kind === 'prompt'
          ? 'prompt'
          : row.tool_name
            ? row.file_path
              ? `${row.tool_name}: ${row.file_path}`
              : row.tool_name
            : row.kind || 'observation';
      metaByKey.set(docKey('observation', row.id), {
        title,
        kind: row.kind,
        tool_name: row.tool_name,
        file_path: row.file_path,
        failed: Boolean(row.failed),
        preview: truncateSourcePreview(row.input) ?? truncateSourcePreview(row.output),
      });
    };

    for (const row of obsRows) {
      foundObsIds.add(row.id);
      mapObsRow(row);
    }

    const missingObsIds = obsIds.filter((id) => !foundObsIds.has(id));
    if (missingObsIds.length > 0) {
      const arcPlaceholders = missingObsIds.map(() => '?').join(',');
      const arcRows = db
        .prepare(
          `SELECT original_observation_id as id, kind, tool_name, file_path, input, output, failed FROM observations_archive WHERE original_observation_id IN (${arcPlaceholders})`
        )
        .all(...missingObsIds) as typeof obsRows;
      for (const row of arcRows) {
        mapObsRow(row);
      }
    }
  }

  const noteIds = Array.from(idsByType.get('note') ?? []);
  if (noteIds.length > 0) {
    const notePlaceholders = noteIds.map(() => '?').join(',');
    const noteRows = db
      .prepare(`SELECT id, title, type FROM notes WHERE id IN (${notePlaceholders})`)
      .all(...noteIds) as Array<{ id: string; title: string; type: string }>;
    for (const row of noteRows) {
      metaByKey.set(docKey('note', row.id), { title: row.title, kind: row.type });
    }
  }

  const trajIds = Array.from(idsByType.get('trajectory') ?? []);
  if (trajIds.length > 0) {
    const trajPlaceholders = trajIds.map(() => '?').join(',');
    const trajRows = db
      .prepare(`SELECT id, task_type, description FROM trajectories WHERE id IN (${trajPlaceholders})`)
      .all(...trajIds) as Array<{ id: string; task_type: string | null; description: string }>;
    for (const row of trajRows) {
      metaByKey.set(docKey('trajectory', row.id), {
        title: truncateSourcePreview(row.description) ?? row.task_type ?? 'trajectory',
        ...(row.task_type ? { kind: row.task_type } : {}),
      });
    }
  }

  const sumIds = Array.from(idsByType.get('summary') ?? []);
  if (sumIds.length > 0) {
    const sumPlaceholders = sumIds.map(() => '?').join(',');
    const sumRows = db
      .prepare(
        `SELECT s.id, s.kind, (SELECT c.text FROM summary_claims c WHERE c.summary_id = s.id ORDER BY c.ordinal ASC LIMIT 1) as first_claim
         FROM summaries s WHERE s.id IN (${sumPlaceholders})`
      )
      .all(...sumIds) as Array<{ id: string; kind: string; first_claim: string | null }>;
    for (const row of sumRows) {
      metaByKey.set(docKey('summary', row.id), {
        title: truncateSourcePreview(row.first_claim) ?? row.kind,
        kind: row.kind,
      });
    }
  }

  for (const item of summaryItems) {
    const paged = pagedBySummaryId.get(item.id);
    if (!paged) continue;
    item.sources = paged.page.map((s) => ({
      ...s,
      ...metaByKey.get(docKey(s.record_type, s.record_id)),
    }));
    item.sources_total = paged.total;
    item.sources_has_more = sourcesOffset + paged.page.length < paged.total;
  }
}
