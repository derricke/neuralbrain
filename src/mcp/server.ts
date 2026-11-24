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
  'check ready and due next actions (via /inject, brain_action_due, or brain_action_list) at task start before picking up work',
  '/inject content arrives unasked at task start; do not re-query for it',
  'use brain_sessions to inspect prior agent sessions or replay a session timeline when resuming work',
  'use brain_graph to explore multi-hop relationships or upsert/link persistent entities (upsert_entity, link, unlink) across notes, lessons, concepts, files, sessions, actions, entities, and summaries',
  'save a note when a correction or a non-obvious decision happens, not at session end when the detail is gone',
  'save a note via brain_save immediately when you fix a non-trivial bug, hit an unexpected gotcha, make an architectural decision, or receive a user correction',
  'before finishing any non-trivial task, verify whether any durable insight should be saved with brain_save',
  'if /inject includes a CONSOLIDATION REMINDER, let the user know and suggest they start a new session with an example prompt (e.g., "Consolidate the brain observations for this project.")',
  'when consolidating observations, redact any API keys, tokens, passwords, or other sensitive info before submitting via brain_submit_summary',
  'surface unfinished work, blockers, or scheduled follow-ups (due_at, remind_at, recurrence, snooze_until) via brain_action_add / brain_action_update and check overdue items with brain_action_due',
  'call brain_session_end at session completion or pause to record a clean cross-agent handoff summary',
  'pass scope: "unknown" rather than guessing',
  'for project scope, project_id is the project_id configured in .brainrc / .brain.json if present (that value wins over the folder name and may be a flat slug like "neuralbrain" or a hierarchical slash-path slug like "acme/socials/calendar"), otherwise the lowercase name of the git repo root (the main repo for a worktree), otherwise the folder the session started in — never a subfolder or filesystem path, so all agents come up with the same id; child subprojects automatically inherit parent project context while isolating sibling subprojects',
].join('\n');

