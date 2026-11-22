import fs from 'fs';
import os from 'os';
import path from 'path';
import { createBrainMcpHandlers } from '../../mcp/server';
import { getBrainHomeDir, getBrainEnvPath, loadBrainEnv } from '../../lib/brainHome';

// CommonJS hook modules
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sessionStartHook = require('../../../plugin/hooks/sessionStart.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sessionStopHook = require('../../../plugin/hooks/sessionStop.js');

describe('Phase 2: Cross-Agent Handoff, MCP Action Tools, Hooks, and BRAIN_HOME', () => {
  const originalEnv = { ...process.env };
  let tempDirs: string[] = [];

  function makeTempBrainHome(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-home-qa-'));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'none';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  describe('createBrainMcpHandlers', () => {
    it('brainActionAdd, brainActionList, brainActionUpdate, and brainSave with session_id issue expected REST requests', async () => {
      const calls: Array<{ url: string; method: string; body?: any; headers: any }> = [];

      const mockFetch = jest.fn(async (input: any, init?: any) => {
        const url = String(input);
        const method = init?.method || 'GET';
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body, headers: init?.headers });

        if (method === 'POST' && url.endsWith('/actions')) {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              action: { id: 'act_mcp_1', ...body, status: body.status || 'ready' },
            }),
          } as Response;
        }
        if (method === 'GET' && url.includes('/actions')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              actions: [{ id: 'act_mcp_1', title: 'Handoff task', status: 'ready' }],
            }),
          } as Response;
        }
        if (method === 'PATCH' && url.includes('/actions/act_mcp_1')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              action: { id: 'act_mcp_1', ...body },
            }),
          } as Response;
        }
        if (method === 'POST' && url.endsWith('/notes')) {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              note: { id: 'note_mcp_1', ...body },
            }),
          } as Response;
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: 'not found' }),
        } as Response;
      });

      const handlers = createBrainMcpHandlers({
        apiBaseUrl: 'http://127.0.0.1:3999',
        apiKey: 'mcp-secret-key',
        fetchFn: mockFetch as unknown as typeof fetch,
        defaultProjectId: 'neuralbrain',
      });

      // 1. brainActionAdd
      const addRes = await handlers.brainActionAdd({
        title: 'Finish cross-agent handoff tests',
        description: 'Verify session_id provenance',
        scope: 'project',
        session_id: 'sess_mcp_1',
        status: 'ready',
        files: ['src/tests/hooks/crossAgentHandoff.test.ts'],
      });
      expect(addRes.isError).toBeUndefined();
      expect(JSON.parse(addRes.content[0].text).action.id).toBe('act_mcp_1');
      expect(calls[0].url).toBe('http://127.0.0.1:3999/actions');
      expect(calls[0].method).toBe('POST');
      expect(calls[0].headers['Authorization']).toBe('Bearer mcp-secret-key');
      expect(calls[0].body).toMatchObject({
        title: 'Finish cross-agent handoff tests',
        scope: 'project',
        project_id: 'neuralbrain',
        session_id: 'sess_mcp_1',
        status: 'ready',
      });

      // 2. brainActionList
      const listRes = await handlers.brainActionList({
        status: 'ready',
        include_global: true,
        limit: 10,
      });
      expect(listRes.isError).toBeUndefined();
      expect(calls[1].method).toBe('GET');
      expect(calls[1].url).toContain('/actions?');
      expect(calls[1].url).toContain('project_id=neuralbrain');
      expect(calls[1].url).toContain('status=ready');
      expect(calls[1].url).toContain('include_global=true');
      expect(calls[1].url).toContain('limit=10');

      // 3. brainActionUpdate
      const updateRes = await handlers.brainActionUpdate({
        id: 'act_mcp_1',
        status: 'done',
        resolved_by_session_id: 'sess_mcp_2',
      });
      expect(updateRes.isError).toBeUndefined();
      expect(calls[2].method).toBe('PATCH');
      expect(calls[2].url).toBe('http://127.0.0.1:3999/actions/act_mcp_1');
      expect(calls[2].body).toEqual({
        status: 'done',
        resolved_by_session_id: 'sess_mcp_2',
      });

      // 4. brainSave with type: 'lesson' and session_id
      const saveRes = await handlers.brainSave({
        type: 'lesson',
        title: 'Always pass session_id',
        content: 'Links notes to the producing session for provenance.',
        scope: 'project',
        session_id: 'sess_mcp_1',
        concepts: ['provenance', 'sessions'],
      });
      expect(saveRes.isError).toBeUndefined();
      expect(calls[3].method).toBe('POST');
      expect(calls[3].url).toBe('http://127.0.0.1:3999/notes');
      expect(calls[3].body.type).toBe('lesson');
      expect(calls[3].body.session_id).toBe('sess_mcp_1');
      expect(calls[3].body.project_id).toBe('neuralbrain');
    });

    it('brainSessions (list, get, replay), brainSessionEnd, and brainGraph issue expected REST requests', async () => {
      const calls: Array<{ url: string; method: string; body?: any; headers: any }> = [];

      const mockFetch = jest.fn(async (input: any, init?: any) => {
        const url = String(input);
        const method = init?.method || 'GET';
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body, headers: init?.headers });

        if (method === 'GET' && url.includes('/sessions/sess_123/replay')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ session: { id: 'sess_123' }, timeline: [] }),
          } as Response;
        }
        if (method === 'GET' && url.includes('/sessions/sess_123')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ session: { id: 'sess_123', status: 'completed' } }),
          } as Response;
        }
        if (method === 'GET' && url.includes('/sessions')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ sessions: [{ id: 'sess_123' }] }),
          } as Response;
        }
        if (method === 'POST' && url.endsWith('/sessions/sess_123/end')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ session: { id: 'sess_123', ...body } }),
          } as Response;
        }
        if (method === 'GET' && url.includes('/graph')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ nodes: [{ id: 'n1' }], edges: [] }),
          } as Response;
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: 'not found' }),
        } as Response;
      });

      const handlers = createBrainMcpHandlers({
        apiBaseUrl: 'http://127.0.0.1:3999',
        apiKey: 'mcp-secret-key',
        fetchFn: mockFetch as unknown as typeof fetch,
        defaultProjectId: 'neuralbrain',
      });

      // 1. brainSessions mode=list
      const listRes = await handlers.brainSessions({
        mode: 'list',
        status: 'completed',
        agent_name: 'claude',
        limit: 5,
      });
      expect(listRes.isError).toBeUndefined();
      expect(calls[0].method).toBe('GET');
      expect(calls[0].url).toContain('http://127.0.0.1:3999/sessions?');
      expect(calls[0].url).toContain('project_id=neuralbrain');
      expect(calls[0].url).toContain('status=completed');
      expect(calls[0].url).toContain('agent_name=claude');
      expect(calls[0].url).toContain('limit=5');
      expect(calls[0].headers['Authorization']).toBe('Bearer mcp-secret-key');

      // 2. brainSessions mode=get
      const getRes = await handlers.brainSessions({
        mode: 'get',
        session_id: 'sess_123',
      });
      expect(getRes.isError).toBeUndefined();
      expect(calls[1].method).toBe('GET');
      expect(calls[1].url).toBe('http://127.0.0.1:3999/sessions/sess_123');

      // 3. brainSessions mode=replay
      const replayRes = await handlers.brainSessions({
        mode: 'replay',
        session_id: 'sess_123',
      });
      expect(replayRes.isError).toBeUndefined();
      expect(calls[2].method).toBe('GET');
      expect(calls[2].url).toBe('http://127.0.0.1:3999/sessions/sess_123/replay');

      // 4. brainSessions mode=get without session_id returns SCHEMA_INVALID error
      const invalidRes = await handlers.brainSessions({ mode: 'get' });
      expect(invalidRes.isError).toBe(true);
      expect(JSON.parse(invalidRes.content[0].text).error.code).toBe('SCHEMA_INVALID');

      // 5. brainSessionEnd
      const endRes = await handlers.brainSessionEnd({
        session_id: 'sess_123',
        status: 'paused',
        summary: 'Handoff to next agent',
        files_touched: ['src/mcp/server.ts'],
        handoff_summary_id: 'sum_1',
      });
      expect(endRes.isError).toBeUndefined();
      expect(calls[3].method).toBe('POST');
      expect(calls[3].url).toBe('http://127.0.0.1:3999/sessions/sess_123/end');
      expect(calls[3].body).toEqual({
        status: 'paused',
        summary: 'Handoff to next agent',
        files_touched: ['src/mcp/server.ts'],
        handoff_summary_id: 'sum_1',
      });

      // 6. brainGraph
      const graphRes = await handlers.brainGraph({
        scope: 'project',
        limit: 25,
      });
      expect(graphRes.isError).toBeUndefined();
      expect(calls[4].method).toBe('GET');
      expect(calls[4].url).toContain('http://127.0.0.1:3999/graph?');
      expect(calls[4].url).toContain('project_id=neuralbrain');
      expect(calls[4].url).toContain('scope=project');
      expect(calls[4].url).toContain('limit=25');
    });
  });

  describe('plugin/hooks/sessionStart.js', () => {
    it('calls POST /sessions/start and GET /inject, formatting READY NEXT ACTIONS, LESSONS, LAST SESSION SUMMARY, and CURATED MEMORIES', async () => {
      const requests: Array<{ url: string; method: string; body?: any }> = [];

      const mockFetch = async (url: string, init: any = {}) => {
        const method = init.method || 'GET';
        const body = init.body ? JSON.parse(init.body) : undefined;
        requests.push({ url, method, body });

        if (url.endsWith('/sessions/start')) {
          return {
            ok: true,
            status: 201,
            json: async () => ({ session: { id: body.id || 'sess_auto' } }),
          };
        }

        if (url.includes('/inject?')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ready_actions: [
                {
                  id: 'act_1',
                  priority: 'high',
                  status: 'ready',
                  title: 'Run full jest suite',
                  description: 'Verify zero regressions',
                },
              ],
              formatted_warnings: 'CRITICAL WARNINGS:\n- Avoid silent fallbacks',
              consolidation_warning:
                "CONSOLIDATION REMINDER: 3 un-consolidated session(s) (121 observations) for project 'neuralbrain' (last consolidated: never).",
              lessons: [
                {
                  title: 'Test isolation',
                  content: 'Always use :memory: SQLite in tests',
                },
              ],
              latest_session_summary: {
                summary: 'Previous session completed Phase 1 schema migrations.',
              },
              notes: [
                {
                  type: 'architecture',
                  title: 'Single writer',
                  content: 'Only the brain service writes to SQLite.',
                },
              ],
            }),
          };
        }

        return { ok: false, status: 404, json: async () => ({}) };
      };

      const result = await sessionStartHook.runSessionStart(
        {
          session_id: 'sess-hook-start-1',
          agent: 'antigravity',
          cwd: '/tmp/neuralbrain',
        },
        {
          apiUrl: 'http://127.0.0.1:3000',
          apiKey: 'hook-key',
          projectId: 'neuralbrain',
          fetchFn: mockFetch,
        }
      );

      expect(requests).toHaveLength(2);
      expect(requests[0].method).toBe('POST');
      expect(requests[0].url).toBe('http://127.0.0.1:3000/sessions/start');
      expect(requests[0].body).toMatchObject({
        id: 'sess-hook-start-1',
        project_id: 'neuralbrain',
        scope: 'project',
        agent_name: 'antigravity',
      });

      expect(requests[1].method).toBe('GET');
      expect(requests[1].url).toBe(
        'http://127.0.0.1:3000/inject?project_id=neuralbrain&limit=5'
      );

      const sysMsg = result.hookSpecificOutput?.systemMessage;
      expect(sysMsg).toBeDefined();
      expect(sysMsg).toContain('READY NEXT ACTIONS:');
      expect(sysMsg).toContain('- [HIGH] Run full jest suite (ready): Verify zero regressions');
      expect(sysMsg).toContain('CRITICAL WARNINGS:');
      expect(sysMsg).toContain('CONSOLIDATION REMINDER:');
      expect(sysMsg).toContain('LESSONS:');
      expect(sysMsg).toContain('Test isolation: Always use :memory: SQLite in tests');
      expect(sysMsg).toContain('LAST SESSION SUMMARY:');
      expect(sysMsg).toContain('Previous session completed Phase 1 schema migrations.');
      expect(sysMsg).toContain('CURATED MEMORIES:');
      expect(sysMsg).toContain('[architecture] Single writer: Only the brain service writes to SQLite.');
      expect(result.systemMessage).toBe(sysMsg);
      expect(result.hookSpecificOutput?.additionalContext).toBe(sysMsg);
      expect(result.hookSpecificOutput?.hookEventName).toBe('SessionStart');
      expect(result.injectSteps?.[0]?.systemMessage?.systemMessage).toBe(sysMsg);
    });

    it('detects agent_name as claude via transcript_path and antigravity via conversationId', async () => {
      const startBodies: any[] = [];

      const mockFetch = async (url: string, init: any = {}) => {
        const body = init.body ? JSON.parse(init.body) : undefined;
        if (url.endsWith('/sessions/start')) {
          startBodies.push(body);
          return {
            ok: true,
            status: 201,
            json: async () => ({ session: { id: body.id || 'sess_auto' } }),
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };

      // 1. Claude Code detection via transcript_path containing .claude
      delete process.env.BRAIN_AGENT_NAME;
      await sessionStartHook.runSessionStart(
        {
          session_id: 'claude-sess-1',
          transcript_path: '/home/user/.claude/projects/neuralbrain/transcript.jsonl',
          cwd: '/tmp/neuralbrain',
        },
        {
          apiUrl: 'http://127.0.0.1:3000',
          projectId: 'neuralbrain',
          fetchFn: mockFetch,
        }
      );

      expect(startBodies[0]).toMatchObject({
        id: 'claude-sess-1',
        agent_name: 'claude',
      });

      // 2. Antigravity detection via conversationId
      await sessionStartHook.runSessionStart(
        {
          conversationId: 'ag-conv-42',
          cwd: '/tmp/neuralbrain',
        },
        {
          apiUrl: 'http://127.0.0.1:3000',
          projectId: 'neuralbrain',
          fetchFn: mockFetch,
        }
      );

      expect(startBodies[1]).toMatchObject({
        id: 'ag-conv-42',
        agent_name: 'antigravity',
      });
    });

    it('formats data.due_actions as top DUE / OVERDUE ACTIONS block before READY NEXT ACTIONS', async () => {
      const mockFetch = async (url: string) => {
        if (url.endsWith('/sessions/start')) {
          return {
            ok: true,
            status: 201,
            json: async () => ({ session: { id: 'sess-due-1' } }),
          };
        }
        if (url.includes('/inject?')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              due_actions: [
                {
                  id: 'act_due_1',
                  title: 'Renew API token',
                  priority: 'urgent',
                  due_at: '2026-11-22T08:00:00.000Z',
                  overdue: true,
                  match_tier: 'ancestor',
                  project_id: 'acme',
                },
                {
                  id: 'act_due_2',
                  title: 'Check global backups',
                  priority: 'normal',
                  remind_at: '2026-11-22T09:00:00.000Z',
                  overdue: false,
                  match_tier: 'global',
                  project_id: null,
                },
              ],
              ready_actions: [
                {
                  id: 'act_ready_1',
                  title: 'Normal task',
                  priority: 'normal',
                  status: 'ready',
                },
              ],
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };

      const result = await sessionStartHook.runSessionStart(
        { session_id: 'sess-due-1', cwd: '/tmp/acme' },
        { apiUrl: 'http://127.0.0.1:3000', projectId: 'acme/cogs', fetchFn: mockFetch }
      );

      const sysMsg = result.systemMessage as string;
      expect(sysMsg).toContain('DUE / OVERDUE ACTIONS:');
      expect(sysMsg).toContain('[OVERDUE] [URGENT] Renew API token (due 2026-11-22T08:00:00.000Z) [ancestor: acme]');
      expect(sysMsg).toContain('[NORMAL] Check global backups (remind 2026-11-22T09:00:00.000Z) [global]');
      expect(sysMsg.indexOf('DUE / OVERDUE ACTIONS:')).toBeLessThan(
        sysMsg.indexOf('READY NEXT ACTIONS:')
      );
    });

    it('inline fallback resolveProjectId in all 3 hooks handles auto_subproject and max_depth when helpers are absent', () => {
      const { spawnSync } = require('child_process');
      const tmp = makeTempBrainHome();
      const workspace = path.join(tmp, 'acme');
      const sub = path.join(workspace, 'Socials', 'Calendar App', 'v1');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(
        path.join(workspace, '.brainrc'),
        JSON.stringify({ project_id: 'acme', auto_subproject: true, max_depth: 2 }),
        'utf-8'
      );

      for (const hookName of ['sessionStart.js', 'postToolUse.js', 'sessionStop.js']) {
        const isolatedHook = path.join(tmp, hookName);
        fs.copyFileSync(path.resolve(__dirname, '../../../plugin/hooks', hookName), isolatedHook);
        const res = spawnSync(
          process.execPath,
          ['-e', `const h = require(${JSON.stringify(isolatedHook)}); console.log(h.resolveProjectId(${JSON.stringify(sub)}));`],
          { encoding: 'utf8' }
        );
        expect(res.status).toBe(0);
        expect(res.stdout.trim()).toBe('acme/socials/calendar-app');
      }
    });
  });

  describe('plugin/hooks/sessionStop.js', () => {
    it('calls POST /capture/trajectories and leaves session active on normal turn stop', async () => {
      const requests: Array<{ url: string; method: string; body?: any }> = [];

      const mockFetch = async (url: string, init: any = {}) => {
        requests.push({
          url,
          method: init.method || 'GET',
          body: init.body ? JSON.parse(init.body) : undefined,
        });
        return { ok: true, status: 200, json: async () => ({}) };
      };

      await sessionStopHook.runSessionStop(
        {
          session_id: 'sess-hook-stop-1',
          cwd: '/tmp/neuralbrain',
        },
        {
          apiUrl: 'http://127.0.0.1:3000',
          apiKey: 'hook-key',
          projectId: 'neuralbrain',
          fetchFn: mockFetch,
        }
      );

      const trajCall = requests.find((r) => r.url.endsWith('/capture/trajectories'));
      const endCall = requests.find((r) =>
        r.url.endsWith('/sessions/sess-hook-stop-1/end')
      );

      expect(trajCall).toBeDefined();
      expect(trajCall?.method).toBe('POST');
      expect(trajCall?.body).toMatchObject({
        session_id: 'sess-hook-stop-1',
        scope: 'project',
        project_id: 'neuralbrain',
        rollup_source: 'signalled',
        success: 1,
      });

      expect(endCall).toBeUndefined();
    });

    it('marks status: abandoned and success: 0 on error, and skips /sessions/:id/end when session_id is missing', async () => {
      const requests: Array<{ url: string; method: string; body?: any }> = [];

      const mockFetch = async (url: string, init: any = {}) => {
        requests.push({
          url,
          method: init.method || 'GET',
          body: init.body ? JSON.parse(init.body) : undefined,
        });
        return { ok: true, status: 200, json: async () => ({}) };
      };

      await sessionStopHook.runSessionStop(
        { session_id: 'sess-hook-err', error: 'Build failed' },
        {
          apiUrl: 'http://127.0.0.1:3000',
          projectId: 'neuralbrain',
          fetchFn: mockFetch,
        }
      );

      const errTrajCall = requests.find((r) => r.url.endsWith('/capture/trajectories'));
      const errEndCall = requests.find((r) =>
        r.url.endsWith('/sessions/sess-hook-err/end')
      );
      expect(errTrajCall?.body.success).toBe(0);
      expect(errEndCall?.body).toMatchObject({
        status: 'abandoned',
        success: 0,
      });

      requests.length = 0;

      await sessionStopHook.runSessionStop(
        { error: 'Build failed' },
        {
          apiUrl: 'http://127.0.0.1:3000',
          projectId: 'neuralbrain',
          fetchFn: mockFetch,
        }
      );

      const trajCall = requests.find((r) => r.url.endsWith('/capture/trajectories'));
      const endCall = requests.find((r) => r.url.includes('/sessions/'));

      expect(trajCall?.body.success).toBe(0);
      expect(endCall).toBeUndefined();
    });

    it('runs silently and returns {} on normal stop even when session has zero saved notes', async () => {
      const mockNoNotes = async (url: string) => {
        if (url.endsWith('/sessions/sess-no-notes')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              observations: [
                { tool_name: 'read_file', failed: 0 },
                { tool_name: 'read_file', failed: 0 },
                { tool_name: 'read_file', failed: 0 },
                { tool_name: 'read_file', failed: 0 },
                { tool_name: 'edit_file', failed: 0 },
              ],
              notes: [],
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      };

      const resNoNotes = await sessionStopHook.runSessionStop(
        { session_id: 'sess-no-notes', cwd: '/tmp/neuralbrain' },
        { apiUrl: 'http://127.0.0.1:3000', projectId: 'neuralbrain', fetchFn: mockNoNotes }
      );
      expect(resNoNotes).toEqual({});
      expect(resNoNotes.systemMessage).toBeUndefined();
    });
  });

  describe('User-directory .env and api-key.txt resolution via BRAIN_HOME', () => {
    it('resolves BRAIN_API_KEY and BRAIN_API_URL from BRAIN_HOME/.env and falls back to BRAIN_HOME/data/api-key.txt', () => {
      const brainHome = makeTempBrainHome();
      process.env.BRAIN_HOME = brainHome;
      delete process.env.BRAIN_API_KEY;
      delete process.env.BRAIN_API_URL;

      // 1. Resolve from BRAIN_HOME/.env
      fs.writeFileSync(
        path.join(brainHome, '.env'),
        'BRAIN_API_URL="http://127.0.0.1:4111"\nBRAIN_API_KEY=\'env-file-key\'\n',
        'utf-8'
      );

      expect(sessionStartHook.resolveApiUrl()).toBe('http://127.0.0.1:4111');
      expect(sessionStartHook.resolveApiKey()).toBe('env-file-key');
      expect(sessionStopHook.resolveApiUrl()).toBe('http://127.0.0.1:4111');
      expect(sessionStopHook.resolveApiKey()).toBe('env-file-key');

      // 2. Remove BRAIN_API_KEY from .env and fall back to BRAIN_HOME/data/api-key.txt
      fs.writeFileSync(
        path.join(brainHome, '.env'),
        'BRAIN_API_URL=http://127.0.0.1:4222\n',
        'utf-8'
      );
      fs.mkdirSync(path.join(brainHome, 'data'), { recursive: true });
      fs.writeFileSync(
        path.join(brainHome, 'data', 'api-key.txt'),
        'file-fallback-key\n',
        'utf-8'
      );

      expect(sessionStartHook.resolveApiUrl()).toBe('http://127.0.0.1:4222');
      expect(sessionStartHook.resolveApiKey()).toBe('file-fallback-key');
      expect(sessionStopHook.resolveApiKey()).toBe('file-fallback-key');

      // 3. Verify src/lib/brainHome.ts respects BRAIN_HOME
      expect(getBrainHomeDir()).toBe(path.resolve(brainHome));
      expect(getBrainEnvPath()).toBe(path.join(path.resolve(brainHome), '.env'));

      delete process.env.BRAIN_API_URL;
      const loaded = loadBrainEnv({ cwd: brainHome });
      expect(loaded).toContain(path.join(path.resolve(brainHome), '.env'));
      expect(process.env.BRAIN_API_URL).toBe('http://127.0.0.1:4222');
    });

    it('resolveApiUrl respects PORT and BRAIN_HTTPS=1 from env and BRAIN_HOME/.env', () => {
      const brainHome = makeTempBrainHome();
      process.env.BRAIN_HOME = brainHome;
      delete process.env.BRAIN_API_URL;
      delete process.env.PORT;
      delete process.env.BRAIN_HTTPS;

      // 1. From BRAIN_HOME/.env
      fs.writeFileSync(
        path.join(brainHome, '.env'),
        'PORT=4555\nBRAIN_HTTPS=1\n',
        'utf-8'
      );
      expect(sessionStartHook.resolveApiUrl()).toBe('https://127.0.0.1:4555');
      expect(sessionStopHook.resolveApiUrl()).toBe('https://127.0.0.1:4555');

      // 2. Overridden by process.env PORT and BRAIN_HTTPS=1
      fs.writeFileSync(path.join(brainHome, '.env'), '', 'utf-8');
      process.env.PORT = '4666';
      process.env.BRAIN_HTTPS = '1';
      expect(sessionStartHook.resolveApiUrl()).toBe('https://127.0.0.1:4666');
      expect(sessionStopHook.resolveApiUrl()).toBe('https://127.0.0.1:4666');
    });
  });
});
