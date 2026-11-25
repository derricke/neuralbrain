/**
 * Deterministic, zero-dependency linguistic signal tagger and query-intent detector.
 *
 * Extracts universal conversational and coding memory signals (`preference`,
 * `state_update`, `completed_action`, `planned_action`) at capture time in strictly
 * bounded O(N) time without mutating raw `observations.input` or `observations.output`,
 * and detects preference / current-state query intent at retrieval time.
 */

import { safeUtf16Slice, splitIntoPassages } from './condenser';

export type SignalTag =
  | 'preference'
  | 'state_update'
  | 'completed_action'
  | 'planned_action';

export const SIGNAL_TAG_ORDER: readonly SignalTag[] = [
  'preference',
  'state_update',
  'completed_action',
  'planned_action',
];

export const MAX_SIGNAL_SCAN_CHARS = 8_000;
const MAX_SIGNAL_SCAN_PASSAGES = 60;
const MAX_CONCISE_SUMMARY_CHARS = 400;
const MAX_QUERY_INTENT_SCAN_CHARS = 4_000;

export interface ExtractSignalTagsInput {
  kind: 'prompt' | 'response' | 'tool_call' | string;
  input?: string | null;
  output?: string | null;
}

export interface QuerySignalIntent {
  wantsPreference: boolean;
  wantsStateUpdate: boolean;
}

