# Troubleshooting neuralbrain Skills

## MCP Tool Not Available

If `brain_*` tools are missing or unresponsive:

1. **Check the service**: Run `neuralbrain status` (or `curl -s http://localhost:3737/health`). Start it with `neuralbrain start` if stopped.
2. **Run diagnostics**: Run `neuralbrain doctor` to verify SQLite, Qdrant, embedder config, and MCP server health.
3. **Check host MCP config**: Verify the `neuralbrain` MCP server is configured and reloaded in your host (e.g. `/mcp` in Claude Code or plugin reload in Antigravity). Re-run `neuralbrain install-agent` if paths changed.
4. **Do not confuse outages with empty results**: If a tool times out or errors, report the failure instead of claiming no memories or sessions exist.

## REST Fallback

If MCP is unavailable while the Brain HTTP service is running (default `http://localhost:3737`, or `BRAIN_API_URL` with `Authorization: Bearer $BRAIN_API_KEY`):

| Workflow | REST Endpoint |
|---|---|
| `search` | `POST /search`, `GET /failure-patterns`, `GET /graph` |
| `save` | `POST /notes` |
| `handoff` | `GET /sessions`, `GET /sessions/:id`, `GET /actions`, `POST /actions`, `PATCH /actions/:id`, `POST /sessions/:id/end` |
| `digest` | `GET /sessions`, `POST /search`, `GET /actions` |
| `consolidate` | `GET /consolidate/candidates`, `POST /consolidate/summaries` |

Never print or log `BRAIN_API_KEY` in output, and only send local credentials to loopback (`localhost` / `127.0.0.1`) or `https://` URLs.
