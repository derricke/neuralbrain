import { describe, it, expect } from '@jest/globals';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  runPostToolUse,
  shouldSkipTool,
  formatObservationInput,
  formatObservationOutput,
  SUCCESS_OUTPUT_PREVIEW_CHARS,
  FAILURE_OUTPUT_TAIL_CHARS,
  MAX_INPUT_CHARS,
} = require('../../../plugin/hooks/postToolUse');

describe('postToolUse hook output bounding', () => {
  it('preserves short successful outputs unchanged', () => {
    expect(formatObservationOutput('ok: 3 files updated', false)).toBe('ok: 3 files updated');
  });

  it('truncates long successful outputs to a short head preview', () => {
    const longOutput = 'HEAD_START_' + 'a'.repeat(5000) + '_TAIL_END';
    const result = formatObservationOutput(longOutput, false);

    expect(result.startsWith('HEAD_START_')).toBe(true);
    expect(result).not.toContain('_TAIL_END');
    expect(result).toContain(`... [truncated ${longOutput.length - SUCCESS_OUTPUT_PREVIEW_CHARS} chars]`);
    expect(result.length).toBeLessThan(SUCCESS_OUTPUT_PREVIEW_CHARS + 64);
  });

  it('keeps the tail of long failed outputs so error_verbatim stays intact', () => {
    const longLog = 'NOISY_STDOUT_'.repeat(500) + 'TypeError: Cannot read properties of undefined';
    const result = formatObservationOutput(longLog, true);

    expect(result).toContain('TypeError: Cannot read properties of undefined');
    expect(result).toContain(`...[truncated ${longLog.length - FAILURE_OUTPUT_TAIL_CHARS} chars]...`);
    expect(result).not.toMatch(/^NOISY_STDOUT_/);
  });

  it('appends explicit error string when failed output does not already contain it', () => {
    const result = formatObservationOutput('partial stdout', true, 'ENOENT: no such file');
    expect(result).toContain('partial stdout');
    expect(result).toContain('ENOENT: no such file');
  });

  it('sends bounded output through runPostToolUse for success and failure', async () => {
    const captured: Array<{ body: any }> = [];
    const mockFetch = async (_url: string, init: any) => {
      captured.push({ body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    };

    const bigSuccess = 'S'.repeat(4000);
    await runPostToolUse(
      {
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/big.txt' },
        tool_response: bigSuccess,
        session_id: 'sess-1',
      },
      { apiUrl: 'http://127.0.0.1:3737', projectId: 'neuralbrain', fetchFn: mockFetch }
    );

    const bigFailure = 'B'.repeat(4000) + 'ERR_OOM_TAIL';
    await runPostToolUse(
      {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: bigFailure,
        failed: true,
        session_id: 'sess-1',
      },
      { apiUrl: 'http://127.0.0.1:3737', projectId: 'neuralbrain', fetchFn: mockFetch }
    );

    expect(captured).toHaveLength(2);
    expect(captured[0].body.failed).toBe(0);
    expect(captured[0].body.output.length).toBeLessThan(350);
    expect(captured[1].body.failed).toBe(1);
    expect(captured[1].body.output).toContain('ERR_OOM_TAIL');
    expect(captured[1].body.output.length).toBeLessThan(FAILURE_OUTPUT_TAIL_CHARS + 64);
  });

  it('skips brain_*, memory_*, and noisy bookkeeping tools', () => {
    expect(shouldSkipTool('brain_search')).toBe(true);
    expect(shouldSkipTool('mcp__agentmemory__memory_recall')).toBe(true);
    expect(shouldSkipTool('TodoWrite')).toBe(true);
    expect(shouldSkipTool('TaskList')).toBe(true);
    expect(shouldSkipTool('Bash')).toBe(false);
    expect(shouldSkipTool('Read')).toBe(false);
  });

  it('extracts only the command and strips heredocs for shell tools', () => {
    const formatted = formatObservationInput('Bash', {
      command: "cat <<'EOF' > /tmp/foo.txt\nline1\nline2\nEOF\necho done",
      description: 'write a temp file',
      timeout: 5000,
    });

    const parsed = JSON.parse(formatted);
    expect(Object.keys(parsed)).toEqual(['command']);
    expect(parsed.command).toContain('[heredoc EOF omitted]');
    expect(parsed.command).toContain('echo done');
    expect(parsed.command).not.toContain('line1');
  });

  it('bounds large Write/Edit inputs and redacts secrets in both input and output', async () => {
    const captured: Array<{ body: any }> = [];
    const mockFetch = async (_url: string, init: any) => {
      captured.push({ body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    };

    await runPostToolUse(
      {
        tool_name: 'Write',
        tool_input: {
          file_path: '/tmp/config.ts',
          content: 'const k = "sk-proj-abcdefghijklmnopqrstuvwxyz1234";\n' + 'x'.repeat(5000),
        },
        tool_response: 'Wrote file with token ghp_1234567890abcdefghijklmnopqrstuvwx',
        session_id: 'sess-2',
      },
      { apiUrl: 'http://127.0.0.1:3737', projectId: 'neuralbrain', fetchFn: mockFetch }
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].body.input.length).toBeLessThan(MAX_INPUT_CHARS + 64);
    expect(captured[0].body.input).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz1234');
    expect(captured[0].body.input).toContain('[REDACTED_API_KEY]');
    expect(captured[0].body.output).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwx');
    expect(captured[0].body.output).toContain('[REDACTED_TOKEN]');
  });
});
