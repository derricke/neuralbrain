import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadBrainEnv } from '../lib/brainHome';
import { resolveCanonicalProjectId } from '../lib/projectSlug';
import { createLocalTlsFetch } from '../lib/tls';

export interface BrainMcpServerOptions {
  apiBaseUrl?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
  defaultProjectId?: string;
  handlers?: BrainMcpHandlers;
}

export const MCP_INSTRUCTIONS = [
  'call brain_search before starting non-trivial work, not after failing',
  'include record_types: ["summary"] (or ["note", "trajectory", "summary"]) in brain_search when resuming prior work on a file, debugging a recurring error, or when no curated notes exist yet',
  'check ready next actions (via /inject or brain_action_list) at task start before picking up work',
  '/inject content arrives unasked at task start; do not re-query for it',
  'use brain_sessions to inspect prior agent sessions or replay a session timeline when resuming work',
  'use brain_graph to explore relationships across notes, lessons, concepts, files, sessions, actions, and summaries',
  'save a note when a correction or a non-obvious decision happens, not at session end when the detail is gone',
  'save a note via brain_save immediately when you fix a non-trivial bug, hit an unexpected gotcha, make an architectural decision, or receive a user correction',
  'before finishing any non-trivial task, verify whether any durable insight should be saved with brain_save',
  'if /inject includes a CONSOLIDATION REMINDER, let the user know and suggest they start a new session with an example prompt (e.g., "Consolidate the brain observations for this project.")',
  'when consolidating observations, redact any API keys, tokens, passwords, or other sensitive info before submitting via brain_submit_summary',
  'surface unfinished work or blockers via brain_action_add so the next session can resume cleanly',
  'call brain_session_end at session completion or pause to record a clean cross-agent handoff summary',
  'pass scope: "unknown" rather than guessing',
  'for project scope, project_id is the project root folder name (the folder holding .brainrc, else the git repo root — the main repo for a worktree — else the folder the session started in), lowercase, e.g. "neuralbrain"; never a subfolder you are working in and never a filesystem path, so all agents come up with the same id',
].join('\n');