const LEADING_LIST_MARKER_RE = /^\s{0,8}(?:[-*+>]|\d{1,3}[.)])\s{1,4}/;
const QUESTION_END_RE = /\?['"”’)\]}]{0,4}$/;

const INTERROGATIVE_START_RE =
  /^(?:what|which|who|where|when|why|how|do|does|did|is|are|was|were|can|could|should|would|will|have|has)\b/i;

const IMPERATIVE_DO_NOT_START_RE = /^do\s{1,3}not\b/i;

const SUBORDINATE_WHEN_WHERE_RE =
  /^(?:when|where)\s{1,3}(?!do\b|does\b|did\b|is\b|are\b|was\b|were\b|can\b|could\b|should\b|would\b|will\b|have\b|has\b)/i;

const DECLARATIVE_AFTER_COMMA_RE =
  /,\s{1,3}(?:i['’]?(?:m|ve|d)?\b|we['’]?(?:re|ve|d)?\b|my\b|our\b|please\b|always\b|never\b|now\b)/i;

const CONDITIONAL_OR_NEGATED_PREFIX_RE =
  /(?:n['’]t|\b(?:if|whether|unless|you|your|they|he|she|not|never|no))\s{1,3}$/i;

const CONDITIONAL_CLAUSE_PREFIX_RE = /\b(?:if|whether|unless)\s{1,3}$/i;

const PLANNED_BLOCKED_PREFIX_RE =
  /(?:n['’]t|\b(?:if|whether|unless|not|never|no))\s{1,3}$/i;

const ASSISTANT_META_CHATTER_RE =
  /\b(?:going\s{1,3}to\s{1,3}(?:explain|walk|show|list|outline|cover|help|break|share|summarize|discuss|provide)|if\s{1,3}you\b|for\s{1,3}example\b|you\s{1,3}(?:can|could|might|may|should)\b|now\s{1,3}we\s{1,3}have\s{1,3}(?:a\s{1,3}|some\s{1,3}|two\s{1,3}|three\s{1,3}|several\s{1,3})?(?:options?|ways?|steps?|approaches?)\b)/i;

const PREFERENCE_COMBINED_RE = new RegExp(
  [
    String.raw`\b(?:i|we)\s{1,3}(?:really\s{1,3}|strongly\s{1,3}|generally\s{1,3}|usually\s{1,3}|always\s{1,3})?(?:prefer|like|love|enjoy|hate|dislike|avoid|stick\s{1,3}to|favou?r)\b`,
    String.raw`\b(?:i['’]d|i\s{1,3}would|we['’]d|we\s{1,3}would)\s{1,3}rather\b`,
    String.raw`\b(?:always|never)\s{1,3}use\b`,
    String.raw`\b(?:please\s{1,3})?(?:do\s{1,3}not|don['’]t)\s{1,3}use\b`,
    String.raw`\b(?:my|our)\s{1,3}(?:favou?rite|preferred|go-to|usual)\b`,
    String.raw`\bskip\s{1,3}the\s{1,3}basics\b`,
  ].join('|'),
  'i'
);

const STATE_UPDATE_SUBJECTLESS_RE =
  /\b(?:(?:i|we|our\s{1,3}team)\s{1,3})?(?:just\s{1,3}|recently\s{1,3})?(?:switched|migrated|moved|transitioned|upgraded|updated|downgraded)\s{1,3}(?:to|from)\b/i;

const STATE_UPDATE_OTHER_RE = new RegExp(
  [
    String.raw`\bchanged\s{1,3}from\b`,
    String.raw`\bno\s{1,3}longer\s{1,3}(?:use|using|work|working|live|living|have|do|doing|support|supporting)\b`,
    String.raw`\bstopped\s{1,3}(?:using|doing|taking|going)\b`,
    String.raw`\breplaced\s{1,3}[` + '`' + String.raw`'"a-zA-Z0-9_./-]{1,40}\s{1,3}with\b`,
    String.raw`\bnow\s{1,3}(?:i|we)\s{1,3}(?:use|live|work|run|prefer|have)\b`,
    String.raw`\b(?:i|we)\s{1,3}now\s{1,3}(?:use|live|work|run|prefer|have)\b`,
    String.raw`\bjust\s{1,3}started\s{1,3}(?:using|working|learning|taking|running)\b`,
  ].join('|'),
  'i'
);

const COMPLETED_ACTION_RE =
  /\b(?:i['’]ve|we['’]ve|(?:i|we)(?:\s{1,3}have)?)\s{1,3}(?:just\s{1,3}|finally\s{1,3}|recently\s{1,3})?(?:finished|completed|deployed|shipped|merged|implemented|fixed|resolved|published|bought|purchased|adopted|attended|visited|graduated)\b/i;

const PLANNED_ACTION_RE = new RegExp(
  [
    String.raw`\b(?:i['’]m|i\s{1,3}am|we['’]re|we\s{1,3}are|i|we)\s{1,3}(?:planning\s{1,3}to|plan\s{1,3}to|going\s{1,3}to|thinking\s{1,3}(?:of|about)|considering|hoping\s{1,3}to|about\s{1,3}to)\b`,
    String.raw`\b(?:need|needs)\s{1,3}to\s{1,3}(?:implement|fix|refactor|migrate|upgrade|buy|schedule|book)\b`,
  ].join('|'),
  'i'
);

const WANTS_PREFERENCE_RE =
  /\b(?:recommend\w{0,20}|suggest\w{0,20}|tips?|ideas?|advice|advis\w{0,20}|how\s{1,3}should\s{1,3}(?:i|we)|what\s{1,3}should\s{1,3}(?:i|we)|prefer\w{0,20}|favou?rites?|convention\w{0,20}|best\s{1,3}way\s{1,3}to|tailor\w{0,20})\b/i;

const WANTS_STATE_UPDATE_RE =
  /\b(?:current(?:ly)?|right\s{1,3}now|nowadays|these\s{1,3}days|latest|still\s{1,3}(?:use|using|on|at|with|in)|anymore|switched|migrated|moved|updated|upgraded)\b/i;

function isInterrogativeSentence(rawSentence: string): boolean {
  const cleaned = rawSentence.replace(LEADING_LIST_MARKER_RE, '').trim();
  if (!cleaned) return true;
  if (QUESTION_END_RE.test(cleaned)) return true;

  if (INTERROGATIVE_START_RE.test(cleaned)) {
    if (IMPERATIVE_DO_NOT_START_RE.test(cleaned)) {
      return false;
    }
    if (SUBORDINATE_WHEN_WHERE_RE.test(cleaned) && DECLARATIVE_AFTER_COMMA_RE.test(cleaned)) {
      return false;
    }
    return true;
  }

  return false;
}

function matchesUnconditioned(sentence: string, re: RegExp): boolean {
  const m = re.exec(sentence);
  if (!m) return false;
  const prefix = sentence.slice(Math.max(0, m.index - 16), m.index);
  return !CONDITIONAL_CLAUSE_PREFIX_RE.test(prefix);
}

function matchesPlannedAction(sentence: string): boolean {
  const m = PLANNED_ACTION_RE.exec(sentence);
  if (!m) return false;
  const prefix = sentence.slice(Math.max(0, m.index - 24), m.index);
  return !PLANNED_BLOCKED_PREFIX_RE.test(prefix);
}

function matchesStateUpdate(sentence: string): boolean {
  const m = STATE_UPDATE_SUBJECTLESS_RE.exec(sentence);
  if (m) {
    const prefix = sentence.slice(Math.max(0, m.index - 24), m.index);
    const hasFirstPersonSubject = /^(?:i|we|our\s{1,3}team)\s/i.test(m[0]);
    const blocked = hasFirstPersonSubject
      ? CONDITIONAL_CLAUSE_PREFIX_RE.test(prefix)
      : CONDITIONAL_OR_NEGATED_PREFIX_RE.test(prefix);
    if (!blocked) {
      return true;
    }
  }

  const pm = STATE_UPDATE_OTHER_RE.exec(sentence);
  if (!pm) return false;
  const prefix = sentence.slice(Math.max(0, pm.index - 24), pm.index);
  return !CONDITIONAL_OR_NEGATED_PREFIX_RE.test(prefix);
}

/**
 * Deterministically extracts linguistic signal tags (`preference`, `state_update`,
 * `completed_action`, `planned_action`) in canonical order.
 *
 * Anti-noise invariants:
 * - `'preference'` is extracted strictly from `kind === 'prompt'` (`input`) so
 *   assistant `response` turns suggesting options never pollute preference signals.
 * - `tool_call` outputs and verbose assistant essays are ignored; concise declarative
 *   summaries (`<= 400` chars) may emit non-preference action/state tags.
 * - Interrogative sentences (ending in `?` or starting with question auxiliaries)
 *   are skipped so questions asking about state/preferences are never tagged as assertions.
 */
export function extractSignalTags(obs: ExtractSignalTagsInput): SignalTag[] {
  if (!obs || typeof obs !== 'object') return [];
  const kind = typeof obs.kind === 'string' ? obs.kind : '';
  if (kind === 'tool_call') return [];

  const isPrompt = kind === 'prompt';
  let sourceText = '';

  if (isPrompt) {
    sourceText = typeof obs.input === 'string' ? obs.input : '';
  } else {
    const candidate =
      typeof obs.output === 'string' && obs.output.trim() !== ''
        ? obs.output
        : typeof obs.input === 'string'
          ? obs.input
          : '';
    if (!candidate) return [];
    // Only allow concise declarative summaries on non-prompt turns; skip verbose assistant essays
    if (candidate.length > MAX_CONCISE_SUMMARY_CHARS) return [];
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.length > MAX_CONCISE_SUMMARY_CHARS) return [];
    sourceText = trimmed;
  }

  if (!sourceText) return [];

  const bounded =
    sourceText.length > MAX_SIGNAL_SCAN_CHARS
      ? safeUtf16Slice(sourceText, 0, MAX_SIGNAL_SCAN_CHARS)
      : sourceText;

  const passages = splitIntoPassages(bounded);
  if (passages.length === 0) return [];

  const maxPassages = Math.min(passages.length, MAX_SIGNAL_SCAN_PASSAGES);
  const maxPossibleTags = isPrompt ? 4 : 3;
  const found = new Set<SignalTag>();

  for (let i = 0; i < maxPassages; i++) {
    const sentence = passages[i].text;
    // Every multi-word linguistic cue contains whitespace; skip whitespace-free hex/base64/token blobs in O(1)
    if (!sentence || (sentence.indexOf(' ') === -1 && sentence.indexOf('\t') === -1)) continue;
    if (isInterrogativeSentence(sentence)) continue;
    if (!isPrompt && ASSISTANT_META_CHATTER_RE.test(sentence)) continue;

    if (isPrompt && !found.has('preference') && matchesUnconditioned(sentence, PREFERENCE_COMBINED_RE)) {
      found.add('preference');
    }
    if (!found.has('state_update') && matchesStateUpdate(sentence)) {
      found.add('state_update');
    }
    if (!found.has('completed_action') && matchesUnconditioned(sentence, COMPLETED_ACTION_RE)) {
      found.add('completed_action');
    }
    if (!found.has('planned_action') && matchesPlannedAction(sentence)) {
      found.add('planned_action');
    }

    if (found.size >= maxPossibleTags) break;
  }

  if (found.size === 0) return [];
  return SIGNAL_TAG_ORDER.filter((tag) => found.has(tag));
}

/**
 * Detects whether a search query seeks recommendations/preferences (`wantsPreference`)
 * and/or current-state / state-transition facts (`wantsStateUpdate`).
 */
export function detectQuerySignalIntent(q: string): QuerySignalIntent {
  if (typeof q !== 'string' || q.length === 0) {
    return { wantsPreference: false, wantsStateUpdate: false };
  }
  const sample =
    q.length > MAX_QUERY_INTENT_SCAN_CHARS
      ? safeUtf16Slice(q, 0, MAX_QUERY_INTENT_SCAN_CHARS)
      : q;

  return {
    wantsPreference: WANTS_PREFERENCE_RE.test(sample),
    wantsStateUpdate: WANTS_STATE_UPDATE_RE.test(sample),
  };
}
