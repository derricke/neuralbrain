import {
  computeInformationDensity,
  condenseObservation,
  condenseText,
  extractQueryFocusedSnippet,
  isBoilerplatePassage,
  parseQuerySignals,
  splitIntoPassages,
} from '../../lib/condenser';

describe('condenser: deterministic passage splitter, extractive condenser, and query-focused snippets', () => {
  describe('splitIntoPassages', () => {
    it('preserves exact character offsets without breaking decimals, paths, URLs, versions, or abbreviations', () => {
      const text = [
        '1. Dr. Smith and Mrs. Jones compared v1.2.3 vs. v2.0.0 in src/learning/search.ts (e.g. threshold 3.14, i.e. pi, etc.).',
        'Check https://127.0.0.1:3737/api/v1/health.json?timeout=2.5 for status! Everything passed cleanly.',
      ].join('\n\n');

      const passages = splitIntoPassages(text);
      expect(passages.length).toBe(3);

      // Every span must slice back to its exact text from the original string
      for (const span of passages) {
        expect(text.slice(span.start, span.end)).toBe(span.text);
      }

      // Sentence 1 kept intact despite 1., Dr., Mrs., v1.2.3, vs., v2.0.0, src/learning/search.ts, e.g., 3.14, i.e., etc.
      expect(passages[0].text).toContain('1. Dr. Smith and Mrs. Jones');
      expect(passages[0].text).toContain('v1.2.3 vs. v2.0.0');
      expect(passages[0].text).toContain('src/learning/search.ts');
      expect(passages[0].text).toContain('3.14, i.e. pi, etc.).');

      // Sentence 2 & 3 split cleanly at '!' without breaking URL dots/query params
      expect(passages[1].text).toBe(
        'Check https://127.0.0.1:3737/api/v1/health.json?timeout=2.5 for status!'
      );
      expect(passages[2].text).toBe('Everything passed cleanly.');
    });

    it('sub-chunks ultra-long single-line blobs cleanly while maintaining exact character offsets', () => {
      const longSingleLine = `${'alpha beta gamma delta '.repeat(200)}target_port=6432 ${'omega sigma '.repeat(80)}`;
      expect(longSingleLine.length).toBeGreaterThan(5000);

      const passages = splitIntoPassages(longSingleLine);
      expect(passages.length).toBeGreaterThan(10);
      for (let i = 0; i < passages.length; i++) {
        const p = passages[i];
        expect(longSingleLine.slice(p.start, p.end)).toBe(p.text);
        expect(p.text.length).toBeLessThanOrEqual(320);
        if (i > 0) {
          expect(p.start).toBeGreaterThanOrEqual(passages[i - 1].end);
        }
      }
      expect(passages.some((p) => p.text.includes('target_port=6432'))).toBe(true);
    });
  });

  describe('condenseText & condenseObservation', () => {
    it('strips conversational boilerplate and markdown dividers while deduplicating near-identical lines', () => {
      expect(isBoilerplatePassage("Sure, I'd be happy to help!")).toBe(true);
      expect(isBoilerplatePassage('Certainly! Here is a comprehensive list of suggestions:')).toBe(true);
      expect(isBoilerplatePassage('I hope this helps!')).toBe(true);
      expect(isBoilerplatePassage('Feel free to ask if you have any questions.')).toBe(true);
      expect(isBoilerplatePassage('Let me know if you need anything else!')).toBe(true);
      expect(isBoilerplatePassage('---')).toBe(true);
      expect(isBoilerplatePassage('***')).toBe(true);
      expect(isBoilerplatePassage('PostgreSQL runs on port 5432 in src/lib/db.ts.')).toBe(false);

      const chatty = [
        "Sure, I'd be happy to help!",
        '---',
        'We switched the Redis cache TTL to 900s in `src/cache/redisClient.ts`.',
        'We switched the Redis cache TTL to 900s in src/cache/redisClient.ts!',
        '***',
        'I hope this helps!',
        'Feel free to ask if you have any questions.',
        'Let me know if you need anything else!',
      ].join('\n');

      const condensed = condenseText(chatty, { kind: 'response' });
      expect(condensed).toContain('900s');
      expect(condensed).toContain('src/cache/redisClient.ts');
      expect(condensed).not.toContain('happy to help');
      expect(condensed).not.toContain('hope this helps');
      expect(condensed).not.toContain('Feel free to ask');
      expect(condensed).not.toContain('anything else');
      expect(condensed).not.toContain('---');
      // Near-duplicate second line should be deduplicated (900s appears once)
      expect(condensed.match(/900s/g)?.length).toBe(1);
    });

    it('preserves concise <= 500 char user prompts 100% verbatim while compressing verbose assistant lists by >= 75%', () => {
      const concisePrompt =
        'I prefer 2-space indentation, strict TypeScript checks, and running PostgreSQL 16 on port 5433. Never use var.';
      expect(concisePrompt.length).toBeLessThan(500);

      const condensedPrompt = condenseObservation({
        kind: 'prompt',
        input: concisePrompt,
      });
      expect(condensedPrompt).toBe(concisePrompt);

      const verboseAssistantEssay = [
        "Certainly! I'd be happy to help you improve your workflow.",
        'Here is a detailed list of general recommendations you can consider:',
        '---',
        '1. **Plan Your Schedule Carefully**: Taking time to plan your schedule every morning helps maintain steady focus throughout the day and keeps priorities aligned.',
        '2. **Communicate Regularly With Teammates**: Sharing clear updates with teammates ensures everyone stays aligned on shared goals and avoids misunderstandings.',
        '3. **Take Mindful Breaks Between Tasks**: Stepping away briefly between long tasks prevents fatigue and keeps your mind fresh during complex work.',
        '4. **Organize Your Workspace Cleanly**: Keeping a tidy desk and organized digital folders reduces distractions when switching between projects.',
        '5. **Review Weekly Goals Every Friday**: Reflecting on completed milestones helps refine your approach for the upcoming week and celebrates progress.',
        '6. **Break Large Initiatives Into Smaller Steps**: Dividing big initiatives into manageable tasks makes steady progress much easier to track.',
        '7. **Configure Connection Pool Timeout**: Set `POOL_IDLE_TIMEOUT_MS=45000` in `src/config/database.ts` to prevent `ECONNRESET` drops under load.',
        '8. **Document Team Decisions Promptly**: Writing brief notes after meetings preserves context for future contributors who join later.',
        '9. **Prioritize High-Impact Work First**: Tackling your hardest task early in the morning builds momentum for the rest of the afternoon.',
        '10. **Minimize Unnecessary Context Switching**: Grouping similar errands together protects deep focus blocks from constant interruptions.',
        '11. **Maintain Consistent Sleep Habits**: Getting enough rest every night supports clear thinking and sustainable long-term productivity.',
        '12. **Celebrate Small Daily Wins**: Recognizing incremental milestones keeps motivation steady across multi-week engineering sprints.',
        '---',
        'I hope this helps! Let me know if you need anything else!',
      ].join('\n');

      expect(verboseAssistantEssay.length).toBeGreaterThan(1800);

      const condensedEssay = condenseObservation({
        kind: 'response',
        output: verboseAssistantEssay,
      });
      expect(condensedEssay).not.toBeNull();
      // >= 75% char/token reduction (~250-450 chars from >1800 chars)
      expect(condensedEssay!.length).toBeLessThanOrEqual(verboseAssistantEssay.length * 0.25);
      expect(condensedEssay!.length).toBeLessThanOrEqual(450);
      // High-signal item #7 with concrete identifier/number/file path is preserved
      expect(condensedEssay).toContain('POOL_IDLE_TIMEOUT_MS=45000');
      expect(condensedEssay).toContain('src/config/database.ts');
      expect(condensedEssay).not.toContain('happy to help');
      expect(condensedEssay).not.toContain('anything else');
    });
  });

  describe('extractQueryFocusedSnippet', () => {
    it('rescues tail answers at char 4,200+ of a 5,000+ char text with [...] within maxChars', () => {
      const fillerSentence =
        'Routine build step compiled module cleanly with zero warnings during standard verification pass. ';
      const prefix = `Build started for release pipeline.\n${fillerSentence.repeat(44)}`;
      expect(prefix.length).toBeGreaterThan(4200);

      const tailAnswer =
        'CRITICAL ROOT CAUSE: Migration failed with SqliteError code 787 on `summary_sources` because foreign_keys pragma was disabled on pool init.';
      const suffix = `\n${fillerSentence.repeat(8)}`;
      const fullText = `${prefix}\n${tailAnswer}${suffix}`;
      expect(fullText.length).toBeGreaterThan(5000);

      const snippet = extractQueryFocusedSnippet(
        fullText,
        'SqliteError code 787 summary_sources foreign_keys',
        { maxChars: 600 }
      );

      expect(snippet.length).toBeLessThanOrEqual(600);
      expect(snippet).toContain('SqliteError code 787');
      expect(snippet).toContain('summary_sources');
      expect(snippet).toContain('[...]');
    });

    it('falls back to condenseText when zero passages match any query token', () => {
      const verbose = `${'Generic background commentary with nothing unusual happening today. '.repeat(20)}\nDeployed v3.4.1 to staging cluster in 42s via deploy.sh.`;
      const fallback = extractQueryFocusedSnippet(verbose, 'quantum entanglement superconductor', {
        maxChars: 300,
      });
      expect(fallback.length).toBeLessThanOrEqual(300);
      expect(fallback).toContain('v3.4.1');
    });
  });

  describe('computeInformationDensity', () => {
    it('scores concise technical/factual notes significantly higher than verbose generic bullet lists', () => {
      const highSignal =
        'Fixed TypeError in src/learning/search.ts:412 by setting RRF_K=60 and timeout=2500ms.';
      const genericEssay = [
        "Sure! Here's a helpful list of general tips to keep in mind:",
        '1. **Stay Organized**: Staying organized helps you keep track of everything you need to do.',
        '2. **Stay Consistent**: Being consistent is a great way to make steady progress every day.',
        '3. **Stay Positive**: Keeping a positive attitude helps you overcome everyday challenges.',
        '4. **Ask For Help**: Asking for help whenever you need it makes collaboration smoother.',
        'I hope this helps! Feel free to ask if you have any questions.',
      ].join('\n');

      const denseMetrics = computeInformationDensity(highSignal);
      const bloatMetrics = computeInformationDensity(genericEssay);

      expect(denseMetrics.density).toBeGreaterThan(bloatMetrics.density + 0.25);
      expect(denseMetrics.uniqueContentRatio).toBeGreaterThan(bloatMetrics.uniqueContentRatio);
      expect(bloatMetrics.boilerplateListRatio).toBeGreaterThan(0.5);
      expect(denseMetrics.boilerplateListRatio).toBe(0);
    });
  });

  describe('adversarial, ReDoS, Unicode/surrogate, and null/empty boundary guards', () => {
    it('completes under 50ms per call on 50KB pathological single-line and multi-line inputs (no ReDoS or O(N^2) blowups)', () => {
      const payloads: Array<[string, string]> = [
        ['50k_lowercase_run', 'a'.repeat(50_000)],
        ['50k_dots', '.'.repeat(50_000)],
        ['50k_spaces', ' '.repeat(50_000)],
        ['50k_alternating_dot', 'a.'.repeat(25_000)],
        ['50k_nested_punct', '(!?.,;:)'.repeat(6_250)],
        ['50k_sure_spaces_mismatch', `Sure${' '.repeat(50_000)}x`],
        ['50k_underscore_run', 'a_'.repeat(25_000)],
        [
          '50k_multiline_tool_dump',
          Array.from({ length: 1_400 }, (_, i) => `src/mod_${i}.ts:10: const v_${i} = ${i};`).join(
            '\n'
          ),
        ],
      ];

      for (const [label, payload] of payloads) {
        const measure = (fnName: string, fn: () => unknown) => {
          let bestElapsed = Number.POSITIVE_INFINITY;
          for (let attempt = 0; attempt < 3; attempt++) {
            const start = performance.now();
            fn();
            const dt = performance.now() - start;
            if (dt < bestElapsed) bestElapsed = dt;
          }
          expect({ label, fnName, elapsedBelow50ms: bestElapsed < 50, elapsedMs: Math.round(bestElapsed) }).toEqual(
            expect.objectContaining({ label, fnName, elapsedBelow50ms: true })
          );
        };

        measure('splitIntoPassages', () => splitIntoPassages(payload));
        measure('isBoilerplatePassage', () => isBoilerplatePassage(payload));
        measure('computeInformationDensity', () => computeInformationDensity(payload));
        measure('condenseText', () => condenseText(payload, { kind: 'response' }));
        measure('condenseObservation', () =>
          condenseObservation({ kind: 'tool_call', toolName: 'Bash', output: payload })
        );
        measure('extractQueryFocusedSnippet', () =>
          extractQueryFocusedSnippet(payload, 'target_symbol_999', { maxChars: 600 })
        );
        measure('parseQuerySignals', () => parseQuerySignals(payload));
      }
    });

    it('preserves UTF-16 surrogate pairs (no lone surrogates) and rescues CJK/Unicode query matches', () => {
      const hasLoneSurrogate = (s: string): boolean =>
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

      // Odd offset 'x' + 300 astral emojis forces chunk boundaries directly onto surrogate pairs
      const emojiStream = `x${'🚀'.repeat(300)}`;
      const spans = splitIntoPassages(emojiStream);
      expect(spans.length).toBeGreaterThan(1);
      for (const span of spans) {
        expect(hasLoneSurrogate(span.text)).toBe(false);
        expect(emojiStream.slice(span.start, span.end)).toBe(span.text);
      }

      const condensedEmoji = condenseText(emojiStream, { maxChars: 55 });
      expect(hasLoneSurrogate(condensedEmoji)).toBe(false);
      expect(condensedEmoji.length).toBeLessThanOrEqual(55);

      const emojiWithMatch = `${emojiStream} target_key_alpha ${'🔥'.repeat(200)}`;
      const emojiSnippet = extractQueryFocusedSnippet(emojiWithMatch, 'target_key_alpha', {
        maxChars: 65,
      });
      expect(hasLoneSurrogate(emojiSnippet)).toBe(false);
      expect(emojiSnippet).toContain('target_key_alpha');
      expect(emojiSnippet.length).toBeLessThanOrEqual(65);

      // CJK tail match without ASCII digits + deduplication of repeated CJK lines
      const cjkFiller = '通常ログ出力が継続しています。\n';
      const cjkTail = '致命的エラー: データベース接続タイムアウトが発生しました。';
      const cjkDoc = `${cjkFiller.repeat(260)}${cjkTail}\n${cjkFiller.repeat(40)}`;
      const cjkSnippet = extractQueryFocusedSnippet(cjkDoc, 'データベース タイムアウト', {
        maxChars: 300,
      });
      expect(cjkSnippet.length).toBeLessThanOrEqual(300);
      expect(cjkSnippet).toContain('データベース接続タイムアウト');

      // Accented Latin query match
      const accentedDoc = `${'Routine deployment step completed cleanly. '.repeat(120)}Configuración crítica en München actualizada exitosamente.`;
      const accentedSnippet = extractQueryFocusedSnippet(accentedDoc, 'München Configuración', {
        maxChars: 240,
      });
      expect(accentedSnippet).toContain('München');
      expect(accentedSnippet.length).toBeLessThanOrEqual(240);
    });

    it('handles null, undefined, empty, whitespace-only, boilerplate-only, and pure-stopword inputs safely', () => {
      expect(condenseObservation({ kind: 'prompt', input: null, output: null })).toBeNull();
      expect(condenseObservation({ kind: 'response', input: '   ', output: '\n\t  ' })).toBeNull();
      expect(
        condenseObservation({
          kind: 'tool_call',
          toolName: 'Read',
          filePath: 'src/app.ts',
          input: null,
          output: '',
        })
      ).toBe('[Read src/app.ts]');

      expect(condenseText('', { kind: 'response' })).toBe('');
      expect(condenseText('   \n\t  ', { kind: 'prompt' })).toBe('');

      const onlyBoilerplate = "Sure, I'd be happy to help!\n---\nI hope this helps!";
      const condensedBoiler = condenseText(onlyBoilerplate, { kind: 'response', maxChars: 80 });
      expect(condensedBoiler.length).toBeLessThanOrEqual(80);

      expect(extractQueryFocusedSnippet('', 'anything')).toBe('');
      const longDoc = `${'Alpha service started cleanly on worker node. '.repeat(40)}Beta worker listening on port 7070.`;
      const stopwordOnlySnippet = extractQueryFocusedSnippet(longDoc, 'the and or to of in', {
        maxChars: 180,
      });
      expect(stopwordOnlySnippet.length).toBeLessThanOrEqual(180);
      expect(stopwordOnlySnippet.length).toBeGreaterThan(0);
    });
  });
});