function validateScopeAndProject(
  scope: string | undefined,
  projectId: string | undefined,
  defaultProjectId: string | undefined
): { effectiveProjectId?: string; error?: { code: string; message: string } } {
  if (!scope || (scope !== 'project' && scope !== 'global' && scope !== 'unknown')) {
    return {
      error: {
        code: 'SCOPE_REQUIRED',
        message: "SCOPE_REQUIRED: Scope is required and must be 'project', 'global', or 'unknown'",
      },
    };
  }

  const effectiveProjectId = projectId || (scope === 'project' ? defaultProjectId : undefined);
  if (scope === 'project' && !effectiveProjectId) {
    return {
      error: {
        code: 'SCHEMA_INVALID',
        message:
          "SCHEMA_INVALID: project_id is required when scope is 'project' (use the project_id in .brainrc if present, else the git repo root folder name, e.g. 'neuralbrain' or 'acme/socials/calendar', not a subfolder or filesystem path)",
      },
    };
  }

  return { effectiveProjectId };
}

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
    include_ancestors?: boolean;
    include_children?: boolean;
    include_global?: boolean;
    include_history?: boolean;
    user_id?: string;
    after?: string;
    before?: string;
    as_of?: string;
    temporal_bias?: 'none' | 'recent' | 'upcoming';
    snippet_mode?: 'query_focused' | 'condensed' | 'raw';
    max_record_chars?: number;
    kind_weights?: Partial<Record<'prompt' | 'response' | 'tool_call', number>>;
    max_kind_share?: Partial<Record<'prompt' | 'response' | 'tool_call', number>>;
    entity_type?: string;
    memory_layer?: 'semantic' | 'procedural';
    type?: string[];
    file_path?: string;
    include_sources?: boolean;
    sources_limit?: number;
    sources_offset?: number;
    limit?: number;
  }) => {
    const targetProjectId = args.project_id || defaultProjectId;
    const requestedTypes =
      args.record_types && args.record_types.length > 0 ? args.record_types : args.grains;
    const body: Record<string, any> = {
      q: args.q,
      record_types:
        requestedTypes && requestedTypes.length > 0 ? requestedTypes : ['note', 'trajectory'],
      include_ancestors: args.include_ancestors !== false,
      include_children: Boolean(args.include_children),
      include_global: args.include_global !== false,
      include_history: Boolean(args.include_history),
      include_sources: Boolean(args.include_sources),
      ...(args.user_id !== undefined ? { user_id: args.user_id } : {}),
      ...(args.after !== undefined ? { after: args.after } : {}),
      ...(args.before !== undefined ? { before: args.before } : {}),
      ...(args.as_of !== undefined ? { as_of: args.as_of } : {}),
      ...(args.temporal_bias !== undefined ? { temporal_bias: args.temporal_bias } : {}),
      ...(args.snippet_mode !== undefined ? { snippet_mode: args.snippet_mode } : {}),
      ...(args.max_record_chars !== undefined ? { max_record_chars: args.max_record_chars } : {}),
      ...(args.kind_weights !== undefined ? { kind_weights: args.kind_weights } : {}),
      ...(args.max_kind_share !== undefined ? { max_kind_share: args.max_kind_share } : {}),
      ...(args.sources_limit !== undefined ? { sources_limit: args.sources_limit } : {}),
      ...(args.sources_offset !== undefined ? { sources_offset: args.sources_offset } : {}),
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
    if (args.entity_type) {
      filters.entity_type = args.entity_type;
    }
    if (args.memory_layer) {
      filters.memory_layer = args.memory_layer;
    }
    if (args.user_id) {
      filters.user_id = args.user_id;
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
          content: [{ type: 'text' as const, text: JSON.stringify(data) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
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
    user_id?: string;
    agent_id?: string;
    session_id?: string;
    concepts?: string[];
    files?: string[];
    supersedes?: string;
    event_at?: string;
    valid_from?: string;
    valid_until?: string;
  }) => {
    const check = validateScopeAndProject(args.scope, args.project_id, defaultProjectId);
    if (check.error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: check.error }) }],
        isError: true,
      };
    }
    const effectiveProjectId = check.effectiveProjectId;

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
    if (args.session_id !== undefined) payload.session_id = args.session_id;
    if (args.user_id !== undefined) payload.user_id = args.user_id;
    if (args.agent_id !== undefined) payload.agent_id = args.agent_id;
    if (args.event_at !== undefined) payload.event_at = args.event_at;
    if (args.valid_from !== undefined) payload.valid_from = args.valid_from;
    if (args.valid_until !== undefined) payload.valid_until = args.valid_until;

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
          content: [{ type: 'text' as const, text: JSON.stringify(data) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `MCP Transport Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  };

  const brainRecentFailures = async (args: {
    project_id?: string;
    task_type?: string;
    include_ancestors?: boolean;
    include_children?: boolean;
    include_global?: boolean;
    user_id?: string;
    limit?: number;
  }) => {
    try {
      const targetProjectId = args.project_id || defaultProjectId;
      const query = new URLSearchParams();
      if (targetProjectId) query.set('project_id', targetProjectId);
      if (args.task_type) query.set('task_type', args.task_type);
      if (args.include_ancestors !== undefined) {
        query.set('include_ancestors', String(args.include_ancestors));
      }
      if (args.include_children !== undefined) {
        query.set('include_children', String(args.include_children));
      }
      if (args.include_global !== undefined) {
        query.set('include_global', String(args.include_global));
      }
      if (args.user_id) query.set('user_id', args.user_id);
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
          content: [{ type: 'text' as const, text: JSON.stringify(data) }],
          isError: true,
        };
      }

      const items = Array.isArray(data) ? data : [];
      const result = items.map((p: any) => ({
        task_type: p.task_type,
        error_text: p.error_text,
        count: p.count,
        last_seen_at: p.last_seen_at,
        project_id: p.project_id ?? null,
        match_tier: p.match_tier ?? null,
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify(data) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify(data) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
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
          content: [{ type: 'text' as const, text: JSON.stringify(data) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
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
    user_id?: string;
    agent_id?: string;
    session_id?: string;
    status?: 'ready' | 'blocked' | 'in_progress' | 'done' | 'dismissed';
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    blocked_reason?: string;
    files?: string[];
    due_at?: string;
    remind_at?: string;
    recurrence?: string;
    snooze_until?: string;
  }) => {
    const check = validateScopeAndProject(args.scope, args.project_id, defaultProjectId);
    if (check.error) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: check.error }) }],
        isError: true,
      };
    }
    const effectiveProjectId = check.effectiveProjectId;

    const payload: Record<string, any> = {
      title: args.title,
      scope: args.scope,
    };
    if (args.description !== undefined) payload.description = args.description;
    if (effectiveProjectId) payload.project_id = effectiveProjectId;
    if (args.user_id !== undefined) payload.user_id = args.user_id;
    if (args.agent_id !== undefined) payload.agent_id = args.agent_id;
    if (args.session_id !== undefined) payload.session_id = args.session_id;
    if (args.status !== undefined) payload.status = args.status;
    if (args.priority !== undefined) payload.priority = args.priority;
    if (args.blocked_reason !== undefined) payload.blocked_reason = args.blocked_reason;
    if (args.files !== undefined) payload.files = args.files;
    if (args.due_at !== undefined) payload.due_at = args.due_at;
    if (args.remind_at !== undefined) payload.remind_at = args.remind_at;
    if (args.recurrence !== undefined) payload.recurrence = args.recurrence;
    if (args.snooze_until !== undefined) payload.snooze_until = args.snooze_until;

    return requestJson(`${apiBaseUrl}/actions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(payload),
    });
  };

  const brainActionList = async (args: {
    project_id?: string;
    include_ancestors?: boolean;
    include_children?: boolean;
    include_global?: boolean;
    due_only?: boolean;
    before?: string;
    user_id?: string;
    status?: string;
    limit?: number;
  } = {}) => {
    const targetProjectId = args.project_id || defaultProjectId;
    const query = new URLSearchParams();
    if (targetProjectId) query.set('project_id', targetProjectId);
    if (args.include_ancestors !== undefined) {
      query.set('include_ancestors', String(args.include_ancestors));
    }
    if (args.include_children !== undefined) {
      query.set('include_children', String(args.include_children));
    }
    if (args.include_global !== undefined) query.set('include_global', String(args.include_global));
    if (args.due_only !== undefined) query.set('due_only', String(args.due_only));
    if (args.before) query.set('before', args.before);
    if (args.user_id) query.set('user_id', args.user_id);
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
    due_at?: string | null;
    remind_at?: string | null;
    recurrence?: string | null;
    snooze_until?: string | null;
    user_id?: string | null;
    agent_id?: string | null;
  }) => {
    const payload: Record<string, any> = {};
    if (args.status !== undefined) payload.status = args.status;
    if (args.priority !== undefined) payload.priority = args.priority;
    if (args.title !== undefined) payload.title = args.title;
    if (args.description !== undefined) payload.description = args.description;
    if (args.blocked_reason !== undefined) payload.blocked_reason = args.blocked_reason;
    if (args.resolved_by_session_id !== undefined) payload.resolved_by_session_id = args.resolved_by_session_id;
    if (args.due_at !== undefined) payload.due_at = args.due_at;
    if (args.remind_at !== undefined) payload.remind_at = args.remind_at;
    if (args.recurrence !== undefined) payload.recurrence = args.recurrence;
    if (args.snooze_until !== undefined) payload.snooze_until = args.snooze_until;
    if (args.user_id !== undefined) payload.user_id = args.user_id;
    if (args.agent_id !== undefined) payload.agent_id = args.agent_id;

    return requestJson(`${apiBaseUrl}/actions/${encodeURIComponent(args.id)}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify(payload),
    });
  };

  const brainActionDue = async (args: {
    project_id?: string;
    include_ancestors?: boolean;
    include_children?: boolean;
    include_global?: boolean;
    before?: string;
    user_id?: string;
    limit?: number;
  } = {}) => {
    const targetProjectId = args.project_id || defaultProjectId;
    const query = new URLSearchParams();
    if (targetProjectId) query.set('project_id', targetProjectId);
    if (args.include_ancestors !== undefined) {
      query.set('include_ancestors', String(args.include_ancestors));
    }
    if (args.include_children !== undefined) {
      query.set('include_children', String(args.include_children));
    }
    if (args.include_global !== undefined) query.set('include_global', String(args.include_global));
    if (args.before) query.set('before', args.before);
    if (args.user_id) query.set('user_id', args.user_id);
    if (args.limit !== undefined) query.set('limit', String(args.limit));

    const url = `${apiBaseUrl}/actions/due${query.toString() ? `?${query.toString()}` : ''}`;
    return requestJson(url, {
      method: 'GET',
      headers: authHeaders,
    });
  };

  const brainSessions = async (args: {
    mode?: 'list' | 'get' | 'replay';
    session_id?: string;
    project_id?: string;
    include_ancestors?: boolean;
    include_children?: boolean;
    include_global?: boolean;
    user_id?: string;
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
              text: JSON.stringify({
                error: {
                  code: 'SCHEMA_INVALID',
                  message: `session_id is required when mode is '${mode}'`,
                },
              }),
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
    if (args.include_ancestors !== undefined) {
      query.set('include_ancestors', String(args.include_ancestors));
    }
    if (args.include_children !== undefined) {
      query.set('include_children', String(args.include_children));
    }
    if (args.include_global !== undefined) {
      query.set('include_global', String(args.include_global));
    }
    if (args.user_id) query.set('user_id', args.user_id);
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
    mode?: 'query' | 'upsert_entity' | 'link' | 'unlink';
    project_id?: string;
    scope?: 'project' | 'global' | 'unknown' | string;
    include_ancestors?: boolean;
    include_children?: boolean;
    include_global?: boolean;
    depth?: number;
    node_id?: string;
    entity_type?: string;
    relation?: string;
    user_id?: string;
    agent_id?: string;
    id?: string;
    entity_id?: string;
    name?: string;
    description?: string;
    external_ref?: string;
    metadata?: Record<string, unknown> | string;
    source_type?: string;
    source_id?: string;
    target_type?: string;
    target_id?: string;
    limit?: number;
  } = {}) => {
    const mode = args.mode || 'query';

    if (mode === 'upsert_entity') {
      const check = validateScopeAndProject(args.scope, args.project_id, defaultProjectId);
      if (check.error) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: check.error }) }],
          isError: true,
        };
      }
      const payload: Record<string, any> = {
        scope: args.scope,
      };
      if (check.effectiveProjectId) payload.project_id = check.effectiveProjectId;
      const entityId = args.entity_id ?? args.id;
      if (entityId !== undefined) payload.id = entityId;
      if (args.entity_type !== undefined) payload.entity_type = args.entity_type;
      if (args.name !== undefined) payload.name = args.name;
      if (args.description !== undefined) payload.description = args.description;
      if (args.external_ref !== undefined) payload.external_ref = args.external_ref;
      if (args.metadata !== undefined) payload.metadata = args.metadata;
      if (args.user_id !== undefined) payload.user_id = args.user_id;
      if (args.agent_id !== undefined) payload.agent_id = args.agent_id;

      return requestJson(`${apiBaseUrl}/graph/entities`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(payload),
      });
    }

    if (mode === 'link') {
      const payload: Record<string, any> = {};
      if (args.source_type !== undefined) payload.source_type = args.source_type;
      if (args.source_id !== undefined) payload.source_id = args.source_id;
      if (args.target_type !== undefined) payload.target_type = args.target_type;
      if (args.target_id !== undefined) payload.target_id = args.target_id;
      if (args.relation !== undefined) payload.relation = args.relation;
      if (args.metadata !== undefined) payload.metadata = args.metadata;

      return requestJson(`${apiBaseUrl}/graph/edges`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(payload),
      });
    }

    if (mode === 'unlink') {
      const payload: Record<string, any> = {};
      if (args.id !== undefined) payload.id = args.id;
      if (args.source_id !== undefined) payload.source_id = args.source_id;
      if (args.target_id !== undefined) payload.target_id = args.target_id;
      if (args.relation !== undefined) payload.relation = args.relation;

      return requestJson(`${apiBaseUrl}/graph/edges`, {
        method: 'DELETE',
        headers: authHeaders,
        body: JSON.stringify(payload),
      });
    }

    const targetProjectId =
      args.project_id || (args.scope === 'global' || args.scope === 'unknown' ? undefined : defaultProjectId);
    const query = new URLSearchParams();
    if (targetProjectId) query.set('project_id', targetProjectId);
    if (args.scope) query.set('scope', args.scope);
    if (args.include_ancestors !== undefined) {
      query.set('include_ancestors', String(args.include_ancestors));
    }
    if (args.include_children !== undefined) {
      query.set('include_children', String(args.include_children));
    }
    if (args.include_global !== undefined) {
      query.set('include_global', String(args.include_global));
    }
    if (args.depth !== undefined) query.set('depth', String(args.depth));
    if (args.node_id) query.set('node_id', args.node_id);
    if (args.entity_type) query.set('entity_type', args.entity_type);
    if (args.relation) query.set('relation', args.relation);
    if (args.user_id) query.set('user_id', args.user_id);
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
    brainActionDue,
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
      version: '0.0.2',
    },
    {
      instructions: MCP_INSTRUCTIONS,
    }
  );

  const handlers = options.handlers ?? createBrainMcpHandlers(options);

  // 1. brain_search
  server.tool(
    'brain_search',
    'Search across memories, trajectories, observations, summaries, entities, and actions with 3-signal hybrid dense + FTS5 BM25 + Entity-Graph RRF retrieval. Surfaces "degraded" verbatim when vector search is unavailable so the agent can tell BM25-only results from hybrid ones. Call before starting non-trivial work.',
    {
      q: z.string().describe('Search query text'),
      record_types: z
        .array(z.string())
        .default(['note', 'trajectory'])
        .describe(
          "Memory record types to search (default: ['note', 'trajectory']). Options: 'note' (curated facts/decisions/bugs), 'trajectory' (session outcome rollups), 'summary' (consolidated session claims, touched files, and verbatim errors), 'observation' (raw tool calls/prompts), 'entity' (persistent entity nodes), 'action' (Next Actions and reminders)."
        ),
      project_id: z
        .string()
        .optional()
        .describe('Project ID or hierarchical slug (e.g. "neuralbrain" or "acme/socials/calendar"); omit for global-only. Never pass a filesystem path.'),
      include_ancestors: z
        .boolean()
        .default(true)
        .describe('Whether to include ancestor projects when project_id is hierarchical (default true)'),
      include_children: z
        .boolean()
        .default(false)
        .describe('Whether to include child subprojects below project_id (default false)'),
      include_global: z.boolean().default(true).describe('Whether to include global records when project_id is specified'),
      include_history: z
        .boolean()
        .default(false)
        .describe('Whether to include superseded historical versions of notes and summaries (default false)'),
      user_id: z.string().optional().describe('Optional user_id filter'),
      after: z.string().optional().describe('ISO-8601 lower bound timestamp filter'),
      before: z.string().optional().describe('ISO-8601 upper bound timestamp filter'),
      as_of: z.string().optional().describe('ISO-8601 point-in-time validity filter for notes (valid_from <= as_of <= valid_until)'),
      temporal_bias: z
        .enum(['none', 'recent', 'upcoming'])
        .optional()
        .describe("Optional temporal ranking bias ('none', 'recent', or 'upcoming')"),
      snippet_mode: z
        .enum(['query_focused', 'condensed', 'raw'])
        .optional()
        .describe(
          "Observation snippet mode: 'query_focused' (default — extracts query-matching passages from full observation text), 'condensed' (uses precomputed extractive condensed_text), or 'raw' (full raw input/output)"
        ),
      max_record_chars: z
        .number()
        .int()
        .min(32)
        .max(100000)
        .optional()
        .describe('Optional character budget cap for returned observation fields and snippet'),
      kind_weights: z
        .object({
          prompt: z.number().min(0.1).max(5).optional(),
          response: z.number().min(0.1).max(5).optional(),
          tool_call: z.number().min(0.1).max(5).optional(),
        })
        .optional()
        .describe('Optional per-kind score multipliers overriding intent-aware defaults for observations'),
      max_kind_share: z
        .object({
          prompt: z.number().gt(0).max(1).optional(),
          response: z.number().gt(0).max(1).optional(),
          tool_call: z.number().gt(0).max(1).optional(),
        })
        .optional()
        .describe('Optional maximum result-set share (0..1] per observation kind with score-ordered backfill'),
      entity_type: z
        .string()
        .optional()
        .describe("Optional entity_type filter (e.g. 'brand', 'person', 'asset', 'metric', 'document', 'tool')"),
      memory_layer: z
        .enum(['semantic', 'procedural'])
        .optional()
        .describe("Optional note layer filter: 'semantic' (fact/architecture/preference) or 'procedural' (workflow/pattern/lesson/bug)"),
      type: z.array(z.string()).optional().describe('Note type filter (fact, architecture, pattern, workflow, bug, preference, lesson)'),
      file_path: z.string().optional().describe('File path filter ("what do we know about this file?")'),
      include_sources: z
        .boolean()
        .default(false)
        .describe('Include paginated source provenance entries (with observation titles) on summary results (default false)'),
      sources_limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe('Maximum number of source entries per summary when include_sources is true (default 20)'),
      sources_offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Offset into summary sources for pagination when include_sources is true (default 0)'),
      limit: z.number().int().min(1).max(100).default(10).describe('Maximum number of results to return'),
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
          "Required iff scope is 'project'. Use the project root folder name or hierarchical slug (e.g. 'neuralbrain' or 'acme/socials/calendar') — never a filesystem path. If unsure, use scope 'unknown'"
        ),
      user_id: z.string().optional().describe('Optional user_id attribution'),
      agent_id: z.string().optional().describe('Optional agent_id provenance (stored, never filtered)'),
      session_id: z.string().optional().describe('Optional session ID that authored this note'),
      concepts: z.array(z.string()).optional().describe('Concepts associated with this note'),
      files: z.array(z.string()).optional().describe('File paths associated with this note'),
      supersedes: z.string().optional().describe('Previous note id being superseded'),
      event_at: z.string().optional().describe('Optional ISO-8601 timestamp when the event occurred'),
      valid_from: z.string().optional().describe('Optional ISO-8601 start of fact validity window'),
      valid_until: z.string().optional().describe('Optional ISO-8601 end of fact validity window'),
    },
    async (args) => {
      return handlers.brainSave(args);
    }
  );

  // 3. brain_recent_failures
  server.tool(
    'brain_recent_failures',
    'Retrieve recent failure patterns and counts. Returns { task_type, error_text, count, last_seen_at, project_id, match_tier }[] where count is from SQL.',
    {
      project_id: z
        .string()
        .optional()
        .describe('Project ID or hierarchical slug to filter by (never a filesystem path); omit for global'),
      task_type: z.string().optional().describe('Task type filter'),
      include_ancestors: z
        .boolean()
        .default(true)
        .describe('Whether to include ancestor projects when project_id is hierarchical (default true)'),
      include_children: z
        .boolean()
        .default(false)
        .describe('Whether to include child subprojects below project_id (default false)'),
      include_global: z
        .boolean()
        .default(true)
        .describe('Whether to include global failure patterns when project_id is specified (default true)'),
      user_id: z.string().optional().describe('Optional user_id filter'),
      limit: z.number().int().min(1).max(200).default(5).describe('Maximum number of failures to return'),
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
      limit: z.number().int().min(1).max(200).optional().describe('Maximum number of candidate leases to retrieve'),
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
    'Create a Next Action (or scheduled/recurring reminder) to surface unfinished work, follow-ups, or blockers for future sessions. Scope is REQUIRED (project, global, or unknown).',
    {
      title: z.string().describe('Short, actionable title of the next action'),
      description: z.string().optional().describe('Detailed description or context for the next action'),
      scope: z.enum(['project', 'global', 'unknown']).describe("Scope: 'project', 'global', or 'unknown'. REQUIRED, never inferred!"),
      project_id: z
        .string()
        .optional()
        .describe("Required iff scope is 'project'. Use the project root folder name or hierarchical slug (e.g. 'neuralbrain' or 'acme/socials/calendar') — never a filesystem path"),
      user_id: z.string().optional().describe('Optional user_id attribution'),
      agent_id: z.string().optional().describe('Optional agent_id provenance (stored, never filtered)'),
      session_id: z.string().optional().describe('Optional session ID that created this action'),
      status: z.enum(['ready', 'blocked', 'in_progress', 'done', 'dismissed']).optional().describe("Action status ('ready', 'blocked', 'in_progress', 'done', 'dismissed')"),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe("Priority level ('low', 'normal', 'high', 'urgent')"),
      blocked_reason: z.string().optional().describe('Reason the action is blocked, if status is blocked'),
      files: z.array(z.string()).optional().describe('File paths associated with this action'),
      due_at: z.string().optional().describe('Optional ISO-8601 due date/time (normalized to UTC)'),
      remind_at: z.string().optional().describe('Optional ISO-8601 reminder trigger date/time (normalized to UTC)'),
      recurrence: z.string().optional().describe("Optional recurrence expression: 5-field UTC cron, macro (@daily, @weekly), or ISO-8601 duration (P1D, P1W, PT2H)"),
      snooze_until: z.string().optional().describe('Optional ISO-8601 timestamp until which reminders are snoozed'),
    },
    async (args) => {
      return handlers.brainActionAdd(args);
    }
  );

  // 7. brain_action_list
  server.tool(
    'brain_action_list',
    'List Next Actions for a project (and optionally ancestors, children, and global actions), filtered by status, due_only, before, or user_id.',
    {
      project_id: z
        .string()
        .optional()
        .describe('Project ID or hierarchical slug to filter by (never a filesystem path)'),
      include_ancestors: z
        .boolean()
        .default(true)
        .describe('Whether to include ancestor projects when project_id is hierarchical (default true)'),
      include_children: z
        .boolean()
        .default(false)
        .describe('Whether to include child subprojects below project_id (default false)'),
      include_global: z.boolean().optional().describe('Whether to include global actions when project_id is specified (default true)'),
      due_only: z.boolean().optional().describe('When true, return only open actions that are currently due/reminded and not snoozed'),
      before: z.string().optional().describe('ISO-8601 upper bound cutoff for due_at / remind_at'),
      user_id: z.string().optional().describe('Optional user_id filter'),
      status: z.string().optional().describe("Filter by status (e.g. 'ready', 'in_progress', 'blocked', 'done')"),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum number of actions to return'),
    },
    async (args) => {
      return handlers.brainActionList(args);
    }
  );

  // 8. brain_action_update
  server.tool(
    'brain_action_update',
    'Update an existing Next Action (status, priority, title, description, blocked_reason, due_at, remind_at, recurrence, snooze_until, user_id, agent_id, or resolved_by_session_id). Completing a recurring action spawns its next occurrence.',
    {
      id: z.string().describe('ID of the action to update'),
      status: z.enum(['ready', 'blocked', 'in_progress', 'done', 'dismissed']).optional().describe("Updated status ('ready', 'blocked', 'in_progress', 'done', 'dismissed')"),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe("Updated priority ('low', 'normal', 'high', 'urgent')"),
      title: z.string().optional().describe('Updated title'),
      description: z.string().optional().describe('Updated description'),
      blocked_reason: z.string().optional().describe('Updated blocked reason'),
      resolved_by_session_id: z.string().optional().describe('Session ID that resolved this action'),
      due_at: z.string().nullable().optional().describe('Updated ISO-8601 due date/time (or null to clear)'),
      remind_at: z.string().nullable().optional().describe('Updated ISO-8601 reminder trigger date/time (or null to clear)'),
      recurrence: z.string().nullable().optional().describe('Updated cron/macro/ISO-8601 recurrence expression (or null to clear)'),
      snooze_until: z.string().nullable().optional().describe('Updated ISO-8601 snooze cutoff timestamp (or null to clear)'),
      user_id: z.string().nullable().optional().describe('Updated user_id attribution (or null to clear)'),
      agent_id: z.string().nullable().optional().describe('Updated agent_id provenance (or null to clear)'),
    },
    async (args) => {
      return handlers.brainActionUpdate(args);
    }
  );

  // 9. brain_action_due
  server.tool(
    'brain_action_due',
    'List due, reminded, or overdue Next Actions that are open and not snoozed.',
    {
      project_id: z
        .string()
        .optional()
        .describe('Project ID or hierarchical slug to filter by (never a filesystem path)'),
      include_ancestors: z
        .boolean()
        .default(true)
        .describe('Whether to include ancestor projects when project_id is hierarchical (default true)'),
      include_children: z
        .boolean()
        .default(false)
        .describe('Whether to include child subprojects below project_id (default false)'),
      include_global: z
        .boolean()
        .default(true)
        .describe('Whether to include global actions when project_id is specified (default true)'),
      before: z.string().optional().describe('ISO-8601 upper bound cutoff timestamp (defaults to now)'),
      user_id: z.string().optional().describe('Optional user_id filter'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum number of due actions to return'),
    },
    async (args) => {
      return handlers.brainActionDue(args);
    }
  );

  // 10. brain_sessions
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
        .describe('Project ID or hierarchical slug to filter by when listing sessions (never a filesystem path)'),
      include_ancestors: z
        .boolean()
        .default(true)
        .describe('Whether to include ancestor projects when listing sessions (default true)'),
      include_children: z
        .boolean()
        .default(false)
        .describe('Whether to include child subprojects when listing sessions (default false)'),
      include_global: z
        .boolean()
        .default(false)
        .describe('Whether to include global sessions when project_id is specified (default false)'),
      user_id: z.string().optional().describe('Optional user_id filter when listing sessions'),
      status: z.string().optional().describe("Filter sessions by status when listing (e.g. 'active', 'completed', 'paused', 'abandoned')"),
      agent_name: z.string().optional().describe('Filter sessions by agent name when listing'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum number of sessions to return when listing'),
    },
    async (args) => {
      return handlers.brainSessions(args);
    }
  );

  // 11. brain_session_end
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

  // 12. brain_graph
  server.tool(
    'brain_graph',
    'Explore or mutate the relational knowledge graph across notes, lessons, concepts, files, sessions, actions, entities, and summaries. Supports mode: query (1..3 hop BFS), upsert_entity (requires explicit scope), link, and unlink.',
    {
      mode: z
        .enum(['query', 'upsert_entity', 'link', 'unlink'])
        .default('query')
        .describe("Operation mode: 'query' (default), 'upsert_entity', 'link', or 'unlink'"),
      project_id: z
        .string()
        .optional()
        .describe('Project ID or hierarchical slug (required iff mode is upsert_entity and scope is project; never a filesystem path)'),
      scope: z
        .enum(['project', 'global', 'unknown'])
        .optional()
        .describe("Scope ('project', 'global', or 'unknown'). REQUIRED when mode is 'upsert_entity'"),
      include_ancestors: z
        .boolean()
        .default(true)
        .describe('Whether to include ancestor projects in query mode (default true)'),
      include_children: z
        .boolean()
        .default(false)
        .describe('Whether to include child subprojects in query mode (default false)'),
      include_global: z
        .boolean()
        .default(false)
        .describe('Whether to include global nodes in query mode (default false)'),
      depth: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe('Multi-hop BFS depth across entity_edges in query mode (1..3, default 1)'),
      node_id: z.string().optional().describe('Optional focal node ID to expand from in query mode'),
      entity_type: z
        .string()
        .optional()
        .describe("Entity type (required when mode is 'upsert_entity', optional filter in 'query' mode; e.g. 'brand', 'person', 'asset', 'metric', 'document', 'tool')"),
      relation: z
        .string()
        .optional()
        .describe("Edge relation (required for 'link', optional filter for 'query'/'unlink'; e.g. 'part_of', 'depends_on', 'references', 'owns', 'produced_by', 'blocks', 'related_to')"),
      user_id: z.string().optional().describe('Optional user_id attribution/filter'),
      agent_id: z.string().optional().describe('Optional agent_id provenance (stored, never filtered)'),
      id: z.string().optional().describe("Entity ID (for upsert_entity) or Edge ID (for unlink)"),
      entity_id: z.string().optional().describe("Optional explicit entity ID alias for mode='upsert_entity'"),
      name: z.string().optional().describe("Entity display name (required when mode is 'upsert_entity')"),
      description: z.string().optional().describe("Entity description (for mode='upsert_entity')"),
      external_ref: z.string().optional().describe("External URI/ID pointer (for mode='upsert_entity', e.g. 's3://...', 'https://...')"),
      metadata: z
        .union([z.record(z.string(), z.unknown()), z.string()])
        .optional()
        .describe('Optional JSON object or JSON string metadata for entity or edge'),
      source_type: z.string().optional().describe("Source node type for mode='link' (auto-resolved if omitted)"),
      source_id: z.string().optional().describe("Source node ID (required for 'link', optional for 'unlink')"),
      target_type: z.string().optional().describe("Target node type for mode='link' (auto-resolved if omitted)"),
      target_id: z.string().optional().describe("Target node ID (required for 'link', optional for 'unlink')"),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum number of seed graph nodes to return in query mode'),
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