export function createBrainMcpHandlers(options: BrainMcpServerOptions = {}) {
  const apiBaseUrl = (
    options.apiBaseUrl ||
    process.env.BRAIN_API_URL ||
    process.env.BRAIN_ENDPOINT ||
    `http://127.0.0.1:${process.env.PORT || 3737}`
  ).replace(/\/$/, '');
  const apiKey = options.apiKey ?? process.env.BRAIN_API_KEY;
  const fetchFn = options.fetchFn || createLocalTlsFetch();
  const defaultProjectId =
    options.defaultProjectId ??
    resolveCanonicalProjectId({ fallbackToDirname: false }) ??
    undefined;

  const authHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    authHeaders['Authorization'] = `Bearer ${apiKey}`;
  }

  const brainSearch = async (args: {
    q: string;
    record_types?: string[];
    grains?: string[];
    project_id?: string;
    include_global?: boolean;
    type?: string[];
    file_path?: string;
    limit?: number;
  }) => {
    const targetProjectId = args.project_id || defaultProjectId;
    const requestedTypes =
      args.record_types && args.record_types.length > 0 ? args.record_types : args.grains;
    const body: Record<string, any> = {
      q: args.q,
      record_types:
        requestedTypes && requestedTypes.length > 0 ? requestedTypes : ['note', 'trajectory'],
      include_global: args.include_global !== false,
      limit: args.limit ?? 10,
    };
    if (targetProjectId) {
      body.project_id = targetProjectId;
      body.scope = 'project';
    }
    const filters: Record<string, any> = {};
    if (args.type && args.type.length > 0) {
      filters.type = args.type;
    }
    if (args.file_path) {
      filters.file_path = args.file_path;
    }
    if (Object.keys(filters).length > 0) {
      body.filters = filters;
    }

    try {
      const res = await fetchFn(`${apiBaseUrl}/search`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `MCP Transport Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };

  const brainSave = async (args: {
    type: 'fact' | 'architecture' | 'pattern' | 'workflow' | 'bug' | 'preference' | 'lesson';
    title: string;
    content: string;
    scope?: 'project' | 'global' | 'unknown' | string;
    project_id?: string;
    session_id?: string;
    concepts?: string[];
    files?: string[];
    supersedes?: string;
  }) => {
    if (!args.scope || (args.scope !== 'project' && args.scope !== 'global' && args.scope !== 'unknown')) {
      const err = new Error("SCOPE_REQUIRED: Scope is required and must be 'project', 'global', or 'unknown'");
      (err as any).code = 'SCOPE_REQUIRED';
      throw err;
    }

    const effectiveProjectId =
      args.project_id || (args.scope === 'project' ? defaultProjectId : undefined);

    if (args.scope === 'project' && !effectiveProjectId) {
      const err = new Error(
        "SCHEMA_INVALID: project_id is required when scope is 'project' (use the project root folder name, e.g. 'neuralbrain' — from .brainrc or the git repo root, not a subfolder or filesystem path)"
      );
      (err as any).code = 'SCHEMA_INVALID';
      throw err;
    }

    const payload: Record<string, any> = {
      type: args.type,
      title: args.title,
      content: args.content,
      scope: args.scope,
      project_id: effectiveProjectId || null,
      projectId: effectiveProjectId || null,
      concepts: args.concepts || [],
      files: args.files || [],
      supersedes: args.supersedes || null,
    };
    if (args.session_id !== undefined) {
      payload.session_id = args.session_id;
    }

    try {
      const res = await fetchFn(`${apiBaseUrl}/notes`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      if ((err as any)?.code === 'SCOPE_REQUIRED' || (err as any)?.code === 'SCHEMA_INVALID') {
        throw err;
      }
      return {
        content: [{ type: 'text' as const, text: `MCP Transport Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };

  const brainRecentFailures = async (args: {
    project_id?: string;
    task_type?: string;
    limit?: number;
  }) => {
    try {
      const targetProjectId = args.project_id || defaultProjectId;
      const query = new URLSearchParams();
      if (targetProjectId) query.set('project_id', targetProjectId);
      if (args.task_type) query.set('task_type', args.task_type);
      if (args.limit) query.set('limit', String(args.limit));

      const url = `${apiBaseUrl}/failure-patterns${query.toString() ? `?${query.toString()}` : ''}`;
      const res = await fetchFn(url, {
        method: 'GET',
        headers: authHeaders,
        signal: AbortSignal.timeout(10_000),
      });

      const data = await res.json().catch(() => []);
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
          isError: true,
        };
      }

      const items = Array.isArray(data) ? data : [];
      const result = items.map((p: any) => ({
        task_type: p.task_type,
        error_text: p.error_text,
        count: p.count,
        last_seen_at: p.last_seen_at,
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `MCP Transport Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };

  const brainConsolidateCandidates = async (args: {
    project_id?: string;
    limit?: number;
  }) => {
    try {
      const targetProjectId = args.project_id || defaultProjectId;
      const query = new URLSearchParams();
      if (targetProjectId) query.set('project_id', targetProjectId);
      if (args.limit) query.set('limit', String(args.limit));

      const url = `${apiBaseUrl}/consolidate/candidates${query.toString() ? `?${query.toString()}` : ''}`;
      const res = await fetchFn(url, {
        method: 'GET',
        headers: authHeaders,
        signal: AbortSignal.timeout(10_000),
      });

      const data = await res.json().catch(() => ({ candidates: [] }));
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `MCP Transport Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };

  const brainSubmitSummary = async (args: {
    lease_id: string;
    claims: Array<{ text: string; source_ids: string[] }>;
    files_touched?: string[];
    error_verbatim?: string | null;
  }) => {
    try {
      const payload = {
        lease_id: args.lease_id,
        claims: args.claims,
        files_touched: args.files_touched,
        error_verbatim: args.error_verbatim,
        producer_tier: 'agent',
        producer_model: null,
        prompt_version: 'extract-v1',
      };

      const res = await fetchFn(`${apiBaseUrl}/consolidate/summaries`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `MCP Transport Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };

  const requestJson = async (url: string, init: RequestInit) => {
    try {
      const res = await fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(10_000),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `MCP Transport Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };

  const brainActionAdd = async (args: {
    title: string;
    description?: string;
    scope?: 'project' | 'global' | 'unknown' | string;
    project_id?: string;
    session_id?: string;
    status?: 'ready' | 'blocked' | 'in_progress' | 'done' | 'dismissed';
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    blocked_reason?: string;
    files?: string[];
  }) => {
    if (!args.scope || (args.scope !== 'project' && args.scope !== 'global' && args.scope !== 'unknown')) {
      const err = new Error("SCOPE_REQUIRED: Scope is required and must be 'project', 'global', or 'unknown'");
      (err as any).code = 'SCOPE_REQUIRED';
      throw err;
    }

    const effectiveProjectId =
      args.project_id || (args.scope === 'project' ? defaultProjectId : undefined);

    if (args.scope === 'project' && !effectiveProjectId) {
      const err = new Error(
        "SCHEMA_INVALID: project_id is required when scope is 'project' (use the project root folder name, e.g. 'neuralbrain' — from .brainrc or the git repo root, not a subfolder or filesystem path)"
      );
      (err as any).code = 'SCHEMA_INVALID';
      throw err;
    }

    const payload: Record<string, any> = {
      title: args.title,
      scope: args.scope,
    };
    if (args.description !== undefined) payload.description = args.description;
    if (effectiveProjectId) payload.project_id = effectiveProjectId;
    if (args.session_id !== undefined) payload.session_id = args.session_id;
    if (args.status !== undefined) payload.status = args.status;
    if (args.priority !== undefined) payload.priority = args.priority;
    if (args.blocked_reason !== undefined) payload.blocked_reason = args.blocked_reason;
    if (args.files !== undefined) payload.files = args.files;

    return requestJson(`${apiBaseUrl}/actions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(payload),
    });
  };

  const brainActionList = async (args: {
    project_id?: string;
    include_global?: boolean;
    status?: string;
    limit?: number;
  } = {}) => {
    const targetProjectId = args.project_id || defaultProjectId;
    const query = new URLSearchParams();
    if (targetProjectId) query.set('project_id', targetProjectId);
    if (args.include_global !== undefined) query.set('include_global', String(args.include_global));
    if (args.status) query.set('status', args.status);
    if (args.limit !== undefined) query.set('limit', String(args.limit));

    const url = `${apiBaseUrl}/actions${query.toString() ? `?${query.toString()}` : ''}`;
    return requestJson(url, {
      method: 'GET',
      headers: authHeaders,
    });
  };

  const brainActionUpdate = async (args: {
    id: string;
    status?: 'ready' | 'blocked' | 'in_progress' | 'done' | 'dismissed';
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    title?: string;
    description?: string;
    blocked_reason?: string;
    resolved_by_session_id?: string;
  }) => {
    const payload: Record<string, any> = {};
    if (args.status !== undefined) payload.status = args.status;
    if (args.priority !== undefined) payload.priority = args.priority;
    if (args.title !== undefined) payload.title = args.title;
    if (args.description !== undefined) payload.description = args.description;
    if (args.blocked_reason !== undefined) payload.blocked_reason = args.blocked_reason;
    if (args.resolved_by_session_id !== undefined) payload.resolved_by_session_id = args.resolved_by_session_id;

    return requestJson(`${apiBaseUrl}/actions/${encodeURIComponent(args.id)}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify(payload),
    });
  };

  const brainSessions = async (args: {
    mode?: 'list' | 'get' | 'replay';
    session_id?: string;
    project_id?: string;
    status?: string;
    agent_name?: string;
    limit?: number;
  } = {}) => {
    const mode = args.mode || 'list';
    if (mode === 'get' || mode === 'replay') {
      if (!args.session_id) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error: {
                    code: 'SCHEMA_INVALID',
                    message: `session_id is required when mode is '${mode}'`,
                  },
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
      const suffix = mode === 'replay' ? '/replay' : '';
      return requestJson(`${apiBaseUrl}/sessions/${encodeURIComponent(args.session_id)}${suffix}`, {
        method: 'GET',
        headers: authHeaders,
      });
    }

    const targetProjectId = args.project_id || defaultProjectId;
    const query = new URLSearchParams();
    if (targetProjectId) query.set('project_id', targetProjectId);
    if (args.status) query.set('status', args.status);
    if (args.agent_name) query.set('agent_name', args.agent_name);
    if (args.limit !== undefined) query.set('limit', String(args.limit));

    const url = `${apiBaseUrl}/sessions${query.toString() ? `?${query.toString()}` : ''}`;
    return requestJson(url, {
      method: 'GET',
      headers: authHeaders,
    });
  };

  const brainSessionEnd = async (args: {
    session_id: string;
    status?: 'completed' | 'paused' | 'abandoned';
    summary?: string;
    files_touched?: string[];
    handoff_summary_id?: string;
  }) => {
    const payload: Record<string, any> = {};
    if (args.status !== undefined) payload.status = args.status;
    if (args.summary !== undefined) payload.summary = args.summary;
    if (args.files_touched !== undefined) payload.files_touched = args.files_touched;
    if (args.handoff_summary_id !== undefined) payload.handoff_summary_id = args.handoff_summary_id;

    return requestJson(`${apiBaseUrl}/sessions/${encodeURIComponent(args.session_id)}/end`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(payload),
    });
  };

  const brainGraph = async (args: {
    project_id?: string;
    scope?: 'project' | 'global' | 'unknown';
    limit?: number;
  } = {}) => {
    const targetProjectId =
      args.project_id || (args.scope === 'global' || args.scope === 'unknown' ? undefined : defaultProjectId);
    const query = new URLSearchParams();
    if (targetProjectId) query.set('project_id', targetProjectId);
    if (args.scope) query.set('scope', args.scope);
    if (args.limit !== undefined) query.set('limit', String(args.limit));

    const url = `${apiBaseUrl}/graph${query.toString() ? `?${query.toString()}` : ''}`;
    return requestJson(url, {
      method: 'GET',
      headers: authHeaders,
    });
  };

  return {
    brainSearch,
    brainSave,
    brainRecentFailures,
    brainConsolidateCandidates,
    brainSubmitSummary,
    brainActionAdd,
    brainActionList,
    brainActionUpdate,
    brainSessions,
    brainSessionEnd,
    brainGraph,
  };
}

export type BrainMcpHandlers = ReturnType<typeof createBrainMcpHandlers>;

export function createBrainMcpServer(options: BrainMcpServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: 'neuralbrain',
      version: '0.0.1',
    },
    {
      instructions: MCP_INSTRUCTIONS,
    }
  );

  const handlers = options.handlers ?? createBrainMcpHandlers(options);

  // 1. brain_search
  server.tool(
    'brain_search',
    'Search across memories, trajectories, observations, and summaries with hybrid dense + BM25 retrieval. Surfaces "degraded" verbatim when vector search is unavailable so the agent can tell BM25-only results from hybrid ones. Call before starting non-trivial work.',
    {
      q: z.string().describe('Search query text'),
      record_types: z
        .array(z.string())
        .default(['note', 'trajectory'])
        .describe(
          "Memory record types to search (default: ['note', 'trajectory']). Options: 'note' (curated facts/decisions/bugs), 'trajectory' (session outcome rollups), 'summary' (consolidated session claims, touched files, and verbatim errors — pass ['summary'] or ['note', 'trajectory', 'summary'] when resuming work, checking file history, or debugging recurring errors), 'observation' (raw tool calls/prompts)."
        ),
      project_id: z
        .string()
        .optional()
        .describe('Project ID to filter by; omit for global-only. Use the project root folder name (from .brainrc, else the git repo root; the main repo for a worktree), e.g. "neuralbrain" — never a subfolder or filesystem path'),
      include_global: z.boolean().default(true).describe('Whether to include global records when project_id is specified'),
      type: z.array(z.string()).optional().describe('Note type filter (fact, architecture, pattern, workflow, bug, preference, lesson)'),
      file_path: z.string().optional().describe('File path filter ("what do we know about this file?")'),
      limit: z.number().int().default(10).describe('Maximum number of results to return'),
    },
    async (args) => {
      return handlers.brainSearch(args);
    }
  );

  // 2. brain_save
  server.tool(
    'brain_save',
    "Write a note deliberately. Scope is REQUIRED and never inferred or defaulted ('project', 'global', or 'unknown'). If scope is omitted or invalid, rejects immediately with SCOPE_REQUIRED.",
    {
      type: z.enum(['fact', 'architecture', 'pattern', 'workflow', 'bug', 'preference', 'lesson']).describe('Note type'),
      title: z.string().describe('Title of the note'),
      content: z.string().describe('Content of the note'),
      scope: z.enum(['project', 'global', 'unknown']).describe("Scope: 'project', 'global', or 'unknown'. REQUIRED, never inferred!"),
      project_id: z
        .string()
        .optional()
        .describe(
          "Required iff scope is 'project'. Use the project root folder name (from .brainrc, else the git repo root; the main repo for a worktree), e.g. 'neuralbrain' — never a subfolder or filesystem path. If unsure, use scope 'unknown'"
        ),
      session_id: z.string().optional().describe('Optional session ID that authored this note'),
      concepts: z.array(z.string()).optional().describe('Concepts associated with this note'),
      files: z.array(z.string()).optional().describe('File paths associated with this note'),
      supersedes: z.string().optional().describe('Previous note id being superseded'),
    },
    async (args) => {
      return handlers.brainSave(args);
    }
  );

  // 3. brain_recent_failures
  server.tool(
    'brain_recent_failures',
    'Retrieve recent failure patterns and counts. Returns { task_type, error_text, count, last_seen_at }[] where count is from SQL.',
    {
      project_id: z
        .string()
        .optional()
        .describe('Project ID to filter by (use the project root folder name, e.g. "neuralbrain"; never a subfolder or filesystem path); omit for global'),
      task_type: z.string().optional().describe('Task type filter'),
      limit: z.number().int().default(5).describe('Maximum number of failures to return'),
    },
    async (args) => {
      return handlers.brainRecentFailures(args);
    }
  );

  // 4. brain_consolidate_candidates
  server.tool(
    'brain_consolidate_candidates',
    'Retrieve un-consolidated observation sessions with a lease. Returns lease_id, the source records (observations), and expires_at.',
    {
      project_id: z
        .string()
        .optional()
        .describe('Filter candidates by project (use the project root folder name, e.g. "neuralbrain"; never a subfolder or filesystem path)'),
      limit: z.number().int().optional().describe('Maximum number of candidate leases to retrieve'),
    },
    async (args) => {
      return handlers.brainConsolidateCandidates(args);
    }
  );

  // 5. brain_submit_summary
  server.tool(
    'brain_submit_summary',
    'Submit a consolidated summary for verification and storage. Always redact any API keys, tokens, passwords, or other sensitive info before submitting. If the HTTP API returns 422, returns the 422 failure reason and exact details to the agent so it can see which citation did not resolve or which string was not verbatim.',
    {
      lease_id: z.string().describe('Lease ID obtained from brain_consolidate_candidates'),
      claims: z
        .array(
          z.object({
            text: z.string().describe('Claim text'),
            source_ids: z.array(z.string()).describe('IDs of source observations supporting this claim'),
          })
        )
        .describe('Array of claims with citations'),
      files_touched: z.array(z.string()).optional().describe('Files touched during this session'),
      error_verbatim: z.string().nullable().optional().describe('Verbatim error text if outcome was failure'),
    },
    async (args) => {
      return handlers.brainSubmitSummary(args);
    }
  );

  // 6. brain_action_add
  server.tool(
    'brain_action_add',
    'Create a Next Action to surface unfinished work, follow-ups, or blockers for future sessions. Scope is REQUIRED (project, global, or unknown).',
    {
      title: z.string().describe('Short, actionable title of the next action'),
      description: z.string().optional().describe('Detailed description or context for the next action'),
      scope: z.enum(['project', 'global', 'unknown']).describe("Scope: 'project', 'global', or 'unknown'. REQUIRED, never inferred!"),
      project_id: z
        .string()
        .optional()
        .describe("Required iff scope is 'project'. Use the project root folder name (from .brainrc or the git repo root), e.g. 'neuralbrain' — never a subfolder or filesystem path"),
      session_id: z.string().optional().describe('Optional session ID that created this action'),
      status: z.enum(['ready', 'blocked', 'in_progress', 'done', 'dismissed']).optional().describe("Action status ('ready', 'blocked', 'in_progress', 'done', 'dismissed')"),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe("Priority level ('low', 'normal', 'high', 'urgent')"),
      blocked_reason: z.string().optional().describe('Reason the action is blocked, if status is blocked'),
      files: z.array(z.string()).optional().describe('File paths associated with this action'),
    },
    async (args) => {
      return handlers.brainActionAdd(args);
    }
  );

  // 7. brain_action_list
  server.tool(
    'brain_action_list',
    'List Next Actions for a project (and optionally global actions), filtered by status.',
    {
      project_id: z
        .string()
        .optional()
        .describe('Project ID to filter by (use the project root folder name, e.g. "neuralbrain"; never a subfolder or filesystem path)'),
      include_global: z.boolean().optional().describe('Whether to include global actions when project_id is specified'),
      status: z.string().optional().describe("Filter by status (e.g. 'ready', 'in_progress', 'blocked', 'done')"),
      limit: z.number().int().optional().describe('Maximum number of actions to return'),
    },
    async (args) => {
      return handlers.brainActionList(args);
    }
  );

  // 8. brain_action_update
  server.tool(
    'brain_action_update',
    'Update an existing Next Action (status, priority, title, description, blocked_reason, or resolved_by_session_id).',
    {
      id: z.string().describe('ID of the action to update'),
      status: z.enum(['ready', 'blocked', 'in_progress', 'done', 'dismissed']).optional().describe("Updated status ('ready', 'blocked', 'in_progress', 'done', 'dismissed')"),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe("Updated priority ('low', 'normal', 'high', 'urgent')"),
      title: z.string().optional().describe('Updated title'),
      description: z.string().optional().describe('Updated description'),
      blocked_reason: z.string().optional().describe('Updated blocked reason'),
      resolved_by_session_id: z.string().optional().describe('Session ID that resolved this action'),
    },
    async (args) => {
      return handlers.brainActionUpdate(args);
    }
  );

  // 9. brain_sessions
  server.tool(
    'brain_sessions',
    'Inspect prior agent sessions: list sessions, fetch a single session with its details, or replay a session timeline chronologically.',
    {
      mode: z
        .enum(['list', 'get', 'replay'])
        .default('list')
        .describe("Operation mode: 'list' (default), 'get', or 'replay'"),
      session_id: z
        .string()
        .optional()
        .describe("Session ID (required when mode is 'get' or 'replay')"),
      project_id: z
        .string()
        .optional()
        .describe('Project ID to filter by when listing sessions (use the project root folder name, e.g. "neuralbrain"; never a subfolder or filesystem path)'),
      status: z.string().optional().describe("Filter sessions by status when listing (e.g. 'active', 'completed', 'paused', 'abandoned')"),
      agent_name: z.string().optional().describe('Filter sessions by agent name when listing'),
      limit: z.number().int().optional().describe('Maximum number of sessions to return when listing'),
    },
    async (args) => {
      return handlers.brainSessions(args);
    }
  );

  // 10. brain_session_end
  server.tool(
    'brain_session_end',
    'End or pause a session and record a clean cross-agent handoff summary, files touched, and optional handoff_summary_id.',
    {
      session_id: z.string().describe('ID of the session to end'),
      status: z
        .enum(['completed', 'paused', 'abandoned'])
        .optional()
        .describe("Final session status ('completed', 'paused', or 'abandoned')"),
      summary: z.string().optional().describe('Handoff summary for the next agent or session'),
      files_touched: z.array(z.string()).optional().describe('Files touched during this session'),
      handoff_summary_id: z.string().optional().describe('Optional derived summary ID linked as handoff'),
    },
    async (args) => {
      return handlers.brainSessionEnd(args);
    }
  );

  // 11. brain_graph
  server.tool(
    'brain_graph',
    'Explore the relational knowledge graph across notes, lessons, concepts, files, sessions, actions, and summaries.',
    {
      project_id: z
        .string()
        .optional()
        .describe('Project ID to filter by (use the project root folder name, e.g. "neuralbrain"; never a subfolder or filesystem path)'),
      scope: z
        .enum(['project', 'global', 'unknown'])
        .optional()
        .describe("Optional scope filter ('project', 'global', or 'unknown')"),
      limit: z.number().int().optional().describe('Maximum number of graph nodes to return'),
    },
    async (args) => {
      return handlers.brainGraph(args);
    }
  );

  return server;
}

if (require.main === module) {
  loadBrainEnv();
  const server = createBrainMcpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
  });
}
