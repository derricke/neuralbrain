import { Router, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BrainMcpHandlers, createBrainMcpServer } from '../mcp/server';
import { resolveCanonicalProjectId } from '../lib/projectSlug';
import { logger } from '../lib/logger';
import { hybridSearch } from '../learning/search';
import { createNote } from '../memory/noteStore';
import { getFailurePatterns } from '../memory/failurePatternStore';
import { getConsolidationCandidates } from '../consolidation/candidates';
import { verifyAndStoreSummary } from '../consolidation/gate';
import { createAction, getDueActions, listActions, updateAction } from '../memory/actionStore';
import { endSession, getSessionDetails, getSessionReplay, listSessions } from '../memory/sessionStore';
import {
  getKnowledgeGraph,
  linkEntities,
  parseGraphQuery,
  unlinkEntities,
  upsertEntity,
} from '../memory/graphStore';

export const mcpRouter = Router();

function jsonText(data: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(err: unknown) {
  const anyErr = err as { code?: string; message?: string; details?: unknown };
  return jsonText(
    {
      error: {
        code: anyErr?.code || 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
        ...(anyErr?.details !== undefined ? { details: anyErr.details } : {}),
      },
    },
    true
  );
}

function clampLimit(raw: number | undefined, defaultLimit: number, maxLimit = 200): number {
  if (raw === undefined || !Number.isFinite(raw)) return defaultLimit;
  return Math.max(1, Math.min(Math.trunc(raw), maxLimit));
}

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

/**
 * Creates MCP tool handlers that call Brain's in-process store/learning functions directly,
 * avoiding loopback HTTP/TLS hops when /mcp is served inside the Brain Express process.
 */
export function createDirectBrainMcpHandlers(
  defaultProjectId = resolveCanonicalProjectId({ fallbackToDirname: false }) ?? undefined
): BrainMcpHandlers {
  return {
    brainSearch: async (args) => {
      try {
        const targetProjectId = args.project_id || defaultProjectId;
        const filters: Record<string, any> = {};
        if (args.type && args.type.length > 0) filters.type = args.type;
        if (args.file_path) filters.file_path = args.file_path;
        if (args.entity_type) filters.entity_type = args.entity_type;
        if (args.memory_layer) filters.memory_layer = args.memory_layer;
        if (args.user_id) filters.user_id = args.user_id;

        const requestedTypes =
          args.record_types && args.record_types.length > 0 ? args.record_types : args.grains;
        const data = await hybridSearch({
          q: args.q,
          record_types: (requestedTypes && requestedTypes.length > 0
            ? requestedTypes
            : ['note', 'trajectory']) as any,
          include_ancestors: args.include_ancestors !== false,
          include_children: Boolean(args.include_children),
          include_global: args.include_global !== false,
          include_history: Boolean(args.include_history),
          include_sources: Boolean(args.include_sources),
          ...(args.user_id !== undefined ? { user_id: args.user_id } : {}),
          ...(args.after !== undefined ? { after: args.after } : {}),
          ...(args.before !== undefined ? { before: args.before } : {}),
          ...(args.as_of !== undefined ? { as_of: args.as_of } : {}),
          ...(args.reference_date !== undefined ? { reference_date: args.reference_date } : {}),
          ...(args.temporal_bias !== undefined ? { temporal_bias: args.temporal_bias } : {}),
          ...(args.snippet_mode !== undefined ? { snippet_mode: args.snippet_mode } : {}),
          ...(args.max_record_chars !== undefined ? { max_record_chars: args.max_record_chars } : {}),
          ...(args.kind_weights !== undefined ? { kind_weights: args.kind_weights } : {}),
          ...(args.max_kind_share !== undefined ? { max_kind_share: args.max_kind_share } : {}),
          ...(args.sources_limit !== undefined ? { sources_limit: clampLimit(args.sources_limit, 20, 100) } : {}),
          ...(args.sources_offset !== undefined ? { sources_offset: Math.max(0, Math.trunc(args.sources_offset)) } : {}),
          limit: clampLimit(args.limit, 10, 100),
          ...(targetProjectId ? { project_id: targetProjectId, scope: 'project' as const } : {}),
          ...(Object.keys(filters).length > 0 ? { filters } : {}),
        });
        return jsonText(data);
      } catch (err) {
        return errorResult(err);
      }
    },

    brainSave: async (args) => {
      const check = validateScopeAndProject(args.scope, args.project_id, defaultProjectId);
      if (check.error) {
        return jsonText({ error: check.error }, true);
      }
      const effectiveProjectId = check.effectiveProjectId;
      try {
        const created = createNote({
          type: args.type,
          title: args.title,
          content: args.content,
          scope: args.scope as 'project' | 'global' | 'unknown',
          project_id: effectiveProjectId || null,
          projectId: effectiveProjectId || undefined,
          concepts: args.concepts || [],
          files: args.files || [],
          supersedes: args.supersedes || null,
          ...(args.session_id !== undefined ? { session_id: args.session_id } : {}),
          ...(args.user_id !== undefined ? { user_id: args.user_id } : {}),
          ...(args.agent_id !== undefined ? { agent_id: args.agent_id } : {}),
          ...(args.event_at !== undefined ? { event_at: args.event_at } : {}),
          ...(args.valid_from !== undefined ? { valid_from: args.valid_from } : {}),
          ...(args.valid_until !== undefined ? { valid_until: args.valid_until } : {}),
        });
        return jsonText(created);
      } catch (err) {
        return errorResult(err);
      }
    },

    brainRecentFailures: async (args) => {
      try {
        const targetProjectId = args?.project_id || defaultProjectId;
        const patterns = getFailurePatterns({
          projectId: targetProjectId,
          taskType: args?.task_type,
          includeAncestors: args?.include_ancestors !== false,
          includeChildren: Boolean(args?.include_children),
          includeGlobal: args?.include_global !== false,
          userId: args?.user_id,
          limit: clampLimit(args?.limit, 5, 200),
        });
        const result = patterns.map((p) => ({
          task_type: p.task_type,
          error_text: p.error_text,
          count: p.count,
          last_seen_at: p.last_seen_at,
          project_id: p.project_id ?? null,
          match_tier: p.match_tier ?? null,
        }));
        return jsonText(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    brainConsolidateCandidates: async (args) => {
      try {
        const targetProjectId = args?.project_id || defaultProjectId;
        const result = getConsolidationCandidates({
          projectId: targetProjectId,
          limit: args?.limit !== undefined ? clampLimit(args.limit, 5, 200) : undefined,
        });
        return jsonText(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    brainSubmitSummary: async (args) => {
      try {
        const result = verifyAndStoreSummary({
          lease_id: args.lease_id,
          claims: args.claims,
          files_touched: args.files_touched,
          error_verbatim: args.error_verbatim,
        });
        if (!result.ok) {
          return jsonText(
            {
              error: {
                code: result.reason,
                message: result.message,
                details: result.details,
              },
            },
            true
          );
        }
        return jsonText(result);
      } catch (err) {
        return errorResult(err);
      }
    },

    brainActionAdd: async (args) => {
      const check = validateScopeAndProject(args.scope, args.project_id, defaultProjectId);
      if (check.error) {
        return jsonText({ error: check.error }, true);
      }
      const effectiveProjectId = check.effectiveProjectId;
      try {
        const action = createAction({
          title: args.title,
          scope: args.scope as 'project' | 'global' | 'unknown',
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(effectiveProjectId ? { project_id: effectiveProjectId } : {}),
          ...(args.user_id !== undefined ? { user_id: args.user_id } : {}),
          ...(args.agent_id !== undefined ? { agent_id: args.agent_id } : {}),
          ...(args.session_id !== undefined ? { session_id: args.session_id } : {}),
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.blocked_reason !== undefined ? { blocked_reason: args.blocked_reason } : {}),
          ...(args.files !== undefined ? { files: args.files } : {}),
          ...(args.due_at !== undefined ? { due_at: args.due_at } : {}),
          ...(args.remind_at !== undefined ? { remind_at: args.remind_at } : {}),
          ...(args.recurrence !== undefined ? { recurrence: args.recurrence } : {}),
          ...(args.snooze_until !== undefined ? { snooze_until: args.snooze_until } : {}),
        });
        return jsonText({ action });
      } catch (err) {
        return errorResult(err);
      }
    },

    brainActionList: async (args = {}) => {
      try {
        const targetProjectId = args.project_id || defaultProjectId;
        const actions = listActions({
          projectId: targetProjectId,
          includeAncestors: args.include_ancestors !== false,
          includeChildren: Boolean(args.include_children),
          includeGlobal: args.include_global !== false,
          dueOnly: Boolean(args.due_only),
          before: args.before,
          userId: args.user_id,
          status: args.status,
          limit: args.limit !== undefined ? clampLimit(args.limit, 50, 200) : undefined,
        });
        return jsonText({ actions });
      } catch (err) {
        return errorResult(err);
      }
    },

    brainActionUpdate: async (args) => {
      try {
        const action = updateAction(args.id, {
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.priority !== undefined ? { priority: args.priority } : {}),
          ...(args.blocked_reason !== undefined ? { blocked_reason: args.blocked_reason } : {}),
          ...(args.resolved_by_session_id !== undefined
            ? { resolved_by_session_id: args.resolved_by_session_id }
            : {}),
          ...(args.due_at !== undefined ? { due_at: args.due_at } : {}),
          ...(args.remind_at !== undefined ? { remind_at: args.remind_at } : {}),
          ...(args.recurrence !== undefined ? { recurrence: args.recurrence } : {}),
          ...(args.snooze_until !== undefined ? { snooze_until: args.snooze_until } : {}),
          ...(args.user_id !== undefined ? { user_id: args.user_id } : {}),
          ...(args.agent_id !== undefined ? { agent_id: args.agent_id } : {}),
        });
        if (!action) {
          return jsonText(
            {
              error: {
                code: 'NOT_FOUND',
                message: `Action '${args.id}' not found`,
              },
            },
            true
          );
        }
        return jsonText({ action });
      } catch (err) {
        return errorResult(err);
      }
    },

    brainActionDue: async (args = {}) => {
      try {
        const targetProjectId = args.project_id || defaultProjectId;
        const actions = getDueActions({
          projectId: targetProjectId,
          includeAncestors: args.include_ancestors !== false,
          includeChildren: Boolean(args.include_children),
          includeGlobal: args.include_global !== false,
          before: args.before,
          userId: args.user_id,
          limit: args.limit !== undefined ? clampLimit(args.limit, 50, 200) : undefined,
        });
        return jsonText({ actions });
      } catch (err) {
        return errorResult(err);
      }
    },

    brainSessions: async (args = {}) => {
      try {
        const mode = args.mode || 'list';
        if (mode === 'get' || mode === 'replay') {
          if (!args.session_id) {
            return jsonText(
              {
                error: {
                  code: 'SCHEMA_INVALID',
                  message: `session_id is required when mode is '${mode}'`,
                },
              },
              true
            );
          }
          const result = mode === 'replay' ? getSessionReplay(args.session_id) : getSessionDetails(args.session_id);
          if (!result) {
            return jsonText(
              {
                error: {
                  code: 'NOT_FOUND',
                  message: `Session '${args.session_id}' not found`,
                },
              },
              true
            );
          }
          return jsonText(result);
        }

        const targetProjectId = args.project_id || defaultProjectId;
        const includeGlobal = targetProjectId
          ? (args.include_global === true)
          : args.include_global;
        const sessions = listSessions({
          projectId: targetProjectId,
          includeAncestors: args.include_ancestors !== false,
          includeChildren: Boolean(args.include_children),
          includeGlobal,
          userId: args.user_id,
          status: args.status,
          agentName: args.agent_name,
          limit: args.limit !== undefined ? clampLimit(args.limit, 50, 200) : undefined,
        });
        return jsonText({ sessions });
      } catch (err) {
        return errorResult(err);
      }
    },

    brainSessionEnd: async (args) => {
      try {
        const session = endSession(args.session_id, {
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(args.summary !== undefined ? { summary: args.summary } : {}),
          ...(args.files_touched !== undefined ? { files_touched: args.files_touched } : {}),
          ...(args.handoff_summary_id !== undefined ? { handoff_summary_id: args.handoff_summary_id } : {}),
        });
        if (!session) {
          return jsonText(
            {
              error: {
                code: 'NOT_FOUND',
                message: `Session '${args.session_id}' not found`,
              },
            },
            true
          );
        }
        return jsonText({ session });
      } catch (err) {
        return errorResult(err);
      }
    },

    brainGraph: async (args = {}) => {
      try {
        const mode = args.mode || 'query';

        if (mode === 'upsert_entity') {
          const check = validateScopeAndProject(args.scope, args.project_id, defaultProjectId);
          if (check.error) {
            return jsonText({ error: check.error }, true);
          }
          const entity = upsertEntity({
            id: args.entity_id ?? args.id,
            scope: args.scope,
            project_id: check.effectiveProjectId ?? null,
            entity_type: args.entity_type,
            name: args.name ?? '',
            description: args.description,
            external_ref: args.external_ref,
            metadata: args.metadata,
            user_id: args.user_id,
            agent_id: args.agent_id,
          });
          return jsonText({ entity });
        }

        if (mode === 'link') {
          const edge = linkEntities({
            source_type: args.source_type,
            source_id: args.source_id,
            target_type: args.target_type,
            target_id: args.target_id,
            relation: args.relation ?? '',
            metadata: args.metadata,
          });
          return jsonText({ edge });
        }

        if (mode === 'unlink') {
          const result = unlinkEntities({
            id: args.id,
            source_id: args.source_id,
            target_id: args.target_id,
            relation: args.relation,
          });
          return jsonText(result);
        }

        const targetProjectId =
          args.project_id || (args.scope === 'global' || args.scope === 'unknown' ? undefined : defaultProjectId);
        const graph = getKnowledgeGraph(
          parseGraphQuery({
            ...(targetProjectId ? { project_id: targetProjectId } : {}),
            ...(args.scope ? { scope: args.scope } : {}),
            ...(args.include_ancestors !== undefined ? { include_ancestors: args.include_ancestors } : {}),
            ...(args.include_children !== undefined ? { include_children: args.include_children } : {}),
            ...(args.include_global !== undefined ? { include_global: args.include_global } : {}),
            ...(args.depth !== undefined ? { depth: args.depth } : {}),
            ...(args.node_id ? { node_id: args.node_id } : {}),
            ...(args.entity_type ? { entity_type: args.entity_type } : {}),
            ...(args.relation ? { relation: args.relation } : {}),
            ...(args.user_id ? { user_id: args.user_id } : {}),
            ...(args.limit !== undefined ? { limit: clampLimit(args.limit, 50, 200) } : {}),
          })
        );
        return jsonText(graph);
      } catch (err) {
        return errorResult(err);
      }
    },
  };
}

const cachedDefaultProjectId = resolveCanonicalProjectId({ fallbackToDirname: false }) ?? undefined;
const cachedDirectHandlers = createDirectBrainMcpHandlers(cachedDefaultProjectId);

mcpRouter.all('/', async (req: Request, res: Response) => {
  const server = createBrainMcpServer({
    defaultProjectId: cachedDefaultProjectId,
    handlers: cachedDirectHandlers,
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on('close', () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ err }, 'MCP HTTP transport error');
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});
