import http from 'http';
import { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createApp } from '../../app';
import { getDb, resetDb } from '../../lib/db';
import {
  createBrainMcpServer,
  createBrainMcpHandlers,
  MCP_INSTRUCTIONS,
} from '../../mcp/server';
import { createDirectBrainMcpHandlers } from '../../routes/mcp';
import { upsertFailurePattern } from '../../memory/failurePatternStore';
import { seedFixtureObservations } from '../../consolidation/fixtures';

describe('MCP Server End-to-End Tests', () => {
  let server: http.Server;
  let apiBaseUrl: string;
  const testApiKey = 'mcp-test-api-key-12345';
  let mcpClient: Client;

  beforeAll(async () => {
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_REQUIRE_API_KEY = '1';
    process.env.BRAIN_EMBED = 'none';

    resetDb();
    const db = getDb();
    db.prepare('INSERT INTO api_keys (id, name, key) VALUES (?, ?, ?)').run(
      'key_mcp_test',
      'mcp-test',
      testApiKey
    );

    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    apiBaseUrl = `http://127.0.0.1:${addr.port}`;

    const brainMcp = createBrainMcpServer({
      apiBaseUrl,
      apiKey: testApiKey,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await brainMcp.connect(serverTransport);

    mcpClient = new Client({ name: 'mcp-jest-test-client', version: '1.0.0' });
    await mcpClient.connect(clientTransport);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    resetDb();
  });

  it('verifies that no DB handle or SQLite module is imported in src/mcp/', () => {
    const mcpServerFile = path.resolve(__dirname, '../../mcp/server.ts');
    const content = fs.readFileSync(mcpServerFile, 'utf-8');

    expect(content).not.toMatch(/getDb/);
    expect(content).not.toMatch(/better-sqlite3|node:sqlite|lib\/sqlite/);
    expect(content).not.toMatch(/from\s+['"]\.\.\/lib\/db['"]/);
  });

  it('exposes ONLY the 12 sanctioned tools and no banned tools', async () => {
    const toolsResult = await mcpClient.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    const expectedTools = [
      'brain_action_add',
      'brain_action_due',
      'brain_action_list',
      'brain_action_update',
      'brain_consolidate_candidates',
      'brain_graph',
      'brain_recent_failures',
      'brain_save',
      'brain_search',
      'brain_session_end',
      'brain_sessions',
      'brain_submit_summary',
    ].sort();

    expect(toolNames).toEqual(expectedTools);

    const bannedTools = [
      'brain_compress',
      'brain_delete',
      'brain_forget',
      'brain_score',
      'brain_rate',
      'brain_set_scope',
    ];
    for (const banned of bannedTools) {
      expect(toolNames).not.toContain(banned);
    }
  });

  it('ships the exact prompt guidance / instructions in metadata per docs/MCP.md', async () => {
    const instructions = mcpClient.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions).toContain(
      'call brain_search before starting non-trivial work, not after failing'
    );
    expect(instructions).toContain(
      '/inject content arrives unasked at task start; do not re-query for it'
    );
    expect(instructions).toContain(
      'save a note when a correction or a non-obvious decision happens, not at session end when the detail is gone'
    );
    expect(instructions).toContain('pass scope: "unknown" rather than guessing');
    expect(instructions).toBe(MCP_INSTRUCTIONS);
  });

  it('refuses to default scope when omitted in brain_save', async () => {
    // 1. Via MCP Client protocol (schema rejection)
    const clientRes = await mcpClient.callTool({
      name: 'brain_save',
      arguments: {
        type: 'fact',
        title: 'Missing Scope Title',
        content: 'This note has no scope parameter',
      },
    });
    expect(clientRes.isError).toBe(true);
    const text = (clientRes as any).content[0].text;
    expect(text).toMatch(/scope/i);

    // 2. Via direct handlers (structured isError response with SCOPE_REQUIRED)
    const handlers = createBrainMcpHandlers({ apiBaseUrl, apiKey: testApiKey });
    const directRes = await handlers.brainSave({
      type: 'fact',
      title: 'Missing Scope Title',
      content: 'This note has no scope parameter',
      scope: undefined as any,
    });
    expect(directRes.isError).toBe(true);
    const directBody = JSON.parse((directRes as any).content[0].text);
    expect(directBody.error.code).toBe('SCOPE_REQUIRED');
    expect(directBody.error.message).toMatch(/SCOPE_REQUIRED/);
  });

  it('saves a scoped note via brain_save and retrieves it via brain_search', async () => {
    const saveRes = await mcpClient.callTool({
      name: 'brain_save',
      arguments: {
        type: 'fact',
        title: 'SQLite is the source of truth',
        content: 'Rule 2: Every record must be repairable with SQL.',
        scope: 'project',
        project_id: 'mcp-integration-project',
        concepts: ['sqlite', 'source-of-truth'],
        files: ['src/lib/db.ts'],
      },
    });

    expect(saveRes.isError).toBeFalsy();
    const note = JSON.parse((saveRes as any).content[0].text);
    expect(note.id).toBeDefined();
    expect(note.scope).toBe('project');
    expect(note.project_id).toBe('mcp-integration-project');
    expect(note.title).toBe('SQLite is the source of truth');

    // Query via brain_search
    const searchRes = await mcpClient.callTool({
      name: 'brain_search',
      arguments: {
        q: 'source of truth',
        project_id: 'mcp-integration-project',
      },
    });

    expect(searchRes.isError).toBeFalsy();
    const searchData = JSON.parse((searchRes as any).content[0].text);
    expect(searchData.results).toBeDefined();
    expect(searchData.results.length).toBeGreaterThan(0);
    expect(searchData.results[0].record.title).toBe('SQLite is the source of truth');
  });

  it('surfaces "degraded" verbatim in brain_search when vector search is degraded', async () => {
    process.env.BRAIN_EMBED = 'local';
    const db = getDb();
    // Simulate store_meta mismatch
    db.prepare('UPDATE store_meta SET embed_dim = 9999 WHERE id = 1').run();

    const searchRes = await mcpClient.callTool({
      name: 'brain_search',
      arguments: {
        q: 'source of truth',
        project_id: 'mcp-integration-project',
      },
    });

    expect(searchRes.isError).toBeFalsy();
    const rawText = (searchRes as any).content[0].text;
    expect(rawText).toContain('"degraded"');

    const searchData = JSON.parse(rawText);
    expect(searchData.degraded).toBeDefined();
    expect(searchData.degraded).toContain('vector search unavailable');

    // Restore store_meta to 0 and BRAIN_EMBED to none
    db.prepare('UPDATE store_meta SET embed_dim = 0 WHERE id = 1').run();
    process.env.BRAIN_EMBED = 'none';
  });

  it('returns SQL counts via brain_recent_failures', async () => {
    // Record two occurrences of the same failure pattern
    upsertFailurePattern({
      scope: 'project',
      projectId: 'mcp-fail-project',
      taskType: 'test_run',
      errorText: 'Foreign key constraint violated on note_files',
    });
    upsertFailurePattern({
      scope: 'project',
      projectId: 'mcp-fail-project',
      taskType: 'test_run',
      errorText: 'Foreign key constraint violated on note_files',
    });

    const res = await mcpClient.callTool({
      name: 'brain_recent_failures',
      arguments: {
        project_id: 'mcp-fail-project',
        task_type: 'test_run',
      },
    });

    expect(res.isError).toBeFalsy();
    const failures = JSON.parse((res as any).content[0].text);
    expect(Array.isArray(failures)).toBe(true);
    expect(failures.length).toBeGreaterThan(0);

    const target = failures.find(
      (f: any) => f.error_text === 'Foreign key constraint violated on note_files'
    );
    expect(target).toBeDefined();
    expect(target.count).toBe(2);
    expect(target.task_type).toBe('test_run');
    expect(target.last_seen_at).toBeDefined();
  });

  it('round-trips candidates and submit_summary, returning 422 details on fabricated citations', async () => {
    const db = getDb();
    const sessId = 'sess-mcp-unconsolidated-1';
    const now = Math.floor(Date.now() / 1000);

    const obs1Id = 'obs_mcp_1_' + Date.now();
    const obs2Id = 'obs_mcp_2_' + Date.now();

    db.prepare(`
      INSERT INTO observations (
        id, scope, project_id, session_id, kind, tool_name, file_path, input, output, duration_ms, failed, created_at
      ) VALUES
      (?, 'project', 'mcp-fixture-proj', ?, 'tool_call', 'ExecuteCommand', NULL, 'npm test',
       'FAIL src/tests/memory/trajectoryStore.test.ts\nTypeError: Cannot read properties of undefined (reading ''id'')\n      at src/routes/memories.ts:18:34',
       500, 1, ?),
      (?, 'project', 'mcp-fixture-proj', ?, 'tool_call', 'Edit', 'src/routes/memories.ts', 'fix optional chaining',
       'saved file src/routes/memories.ts', 120, 0, ?)
    `).run(obs1Id, sessId, now - 50, obs2Id, sessId, now - 40);

    // 1. brain_consolidate_candidates
    const candRes = await mcpClient.callTool({
      name: 'brain_consolidate_candidates',
      arguments: {
        project_id: 'mcp-fixture-proj',
      },
    });

    expect(candRes.isError).toBeFalsy();
    const candData = JSON.parse((candRes as any).content[0].text);
    expect(candData.candidates).toBeDefined();
    expect(candData.candidates.length).toBeGreaterThan(0);

    const leaseCandidate = candData.candidates.find((c: any) => c.session_id === sessId);
    expect(leaseCandidate).toBeDefined();
    expect(leaseCandidate.lease_id).toBeDefined();
    expect(leaseCandidate.observations.length).toBe(2);
    expect(leaseCandidate.expires_at).toBeGreaterThan(now);

    const leaseId = leaseCandidate.lease_id;

    // 2. Fabricated citation -> expect 422 and exact failure reason
    const badSubmitRes = await mcpClient.callTool({
      name: 'brain_submit_summary',
      arguments: {
        lease_id: leaseId,
        claims: [
          {
            text: 'Hallucinated claim citing imaginary observation',
            source_ids: ['obs_fake_nonexistent_citation_999'],
          },
        ],
      },
    });

    expect(badSubmitRes.isError).toBe(true);
    const badBody = JSON.parse((badSubmitRes as any).content[0].text);
    expect(badBody.error).toBeDefined();
    expect(badBody.error.code).toBe('citation_unresolved');
    expect(badBody.error.message).toContain('obs_fake_nonexistent_citation_999');

    // 3. Valid summary -> successful 201 verification
    const goodSubmitRes = await mcpClient.callTool({
      name: 'brain_submit_summary',
      arguments: {
        lease_id: leaseId,
        claims: [
          {
            text: 'Test suite failed with TypeError in memories.ts',
            source_ids: [obs1Id],
          },
        ],
        files_touched: ['src/routes/memories.ts'],
        error_verbatim:
          "FAIL src/tests/memory/trajectoryStore.test.ts\nTypeError: Cannot read properties of undefined (reading 'id')\n      at src/routes/memories.ts:18:34",
      },
    });

    expect(goodSubmitRes.isError).toBeFalsy();
    const goodBody = JSON.parse((goodSubmitRes as any).content[0].text);
    expect(goodBody.ok).toBe(true);
    expect(goodBody.summary_id).toBeDefined();
    expect(goodBody.outcome).toBe('failure');
  });

  it('serves MCP over Streamable HTTP at /mcp with bearer auth', async () => {
    const httpTransport = new StreamableHTTPClientTransport(new URL(`${apiBaseUrl}/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${testApiKey}`,
        },
      },
    });
    const httpClient = new Client({ name: 'mcp-http-test-client', version: '1.0.0' });
    await httpClient.connect(httpTransport);

    try {
      const toolsResult = await httpClient.listTools();
      expect(toolsResult.tools.map((t) => t.name)).toContain('brain_search');

      const failuresRes = await httpClient.callTool({
        name: 'brain_recent_failures',
        arguments: { limit: 5 },
      });
      expect(failuresRes.isError).toBeFalsy();
      const parsed = JSON.parse((failuresRes as any).content[0].text);
      expect(Array.isArray(parsed)).toBe(true);

      const saveRes = await httpClient.callTool({
        name: 'brain_save',
        arguments: {
          type: 'fact',
          title: 'HTTP MCP Direct Service Note',
          content: 'Saved via Streamable HTTP /mcp without loopback HTTP round-trip',
          scope: 'project',
          project_id: 'mcp-http-project',
        },
      });
      expect(saveRes.isError).toBeFalsy();

      const searchRes = await httpClient.callTool({
        name: 'brain_search',
        arguments: {
          q: 'Direct Service Note',
          project_id: 'mcp-http-project',
        },
      });
      expect(searchRes.isError).toBeFalsy();
      const searchBody = JSON.parse((searchRes as any).content[0].text);
      expect(searchBody.results.some((r: any) => r.record?.title === 'HTTP MCP Direct Service Note')).toBe(true);
    } finally {
      await httpTransport.close();
    }
  });

  it('returns structured isError on SCOPE_REQUIRED/SCHEMA_INVALID for brainActionAdd and emits compact JSON', async () => {
    const handlers = createBrainMcpHandlers({ apiBaseUrl, apiKey: testApiKey, defaultProjectId: '' });
    const missingScopeRes = await handlers.brainActionAdd({
      title: 'Action without scope',
      scope: undefined as any,
    });
    expect(missingScopeRes.isError).toBe(true);
    expect(JSON.parse(missingScopeRes.content[0].text).error.code).toBe('SCOPE_REQUIRED');

    const missingProjectRes = await handlers.brainActionAdd({
      title: 'Action without project_id',
      scope: 'project',
    });
    expect(missingProjectRes.isError).toBe(true);
    expect(JSON.parse(missingProjectRes.content[0].text).error.code).toBe('SCHEMA_INVALID');

    const searchRes = await mcpClient.callTool({
      name: 'brain_search',
      arguments: { q: 'SQLite', limit: 5 },
    });
    expect(searchRes.isError).toBeFalsy();
    const rawText = (searchRes as any).content[0].text as string;
    expect(rawText).not.toContain('\n  ');
  });

  it('enforces Zod limit bounds on MCP tools', async () => {
    const badSearch = await mcpClient.callTool({
      name: 'brain_search',
      arguments: { q: 'test', limit: 101 },
    });
    expect(badSearch.isError).toBe(true);

    const badFailures = await mcpClient.callTool({
      name: 'brain_recent_failures',
      arguments: { limit: 0 },
    });
    expect(badFailures.isError).toBe(true);
  });

  it('aligns direct MCP handlers for brain_recent_failures, brain_graph global scope, and compact JSON', async () => {
    for (let i = 0; i < 6; i++) {
      upsertFailurePattern({
        scope: 'project',
        projectId: 'direct-mcp-proj',
        taskType: 'test_task',
        errorText: `ERR_DIRECT_${i}`,
      });
    }

    const directHandlers = createDirectBrainMcpHandlers('direct-mcp-proj');
    const failRes = await directHandlers.brainRecentFailures({});
    expect(failRes.isError).toBeFalsy();
    expect(failRes.content[0].text).not.toContain('\n  ');
    const failures = JSON.parse(failRes.content[0].text);
    expect(failures.length).toBe(5);
    expect(Object.keys(failures[0]).sort()).toEqual([
      'count',
      'error_text',
      'last_seen_at',
      'match_tier',
      'project_id',
      'task_type',
    ]);

    const saveGlobal = await directHandlers.brainSave({
      type: 'fact',
      title: 'Global Graph Fact',
      content: 'Visible in global graph without project filter',
      scope: 'global',
    });
    expect(saveGlobal.isError).toBeFalsy();

    const graphRes = await directHandlers.brainGraph({ scope: 'global' });
    expect(graphRes.isError).toBeFalsy();
    const graph = JSON.parse(graphRes.content[0].text);
    expect(graph.nodes.some((n: any) => n.label === 'Global Graph Fact')).toBe(true);
  });

  it('maintains 100% parity across stdio MCP and direct MCP for hierarchical search, temporal filters, user_id vs agent_id, entity graph CRUD, and brain_action_due', async () => {
    const directHandlers = createDirectBrainMcpHandlers(undefined);

    // 1. Hierarchical notes with temporal & user_id/agent_id fields
    await mcpClient.callTool({
      name: 'brain_save',
      arguments: {
        type: 'architecture',
        title: 'Acme Platform Naming Standard',
        content: 'All acme services share lowercase kebab slugs.',
        scope: 'project',
        project_id: 'acme',
        user_id: 'alice',
        agent_id: 'agent-one',
        event_at: '2026-03-01T10:00:00Z',
        valid_from: '2026-01-01T00:00:00Z',
        valid_until: '2026-12-31T23:59:59Z',
      },
    });

    await mcpClient.callTool({
      name: 'brain_save',
      arguments: {
        type: 'fact',
        title: 'Generator sibling note',
        content: 'Internal generator details not for calendar.',
        scope: 'project',
        project_id: 'acme/socials/generator',
        user_id: 'alice',
      },
    });

    const noteLaunchRes = await mcpClient.callTool({
      name: 'brain_save',
      arguments: {
        type: 'workflow',
        title: 'Launch campaign publishing flow',
        content: 'Coordinate hero media before release.',
        scope: 'project',
        project_id: 'acme/marketing/launch',
        user_id: 'alice',
        agent_id: 'agent-two',
      },
    });
    const noteLaunch = JSON.parse((noteLaunchRes as any).content[0].text);

    // Search via stdio MCP on child acme/socials/calendar -> inherits acme, isolates generator
    const childSearchStdio = await mcpClient.callTool({
      name: 'brain_search',
      arguments: {
        q: 'Acme Platform Naming Standard generator',
        project_id: 'acme/socials/calendar',
        include_global: false,
        user_id: 'alice',
        as_of: '2026-06-01T00:00:00Z',
        memory_layer: 'semantic',
      },
    });
    expect(childSearchStdio.isError).toBeFalsy();
    const childSearchDirect = await directHandlers.brainSearch({
      q: 'Acme Platform Naming Standard generator',
      project_id: 'acme/socials/calendar',
      include_global: false,
      user_id: 'alice',
      as_of: '2026-06-01T00:00:00Z',
      memory_layer: 'semantic',
    });
    expect(childSearchDirect.isError).toBeFalsy();

    const stdioResults = JSON.parse((childSearchStdio as any).content[0].text).results;
    const directResults = JSON.parse(childSearchDirect.content[0].text).results;
    expect(stdioResults.map((r: any) => r.record.title)).toEqual([
      'Acme Platform Naming Standard',
    ]);
    expect(directResults.map((r: any) => r.record.title)).toEqual([
      'Acme Platform Naming Standard',
    ]);
    expect(stdioResults[0].match_tier).toBe('ancestor');

    // 2. brain_graph upsert_entity requires explicit scope; link across subprojects; query BFS; unlink
    const badEntityStdio = await mcpClient.callTool({
      name: 'brain_graph',
      arguments: {
        mode: 'upsert_entity',
        entity_type: 'asset',
        name: 'Unscoped asset',
      },
    });
    expect(badEntityStdio.isError).toBe(true);

    const badEntityDirect = await directHandlers.brainGraph({
      mode: 'upsert_entity',
      entity_type: 'asset',
      name: 'Unscoped asset',
    });
    expect(badEntityDirect.isError).toBe(true);
    expect(JSON.parse(badEntityDirect.content[0].text).error.code).toBe('SCOPE_REQUIRED');

    const upsertRes = await mcpClient.callTool({
      name: 'brain_graph',
      arguments: {
        mode: 'upsert_entity',
        scope: 'project',
        project_id: 'acme/socials/generator',
        entity_type: 'asset',
        name: 'Q3 Teaser Video',
        description: 'Social teaser video asset',
        external_ref: 's3://acme-assets/q3-teaser.mp4',
        user_id: 'alice',
        agent_id: 'agent-one',
      },
    });
    expect(upsertRes.isError).toBeFalsy();
    const entity = JSON.parse((upsertRes as any).content[0].text).entity;
    expect(entity.id).toBeDefined();

    const linkRes = await directHandlers.brainGraph({
      mode: 'link',
      source_id: noteLaunch.id,
      target_id: entity.id,
      relation: 'references',
    });
    expect(linkRes.isError).toBeFalsy();
    const edge = JSON.parse(linkRes.content[0].text).edge;
    expect(edge.relation).toBe('references');

    // Query multi-hop graph from noteLaunch -> finds cross-subproject entity
    const graphQueryStdio = await mcpClient.callTool({
      name: 'brain_graph',
      arguments: {
        mode: 'query',
        project_id: 'acme/marketing/launch',
        node_id: noteLaunch.id,
        depth: 2,
      },
    });
    const graphQueryDirect = await directHandlers.brainGraph({
      mode: 'query',
      project_id: 'acme/marketing/launch',
      node_id: noteLaunch.id,
      depth: 2,
    });
    expect(JSON.parse((graphQueryStdio as any).content[0].text)).toEqual(
      JSON.parse(graphQueryDirect.content[0].text)
    );
    expect(
      JSON.parse(graphQueryDirect.content[0].text).nodes.some((n: any) => n.id === entity.id)
    ).toBe(true);

    // Search entity name under parent 'acme' with include_children -> surfaces linked note with matched_entities
    const entitySearchRes = await mcpClient.callTool({
      name: 'brain_search',
      arguments: {
        q: 'Q3 Teaser Video',
        project_id: 'acme',
        include_children: true,
        record_types: ['note', 'entity'],
      },
    });
    const entitySearchData = JSON.parse((entitySearchRes as any).content[0].text);
    const linkedHit = entitySearchData.results.find((r: any) => r.id === noteLaunch.id);
    expect(linkedHit).toBeDefined();
    expect(linkedHit.matched_entities).toContain('Q3 Teaser Video');

    // Unlink via stdio MCP
    const unlinkRes = await mcpClient.callTool({
      name: 'brain_graph',
      arguments: {
        mode: 'unlink',
        id: edge.id,
      },
    });
    expect(JSON.parse((unlinkRes as any).content[0].text).deleted).toBe(1);

    // 3. brain_action_add, brain_action_due (12th tool), brain_action_list(due_only), brain_action_update(recurring)
    const pastIso = new Date(Date.now() - 3600_000).toISOString();
    const futureIso = new Date(Date.now() + 86_400_000).toISOString();

    const actAddRes = await mcpClient.callTool({
      name: 'brain_action_add',
      arguments: {
        scope: 'project',
        project_id: 'acme',
        user_id: 'alice',
        agent_id: 'agent-alpha',
        title: 'Daily metrics check',
        priority: 'urgent',
        due_at: pastIso,
        remind_at: pastIso,
        recurrence: '@daily',
      },
    });
    expect(actAddRes.isError).toBeFalsy();
    const act1 = JSON.parse((actAddRes as any).content[0].text).action;

    await mcpClient.callTool({
      name: 'brain_action_add',
      arguments: {
        scope: 'project',
        project_id: 'acme',
        user_id: 'alice',
        title: 'Snoozed metrics check',
        due_at: pastIso,
        snooze_until: futureIso,
      },
    });

    // Both stdio brain_action_due and direct brainActionDue return act1 from ancestor 'acme'
    const dueStdio = await mcpClient.callTool({
      name: 'brain_action_due',
      arguments: {
        project_id: 'acme/socials/calendar',
        user_id: 'alice',
        include_global: false,
      },
    });
    const dueDirect = await directHandlers.brainActionDue({
      project_id: 'acme/socials/calendar',
      user_id: 'alice',
      include_global: false,
    });
    const dueStdioActions = JSON.parse((dueStdio as any).content[0].text).actions;
    const dueDirectActions = JSON.parse(dueDirect.content[0].text).actions;
    expect(dueStdioActions.map((a: any) => a.id)).toEqual([act1.id]);
    expect(dueDirectActions.map((a: any) => a.id)).toEqual([act1.id]);
    expect(dueStdioActions[0].overdue).toBe(true);
    expect(dueStdioActions[0].match_tier).toBe('ancestor');

    // brain_action_list with due_only: true
    const listDueRes = await directHandlers.brainActionList({
      project_id: 'acme/socials/calendar',
      due_only: true,
      include_global: false,
    });
    expect(JSON.parse(listDueRes.content[0].text).actions.map((a: any) => a.id)).toEqual([act1.id]);

    // Completing recurring action spawns next_occurrence
    const updateDoneRes = await mcpClient.callTool({
      name: 'brain_action_update',
      arguments: {
        id: act1.id,
        status: 'done',
      },
    });
    const updatedAct = JSON.parse((updateDoneRes as any).content[0].text).action;
    expect(updatedAct.status).toBe('done');
    expect(updatedAct.next_occurrence).toBeDefined();
    expect(updatedAct.next_occurrence.parent_action_id).toBe(act1.id);
    expect(updatedAct.next_occurrence.recurrence).toBe('0 0 * * *');
  });
});
