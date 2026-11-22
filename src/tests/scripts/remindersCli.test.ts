import fs from 'fs';
import path from 'path';
import { parseRemindersArgs, runRemindersCheck } from '../../cli';

describe('neuralbrain reminders CLI', () => {
  it('enforces Rule 2: cli.ts and plugin/hooks/*.js never import db.ts or sqlite', () => {
    const files = [
      path.resolve(__dirname, '../../cli.ts'),
      path.resolve(__dirname, '../../../plugin/hooks/sessionStart.js'),
      path.resolve(__dirname, '../../../plugin/hooks/postToolUse.js'),
      path.resolve(__dirname, '../../../plugin/hooks/sessionStop.js'),
    ];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).not.toMatch(/from\s+['"]\.\/lib\/(db|sqlite)['"]/);
      expect(content).not.toMatch(/require\(['"][^'"]*(lib\/db|lib\/sqlite|node:sqlite|better-sqlite3)/);
      expect(content).not.toMatch(/node:sqlite|better-sqlite3/);
    }
  });

  describe('parseRemindersArgs', () => {
    it('parses all flags including --json, --webhook, --project, --cooldown, --limit, --dry-run', () => {
      const parsed = parseRemindersArgs([
        '--json',
        '--webhook',
        'https://hooks.example.org/brain',
        '--project',
        'Acme/Socials',
        '--include-children',
        '--no-ancestors',
        '--no-global',
        '--cooldown',
        '30m',
        '--dry-run',
        '--limit',
        '15',
      ]);

      expect(parsed).toEqual({
        json: true,
        webhookUrl: 'https://hooks.example.org/brain',
        projectId: 'acme/socials',
        includeAncestors: false,
        includeChildren: true,
        includeGlobal: false,
        cooldownMs: 1_800_000,
        cooldown: '30m',
        dryRun: true,
        limit: 15,
      });
    });

    it('rejects invalid webhook URLs, invalid cooldown durations, and invalid limits', () => {
      expect(() => parseRemindersArgs(['--webhook', 'ftp://hooks.example.org'])).toThrow(/http:\/\/ or https:\/\//);
      expect(() => parseRemindersArgs(['--webhook', 'not-a-url'])).toThrow(/Invalid --webhook/);
      expect(() => parseRemindersArgs(['--cooldown', 'P1M'])).toThrow(/Invalid --cooldown/);
      expect(() => parseRemindersArgs(['--cooldown', 'bogus'])).toThrow(/Invalid --cooldown/);
      expect(() => parseRemindersArgs(['--limit', '0'])).toThrow(/Invalid --limit/);
      expect(() => parseRemindersArgs(['--unknown-flag'])).toThrow(/Unknown option/);
    });
  });

  describe('runRemindersCheck', () => {
    it('returns JSON output when --json is set and calls POST /actions/reminders/check over HTTP', async () => {
      const calls: Array<{ url: string; method: string; body: any; headers: any }> = [];
      const mockFetch = jest.fn(async (input: any, init?: any) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, method: init?.method || 'GET', body, headers: init?.headers });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            checked_at: '2026-11-22T09:00:00.000Z',
            reminders: [
              {
                id: 'act_1',
                title: 'Publish release notes',
                scope: 'project',
                project_id: 'acme/cogs',
                priority: 'high',
                due_at: '2026-11-22T08:00:00.000Z',
                overdue: true,
                match_tier: 'exact',
              },
            ],
            marked_count: 1,
          }),
        } as Response;
      });

      const result = await runRemindersCheck({
        json: true,
        projectId: 'acme/cogs',
        includeChildren: true,
        includeAncestors: false,
        includeGlobal: false,
        cooldown: '2h',
        limit: 10,
        apiUrl: 'http://127.0.0.1:3737',
        apiKey: 'test-key',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('http://127.0.0.1:3737/actions/reminders/check');
      expect(calls[0].method).toBe('POST');
      expect(calls[0].headers.Authorization).toBe('Bearer test-key');
      expect(calls[0].body).toEqual({
        project_id: 'acme/cogs',
        include_ancestors: false,
        include_children: true,
        include_global: false,
        cooldown_ms: 7_200_000,
        dry_run: false,
        limit: 10,
      });

      const parsedOut = JSON.parse(result.output);
      expect(parsedOut.checked_at).toBe('2026-11-22T09:00:00.000Z');
      expect(parsedOut.marked_count).toBe(1);
      expect(parsedOut.reminders).toHaveLength(1);
      expect(parsedOut.reminders[0].id).toBe('act_1');
    });

    it('delivers webhook payload with dry_run check and acks ONLY when webhook returns 2xx', async () => {
      const calls: Array<{ url: string; body: any; hasSignal: boolean }> = [];
      const mockFetch = jest.fn(async (input: any, init?: any) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, body, hasSignal: Boolean(init?.signal) });

        if (url === 'http://127.0.0.1:3737/actions/reminders/check') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              checked_at: '2026-11-22T09:00:00.000Z',
              reminders: [{ id: 'act_w1', title: 'Webhook due item' }, { id: 'act_w2', title: 'Item 2' }],
              marked_count: 0,
            }),
          } as Response;
        }
        if (url === 'https://hooks.example.org/notify') {
          return {
            ok: true,
            status: 202,
            json: async () => ({ received: true }),
          } as Response;
        }
        if (url === 'http://127.0.0.1:3737/actions/reminders/ack') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ updated: 2, reminded_at: '2026-11-22T09:00:01.000Z' }),
          } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      });

      const result = await runRemindersCheck({
        webhookUrl: 'https://hooks.example.org/notify',
        apiUrl: 'http://127.0.0.1:3737',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(calls).toHaveLength(3);
      expect(calls[0].url).toBe('http://127.0.0.1:3737/actions/reminders/check');
      expect(calls[0].body.dry_run).toBe(true);

      expect(calls[1].url).toBe('https://hooks.example.org/notify');
      expect(calls[1].hasSignal).toBe(true);
      expect(calls[1].body).toMatchObject({
        event: 'neuralbrain.reminders.due',
        checked_at: '2026-11-22T09:00:00.000Z',
        count: 2,
      });
      expect(calls[1].body.reminders).toHaveLength(2);

      expect(calls[2].url).toBe('http://127.0.0.1:3737/actions/reminders/ack');
      expect(calls[2].body).toEqual({ ids: ['act_w1', 'act_w2'] });

      expect(result.webhook_delivered).toBe(true);
      expect(result.acked_count).toBe(2);
      expect(result.marked_count).toBe(2);
    });

    it('does NOT ack reminders when webhook returns non-2xx', async () => {
      const calls: string[] = [];
      const mockFetch = jest.fn(async (input: any) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/actions/reminders/check')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              checked_at: '2026-11-22T09:00:00.000Z',
              reminders: [{ id: 'act_fail_1', title: 'Should not ack' }],
              marked_count: 0,
            }),
          } as Response;
        }
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: 'downstream down' }),
        } as Response;
      });

      await expect(
        runRemindersCheck({
          webhookUrl: 'https://hooks.example.org/fail',
          apiUrl: 'http://127.0.0.1:3737',
          fetchFn: mockFetch as unknown as typeof fetch,
        })
      ).rejects.toThrow(/Webhook delivery failed with status 500/);

      expect(calls).toEqual([
        'http://127.0.0.1:3737/actions/reminders/check',
        'https://hooks.example.org/fail',
      ]);
      expect(calls.some((u) => u.endsWith('/ack'))).toBe(false);
    });

    it('skips ack when --dry-run is set even with a 2xx webhook', async () => {
      const calls: string[] = [];
      const mockFetch = jest.fn(async (input: any) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith('/actions/reminders/check')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              checked_at: '2026-11-22T09:00:00.000Z',
              reminders: [{ id: 'act_dry_1', title: 'Dry run reminder' }],
              marked_count: 0,
            }),
          } as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      });

      const result = await runRemindersCheck({
        webhookUrl: 'https://hooks.example.org/dry',
        dryRun: true,
        apiUrl: 'http://127.0.0.1:3737',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(calls).toEqual([
        'http://127.0.0.1:3737/actions/reminders/check',
        'https://hooks.example.org/dry',
      ]);
      expect(result.marked_count).toBe(0);
      expect(result.webhook_delivered).toBe(true);
    });

    it('rejects invalid webhook URLs and invalid cooldown in runRemindersCheck', async () => {
      await expect(
        runRemindersCheck({ webhookUrl: 'javascript:alert(1)', apiUrl: 'http://127.0.0.1:3737' })
      ).rejects.toThrow(/http:\/\/ or https:\/\//);

      await expect(
        runRemindersCheck({ cooldown: 'invalid-dur', apiUrl: 'http://127.0.0.1:3737' })
      ).rejects.toThrow(/Invalid --cooldown/);
    });
  });
});
