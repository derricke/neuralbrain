import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';
import { normalizeProjectId } from '../lib/scope';
import {
  getBrainDataDir,
  getBrainEnvCandidates,
  getBrainHooksDir,
  getBrainMcpDir,
} from '../lib/brainHome';

export interface InstallAgentOptions {
  homeDir?: string; // defaults to os.homedir() (overridable in tests)
  brainRepoDir?: string; // defaults to path.resolve(__dirname, '../..')
  projectDir?: string; // optional target workspace directory to initialize .brainrc & rules
  projectId?: string; // optional explicit canonical project_id slug
  apiUrl?: string; // defaults to env, .env, or 'http://127.0.0.1:3737'
  apiKey?: string; // optional API key (prefers env, .env, or <brainRepoDir>/data/api-key.txt)
  targets?: Array<'antigravity' | 'claude' | 'cursor' | 'project'>; // defaults to global or project depending on projectDir
  replaceAgentMemory?: boolean; // defaults to false (preserves other plugins/agentmemory unless opted in)
  enableHooks?: boolean; // defaults to true
  dryRun?: boolean; // defaults to false
  global?: boolean; // if true alongside projectDir, installs both global and project
}

export interface InstallAgentReport {
  success: boolean;
  dryRun: boolean;
  configuredTargets: Array<'antigravity' | 'claude' | 'cursor' | 'project'>;
  createdFiles: string[];
  modifiedFiles: string[];
  skippedFiles: string[];
  warnings: string[];
  projectId?: string;
}

export interface McpServerDefinition {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export const BRAIN_BLOCK_START = '<!-- neuralbrain:start -->';
export const BRAIN_BLOCK_END = '<!-- neuralbrain:end -->';
export const AGENTMEMORY_BLOCK_START = '<!-- agentmemory:start -->';
export const AGENTMEMORY_BLOCK_END = '<!-- agentmemory:end -->';

const BRAIN_BLOCK_REGEX =
  /<!-- neuralbrain:start -->[\s\S]*?<!-- neuralbrain:end -->/;
const AGENTMEMORY_BLOCK_REGEX = /<!-- agentmemory:start -->[\s\S]*?<!-- agentmemory:end -->/;

/**
 * Generates the standardized instruction block teaching agents how to use neuralbrain.
 */
export function generateBrainRuleBlock(defaultProjectId?: string): string {
  const projectScopeDesc = defaultProjectId
    ? `Use for repository-specific knowledge. You MUST supply project_id: if .brainrc (or .brain.json) in the project or an ancestor folder sets project_id, use that value verbatim (it wins over the folder name and may be a flat slug like 'neuralbrain' or a hierarchical slash-path slug like 'acme/socials/calendar'). Otherwise use the lowercase name of the project's ROOT folder: the git repository root (for a worktree, the main repository), otherwise the folder the session started in. Never a subfolder you are working in, never a filesystem path (current default: '${defaultProjectId}').`
    : `Use for repository-specific knowledge. You MUST supply project_id: if .brainrc (or .brain.json) in the project or an ancestor folder sets project_id, use that value verbatim (it wins over the folder name and may be a flat slug like 'neuralbrain' or a hierarchical slash-path slug like 'acme/socials/calendar'). Otherwise use the lowercase name of the project's ROOT folder: the git repository root (for a worktree, the main repository), otherwise the folder the session started in. Never a subfolder you are working in, never a filesystem path. If the root is ambiguous, run \`neuralbrain init\` there rather than guessing.`;
  const exampleProjectId = defaultProjectId || 'my-project';

  return [
    BRAIN_BLOCK_START,
    '## Persistent Memory (neuralbrain)',
    '',
    'You have persistent memory via the `neuralbrain` MCP server.',
    'Available tools: `brain_search`, `brain_save`, `brain_recent_failures`, `brain_consolidate_candidates`, `brain_submit_summary`.',
    '',
    '### Workflow & Rules',
    '- **At the start of a task or session**:',
    '  - Call `brain_recent_failures` to check for active failure patterns or bugs in this project.',
    '  - Call `brain_search` with your task context to load relevant past architectural decisions, patterns, and conventions (default `record_types`: `["note", "trajectory"]`).',
    '  - **When to also search `summary` (`record_types: ["note", "trajectory", "summary"]` or `["summary"]`)**:',
    '    - Resuming work on a file or feature where you need to see what a previous session changed (`files_touched` and literal claims).',
    '    - Debugging a recurring or historical error (`error_verbatim` across past sessions).',
    '    - Default `brain_search` returns nothing because no curated `note` was saved yet.',
    '  - If `SessionStart` / `/inject` shows a `CONSOLIDATION REMINDER`, let the user know and suggest they start a new session with an example prompt (e.g., `"Consolidate the brain observations for this project."`).',
    '- **When to save notes (`brain_save`) — DO NOT wait until session end**:',
    '  - **Bug / root cause fixed** (`type: "bug"` or `"lesson"`): You diagnosed a non-obvious error, race condition, or config mismatch.',
    '  - **Architectural or design decision** (`type: "architecture"`): You or the user chose a pattern, library, schema, or trade-off.',
    '  - **Gotcha / environment quirk** (`type: "fact"` or `"lesson"`): You hit an undocumented API behavior, build/deploy constraint, or silent failure.',
    '  - **Project convention or workflow** (`type: "pattern"` or `"workflow"`): You discovered or established a repo-specific convention or command sequence.',
    '  - **User correction or preference** (`type: "preference"` or `"lesson"`): The user corrected your approach or stated how they want things done.',
    '  - **Before concluding any non-trivial task**, ask yourself: *"What would save the next agent 10 minutes?"* If anything qualifies, call `brain_save` before your final response.',
    '  - **What NOT to save**: Routine file reads, obvious edits, or raw tool logs (observations are captured automatically).',
    '- **Example `brain_save` call**:',
    `  \`brain_save({ type: "bug", title: "Cloud Functions require explicit CORS origin", content: "Firebase callable/HTTP functions fail preflight in staging unless...", scope: "project", project_id: "${exampleProjectId}", files: ["functions/src/index.ts"], concepts: ["cors", "firebase"] })\``,
    '- **Scope Discipline (Rule 4)**: Explicit scope is mandatory (`project`, `global`, or `unknown`):',
    `  - \`scope: "project"\`: ${projectScopeDesc}`,
    '  - `scope: "global"`: Use ONLY for universal truths across all projects, environments, and languages.',
    '  - `scope: "unknown"`: Default fallback only when project scope is genuinely unknown.',
    BRAIN_BLOCK_END,
  ].join('\n');
}

/**
 * Generates the standardized brain-memory SKILL.md content for Antigravity.
 */
export function generateBrainSkillContent(): string {
  return [
    '---',
    'name: brain-memory',
    'description: Persistent memory and failure pattern injection via neuralbrain. Use to search past learnings, record durable project insights, and check known failure patterns.',
    '---',
    '',
    '# neuralbrain Persistent Memory',
    '',
    '## At Task Start',
    '1. Check `brain_recent_failures` to avoid repeating known mistakes.',
    '2. Search prior solutions, conventions, and architecture with `brain_search` (defaults to `record_types: ["note", "trajectory"]`).',
    '3. Include `"summary"` in `record_types` (e.g. `record_types: ["note", "trajectory", "summary"]`) when resuming work on a file, debugging a recurring error, or when no curated `note` exists yet.',
    '4. If `CONSOLIDATION REMINDER` appears in session context, let the user know and suggest they start a new session with an example prompt (e.g., `"Consolidate the brain observations for this project."`).',
    '',
    '## When to Save Notes (`brain_save`)',
    'Tool-call observations are captured automatically as telemetry, **not** as notes. Call `brain_save` immediately (or before finishing your task) whenever you:',
    '- Fix a non-trivial bug or uncover a subtle root cause (`type: "bug"` or `"lesson"`).',
    '- Make or change an architectural/design decision (`type: "architecture"`).',
    '- Discover an undocumented gotcha, environment constraint, or API quirk (`type: "fact"` or `"lesson"`).',
    '- Establish or uncover a project convention or workflow (`type: "pattern"` or `"workflow"`).',
    '- Receive a correction or preference from the user (`type: "preference"` or `"lesson"`).',
    '',
    'Keep notes concise and factual, include `files` and `concepts`, and always pass explicit `scope` (`"project"` with `project_id` folder slug, `"global"`, or `"unknown"`).',
    '',
    '## Consolidation (`brain_consolidate_candidates` / `brain_submit_summary`)',
    'When asked by the user to consolidate observations for a project, call `brain_consolidate_candidates` and submit strictly literal, observation-cited extractions via `brain_submit_summary`. Always redact any API keys, tokens, passwords, or other sensitive info before submitting.',
    '',
  ].join('\n');
}

/**
 * Idempotently updates or appends the neuralbrain rule block in markdown documentation.
 * Replaces any existing neuralbrain block in place.
 * If replaceAgentMemory is true, replaces legacy agentmemory blocks.
 * Otherwise appends cleanly to the end of the file.
 */
export function upsertBrainRuleBlock(
  markdownContent: string,
  defaultProjectId?: string,
  replaceAgentMemory = false
): string {
  const block = generateBrainRuleBlock(defaultProjectId);

  if (BRAIN_BLOCK_REGEX.test(markdownContent)) {
    return markdownContent.replace(BRAIN_BLOCK_REGEX, block);
  }

  if (replaceAgentMemory && AGENTMEMORY_BLOCK_REGEX.test(markdownContent)) {
    return markdownContent.replace(AGENTMEMORY_BLOCK_REGEX, block);
  }

  const trimmed = markdownContent.trimEnd();
  if (!trimmed) {
    return `${block}\n`;
  }
  return `${trimmed}\n\n${block}\n`;
}

/**
 * Parses an environment file into key-value pairs without modifying process.env.
 */
function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return dotenv.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Returns prioritized candidates for .env file lookups.
 */
function getEnvCandidates(brainRepoDir: string, projectDir?: string, homeDir?: string): string[] {
  const candidates: string[] = [];
  if (projectDir) {
    candidates.push(path.join(projectDir, '.env.local'));
    candidates.push(path.join(projectDir, '.env'));
  }
  candidates.push(path.join(brainRepoDir, '.env.local'));
  candidates.push(path.join(brainRepoDir, '.env'));
  candidates.push(...getBrainEnvCandidates(homeDir));
  return candidates;
}

/**
 * Resolves optional API key in prioritized order:
 * 1. options.apiKey (programmatic option)
 * 2. process.env.BRAIN_API_KEY
 * 3. Parsed from ${projectDir}/.env, ${brainRepoDir}/.env, or ~/.neuralbrain/.env (.env.local has priority)
 * 4. ~/.neuralbrain/data/api-key.txt or <brainRepoDir>/data/api-key.txt
 */
export function resolveApiKey(
  options: InstallAgentOptions,
  brainRepoDir: string,
  projectDir?: string,
  homeDir?: string
): string | undefined {
  if (options.apiKey && options.apiKey.trim()) {
    return options.apiKey.trim();
  }
  if (process.env.BRAIN_API_KEY && process.env.BRAIN_API_KEY.trim()) {
    return process.env.BRAIN_API_KEY.trim();
  }
  for (const envPath of getEnvCandidates(brainRepoDir, projectDir, homeDir)) {
    const parsed = parseEnvFile(envPath);
    if (parsed.BRAIN_API_KEY && parsed.BRAIN_API_KEY.trim()) {
      return parsed.BRAIN_API_KEY.trim();
    }
  }
  const keyFileCandidates = [
    path.join(getBrainDataDir(homeDir), 'api-key.txt'),
    path.join(brainRepoDir, 'data', 'api-key.txt'),
  ];
  for (const keyFilePath of keyFileCandidates) {
    if (fs.existsSync(keyFilePath)) {
      try {
        const content = fs.readFileSync(keyFilePath, 'utf8').trim();
        if (content) {
          return content;
        }
      } catch {
        // Ignore file read errors
      }
    }
  }
  return undefined;
}

/**
 * Resolves API URL in prioritized order:
 * 1. options.apiUrl (programmatic option)
 * 2. process.env.BRAIN_API_URL
 * 3. Parsed from ${projectDir}/.env, ${brainRepoDir}/.env, or ~/.neuralbrain/.env (BRAIN_API_URL, or http://127.0.0.1:${PORT})
 * 4. process.env.PORT
 * 5. Default 'http://127.0.0.1:3737'
 */
export function resolveApiUrl(
  options: InstallAgentOptions,
  brainRepoDir: string,
  projectDir?: string,
  homeDir?: string
): string {
  if (options.apiUrl && options.apiUrl.trim()) {
    return options.apiUrl.trim();
  }
  if (process.env.BRAIN_API_URL && process.env.BRAIN_API_URL.trim()) {
    return process.env.BRAIN_API_URL.trim();
  }
  for (const envPath of getEnvCandidates(brainRepoDir, projectDir, homeDir)) {
    const parsed = parseEnvFile(envPath);
    if (parsed.BRAIN_API_URL && parsed.BRAIN_API_URL.trim()) {
      return parsed.BRAIN_API_URL.trim();
    }
    if (parsed.PORT && parsed.PORT.trim()) {
      const portNum = parseInt(parsed.PORT.trim(), 10);
      if (!Number.isNaN(portNum) && portNum > 0) {
        return `http://127.0.0.1:${portNum}`;
      }
    }
  }
  if (process.env.PORT && process.env.PORT.trim()) {
    const portNum = parseInt(process.env.PORT.trim(), 10);
    if (!Number.isNaN(portNum) && portNum > 0) {
      return `http://127.0.0.1:${portNum}`;
    }
  }
  return 'http://127.0.0.1:3737';
}

/**
 * Derives and normalizes a canonical project_id slug from options or directory path.
 */
function resolveProjectSlug(rawDir: string, explicitId?: string): string {
  if (explicitId && explicitId.trim()) {
    const res = normalizeProjectId(explicitId);
    if (!res.ok) {
      throw new Error(`Invalid explicit projectId '${explicitId}': ${res.error}`);
    }
    return res.projectId;
  }

  const folderName = path.basename(path.resolve(rawDir));
  const directRes = normalizeProjectId(folderName);
  if (directRes.ok) {
    return directRes.projectId;
  }

  // Attempt sanitizing non-standard folder names (e.g. spaces, special chars)
  const sanitized = folderName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const sanitizedRes = normalizeProjectId(sanitized);
  if (sanitizedRes.ok) {
    return sanitizedRes.projectId;
  }

  throw new Error(
    `Could not determine canonical project_id from directory '${rawDir}' (folder '${folderName}'): ${directRes.error}`
  );
}

function isClaudeHookRegistered(list: any[], scriptName: string): boolean {
  return list.some((item: any) => {
    if (typeof item === 'string') return item.includes(scriptName);
    if (item && typeof item.command === 'string') return item.command.includes(scriptName);
    if (item && Array.isArray(item.hooks)) {
      return item.hooks.some(
        (h: any) => h && typeof h.command === 'string' && h.command.includes(scriptName)
      );
    }
    return false;
  });
}

/**
 * Formats a `node <scriptPath>` hook command, quoting the script path when it
 * contains whitespace (e.g., Windows user directories like `C:\Users\John Doe\...`).
 */
export function formatNodeHookCommand(scriptPath: string): string {
  return /\s/.test(scriptPath) ? `node "${scriptPath}"` : `node ${scriptPath}`;
}

export function installRuntimeHooks(
  homeDir: string,
  brainRepoDir: string,
  dryRun: boolean,
  report: InstallAgentReport
): string {
  const installedHooksDir = getBrainHooksDir(homeDir);
  const installedHooksLibDir = path.join(installedHooksDir, 'lib');

  const hookFiles = ['sessionStart.js', 'postToolUse.js', 'sessionStop.js'];
  for (const file of hookFiles) {
    let srcPath = path.join(brainRepoDir, 'plugin', 'hooks', file);
    if (!fs.existsSync(srcPath)) {
      const fallback = path.resolve(__dirname, '../../plugin/hooks', file);
      if (fs.existsSync(fallback)) srcPath = fallback;
    }
    if (fs.existsSync(srcPath)) {
      const content = fs.readFileSync(srcPath, 'utf8');
      safeWriteFile(path.join(installedHooksDir, file), content, dryRun, report);
      if (!dryRun) {
        try {
          fs.chmodSync(path.join(installedHooksDir, file), 0o755);
        } catch {
          // Ignore chmod errors on systems that don't support it
        }
      }
    }
  }

  // Copy helper libraries to hooks/lib/
  const libFiles = ['projectSlug.js', 'spool.js', 'scope.js', 'brainHome.js', 'logger.js', 'redactSecrets.js', 'tls.js'];
  for (const file of libFiles) {
    let srcPath = path.join(brainRepoDir, 'dist', 'lib', file);
    if (!fs.existsSync(srcPath)) {
      const fallback = path.resolve(__dirname, '../lib', file);
      if (fs.existsSync(fallback)) {
        srcPath = fallback;
      } else {
        const distFallback = path.resolve(__dirname, '../../dist/lib', file);
        if (fs.existsSync(distFallback)) srcPath = distFallback;
      }
    }
    if (fs.existsSync(srcPath)) {
      const content = fs.readFileSync(srcPath, 'utf8');
      safeWriteFile(path.join(installedHooksLibDir, file), content, dryRun, report);
    }
  }

  // Write zero-dependency shims for dotenv and pino in hooks/lib/node_modules/
  // so installed hooks under ~/.neuralbrain/hooks/ are self-contained.
  const hooksNodeModulesDir = path.join(installedHooksLibDir, 'node_modules');
  const dotenvShim = [
    'const fs = require("fs");',
    'function parse(src) {',
    '  const out = {};',
    '  for (const rawLine of String(src).split(/\\r?\\n/)) {',
    '    const line = rawLine.trim();',
    '    if (!line || line.startsWith("#")) continue;',
    '    const cleaned = line.startsWith("export ") ? line.slice(7).trim() : line;',
    '    const eq = cleaned.indexOf("=");',
    '    if (eq <= 0) continue;',
    '    const key = cleaned.slice(0, eq).trim();',
    '    let val = cleaned.slice(eq + 1).trim();',
    '    if ((val.startsWith("\\"") && val.endsWith("\\"")) || (val.startsWith("\'") && val.endsWith("\'"))) {',
    '      val = val.slice(1, -1);',
    '    }',
    '    out[key] = val;',
    '  }',
    '  return out;',
    '}',
    'function config(opts) {',
    '  try {',
    '    const p = opts && opts.path ? opts.path : ".env";',
    '    if (!fs.existsSync(p)) return { parsed: {} };',
    '    const parsed = parse(fs.readFileSync(p, "utf8"));',
    '    const override = Boolean(opts && opts.override);',
    '    for (const [k, v] of Object.entries(parsed)) {',
    '      if (override || !(k in process.env)) process.env[k] = v;',
    '    }',
    '    return { parsed };',
    '  } catch (err) {',
    '    return { error: err };',
    '  }',
    '}',
    'module.exports = { parse, config, default: { parse, config } };',
    '',
  ].join('\n');
  safeWriteFile(path.join(hooksNodeModulesDir, 'dotenv', 'index.js'), dotenvShim, dryRun, report);

  const pinoShim = [
    'function noop() {}',
    'function writeErr(level, objOrMsg, msg) {',
    '  const text = typeof objOrMsg === "string" ? objOrMsg : (msg || JSON.stringify(objOrMsg));',
    '  process.stderr.write(`[neuralbrain:${level}] ${text}\\n`);',
    '}',
    'function pino() {',
    '  const log = {',
    '    trace: noop,',
    '    debug: noop,',
    '    info: noop,',
    '    warn: (a, b) => writeErr("warn", a, b),',
    '    error: (a, b) => writeErr("error", a, b),',
    '    fatal: (a, b) => writeErr("fatal", a, b),',
    '    child: () => log,',
    '  };',
    '  return log;',
    '}',
    'module.exports = pino;',
    'module.exports.default = pino;',
    '',
  ].join('\n');
  safeWriteFile(path.join(hooksNodeModulesDir, 'pino', 'index.js'), pinoShim, dryRun, report);

  // Also copy dist/mcp/server.js to ~/.neuralbrain/mcp/
  const installedMcpDir = getBrainMcpDir(homeDir);
  let mcpSrc = path.join(brainRepoDir, 'dist', 'mcp', 'server.js');
  if (!fs.existsSync(mcpSrc)) {
    const fallback = path.resolve(__dirname, '../mcp/server.js');
    if (fs.existsSync(fallback)) {
      mcpSrc = fallback;
    } else {
      const distFallback = path.resolve(__dirname, '../../dist/mcp/server.js');
      if (fs.existsSync(distFallback)) mcpSrc = distFallback;
    }
  }
  if (fs.existsSync(mcpSrc)) {
    const content = fs.readFileSync(mcpSrc, 'utf8');
    safeWriteFile(path.join(installedMcpDir, 'server.js'), content, dryRun, report);
  }

  return installedHooksDir;
}

/**
 * Resolves the source skills directory from brainRepoDir/plugin/skills (or fallback).
 */
function resolveSourceSkillsDir(brainRepoDir: string): string | null {
  const candidate = path.join(brainRepoDir, 'plugin', 'skills');
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    return candidate;
  }
  const fallback = path.resolve(__dirname, '../../plugin/skills');
  if (fs.existsSync(fallback) && fs.statSync(fallback).isDirectory()) {
    return fallback;
  }
  return null;
}

/**
 * Copies all skill directories from sourceSkillsDir into canonicalDestDir idempotently,
 * returning the list of installed skill names.
 */
function syncCanonicalSkills(
  brainRepoDir: string,
  canonicalDestDir: string,
  dryRun: boolean,
  report: InstallAgentReport
): string[] {
  const sourceSkillsDir = resolveSourceSkillsDir(brainRepoDir);
  if (!sourceSkillsDir) {
    // Fallback for mock test directories that lack plugin/skills/
    safeWriteFile(
      path.join(canonicalDestDir, 'brain-memory', 'SKILL.md'),
      generateBrainSkillContent(),
      dryRun,
      report
    );
    return ['brain-memory'];
  }

  const skillDirs = fs
    .readdirSync(sourceSkillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const skillName of skillDirs) {
    const srcSkillPath = path.join(sourceSkillsDir, skillName);
    const destSkillPath = path.join(canonicalDestDir, skillName);
    const files = fs.readdirSync(srcSkillPath, { withFileTypes: true }).filter((f) => f.isFile());
    for (const file of files) {
      const content = fs.readFileSync(path.join(srcSkillPath, file.name), 'utf8');
      safeWriteFile(path.join(destSkillPath, file.name), content, dryRun, report);
    }
  }

  return skillDirs;
}

/**
 * Creates or verifies a symlink from linkSkillsDir/<skillName> -> canonicalSkillsDir/<skillName>.
 * Falls back to copying files if symlinks are not supported.
 */
function linkSkillsIntoTarget(
  skillNames: string[],
  canonicalSkillsDir: string,
  linkSkillsDir: string,
  dryRun: boolean,
  report: InstallAgentReport
): void {
  for (const skillName of skillNames) {
    const canonicalDir = path.join(canonicalSkillsDir, skillName);
    const linkPath = path.join(linkSkillsDir, skillName);

    let alreadyLinked = false;
    let exists = false;
    try {
      const stat = fs.lstatSync(linkPath);
      exists = true;
      if (stat.isSymbolicLink()) {
        const target = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
        if (target === path.resolve(canonicalDir)) {
          alreadyLinked = true;
        }
      }
    } catch {
      exists = false;
    }

    if (alreadyLinked) {
      report.skippedFiles.push(linkPath);
      continue;
    }

    if (exists) {
      report.modifiedFiles.push(linkPath);
    } else {
      report.createdFiles.push(linkPath);
    }

    if (dryRun) {
      continue;
    }

    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    if (exists) {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
    try {
      fs.symlinkSync(canonicalDir, linkPath, 'dir');
    } catch {
      // Fallback to copying if symlinks are restricted
      if (fs.existsSync(canonicalDir)) {
        const files = fs.readdirSync(canonicalDir, { withFileTypes: true }).filter((f) => f.isFile());
        for (const file of files) {
          const content = fs.readFileSync(path.join(canonicalDir, file.name), 'utf8');
          fs.mkdirSync(linkPath, { recursive: true });
          fs.writeFileSync(path.join(linkPath, file.name), content, 'utf8');
        }
      }
    }
  }
}

function safeReadJson<T = any>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeWriteFile(
  filePath: string,
  content: string,
  dryRun: boolean,
  report: InstallAgentReport,
  mode?: number
): void {
  const exists = fs.existsSync(filePath);
  if (exists) {
    try {
      const existingContent = fs.readFileSync(filePath, 'utf8');
      if (existingContent === content) {
        report.skippedFiles.push(filePath);
        return;
      }
    } catch {
      // Fall through to write
    }
    report.modifiedFiles.push(filePath);
  } else {
    report.createdFiles.push(filePath);
  }

  if (!dryRun) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, mode !== undefined ? { encoding: 'utf8', mode } : 'utf8');
    if (mode !== undefined) {
      try {
        fs.chmodSync(filePath, mode);
      } catch {
        // Ignore chmod errors on platforms that don't support posix permissions
      }
    }
  }
}

function safeWriteJson(
  filePath: string,
  data: any,
  dryRun: boolean,
  report: InstallAgentReport,
  mode?: number
): void {
  const content = JSON.stringify(data, null, 2) + '\n';
  safeWriteFile(filePath, content, dryRun, report, mode);
}

/**
 * Safely merges neuralbrain MCP server into an existing or new MCP config object.
 */
function mergeMcpConfig(
  existingConfig: any,
  serverDef: McpServerDefinition,
  replaceAgentMemory: boolean
): any {
  const config = existingConfig && typeof existingConfig === 'object' ? { ...existingConfig } : {};
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  } else {
    config.mcpServers = { ...config.mcpServers };
  }

  config.mcpServers['neuralbrain'] = serverDef;

  if (replaceAgentMemory && config.mcpServers['agentmemory']) {
    delete config.mcpServers['agentmemory'];
  }

  return config;
}

/**
 * Installs and configures multi-agent integration for neuralbrain.
 */
export function installAgentIntegration(options: InstallAgentOptions = {}): InstallAgentReport {
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const brainRepoDir = path.resolve(options.brainRepoDir || path.resolve(__dirname, '../..'));
  const projectDir = options.projectDir ? path.resolve(options.projectDir) : undefined;
  const apiUrl = resolveApiUrl(options, brainRepoDir, projectDir, homeDir);
  const apiKey = resolveApiKey(options, brainRepoDir, projectDir, homeDir);
  const replaceAgentMemory = Boolean(options.replaceAgentMemory);
  const enableHooks = options.enableHooks !== false;
  const dryRun = Boolean(options.dryRun);

  // Target selection logic:
  // - If options.targets is explicitly passed, honor it.
  // - Else if projectDir is provided: default to ['project'] ONLY (or add globals if options.global is true).
  // - Else: default to global agents ['antigravity', 'claude', 'cursor'].
  let requestedTargets: Array<'antigravity' | 'claude' | 'cursor' | 'project'>;
  if (options.targets && options.targets.length > 0) {
    requestedTargets = options.targets;
  } else if (projectDir) {
    requestedTargets = options.global
      ? ['antigravity', 'claude', 'cursor', 'project']
      : ['project'];
  } else {
    requestedTargets = ['antigravity', 'claude', 'cursor'];
  }

  const report: InstallAgentReport = {
    success: true,
    dryRun,
    configuredTargets: [],
    createdFiles: [],
    modifiedFiles: [],
    skippedFiles: [],
    warnings: [],
  };

  if (options.apiKey) {
    report.warnings.push(
      'API key was provided directly. Setting BRAIN_API_KEY in .env is recommended to prevent credential leakage in command history or process listings.'
    );
  }

  const globalMcpServerDef: McpServerDefinition = {
    command: 'neuralbrain',
    args: ['mcp'],
    env: {
      BRAIN_API_URL: apiUrl,
      ...(apiKey ? { BRAIN_API_KEY: apiKey } : {}),
    },
  };

  const installedHooksDir = getBrainHooksDir(homeDir);
  const hasGlobalTargets = requestedTargets.some((t) => t !== 'project');
  if (enableHooks && hasGlobalTargets) {
    installRuntimeHooks(homeDir, brainRepoDir, dryRun, report);
  }

  const globalCanonicalSkillsDir = path.join(homeDir, '.agents', 'skills');
  const globalSkillNames = hasGlobalTargets
    ? syncCanonicalSkills(brainRepoDir, globalCanonicalSkillsDir, dryRun, report)
    : [];

  // ---------------------------------------------------------------------------
  // Target 1: Antigravity (Global)
  // ---------------------------------------------------------------------------
  if (requestedTargets.includes('antigravity')) {
    const pluginDir = path.join(homeDir, '.gemini', 'config', 'plugins', 'neuralbrain');

    // 1. plugin.json
    const pluginManifestPath = path.join(pluginDir, 'plugin.json');
    safeWriteJson(
      pluginManifestPath,
      {
        name: 'neuralbrain',
        displayName: 'neuralbrain',
        version: '0.1.0',
        description: 'neuralbrain persistent memory service integration for Antigravity',
      },
      dryRun,
      report
    );

    // 2. mcp_config.json in plugin (Streamable HTTP /mcp endpoint, not stdio)
    const mcpUrl = `${apiUrl.replace(/\/+$/, '')}/mcp`;
    const antigravityMcpServerDef = {
      serverUrl: mcpUrl,
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
    };
    const pluginMcpPath = path.join(pluginDir, 'mcp_config.json');
    safeWriteJson(
      pluginMcpPath,
      {
        mcpServers: {
          neuralbrain: antigravityMcpServerDef,
        },
      },
      dryRun,
      report,
      0o600
    );

    // 3. hooks.json in plugin
    const pluginHooksPath = path.join(pluginDir, 'hooks.json');
    const sessionStartHook = formatNodeHookCommand(path.join(installedHooksDir, 'sessionStart.js'));
    const postToolUseHook = formatNodeHookCommand(path.join(installedHooksDir, 'postToolUse.js'));
    const sessionStopHook = formatNodeHookCommand(path.join(installedHooksDir, 'sessionStop.js'));

    safeWriteJson(
      pluginHooksPath,
      {
        neuralbrain: {
          enabled: enableHooks,
          SessionStart: [
            {
              type: 'command',
              command: sessionStartHook,
              timeout: 30,
            },
          ],
          PostToolUse: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command: postToolUseHook,
                  timeout: 30,
                },
              ],
            },
          ],
          Stop: [
            {
              type: 'command',
              command: sessionStopHook,
              timeout: 30,
            },
          ],
        },
      },
      dryRun,
      report
    );

    // 4. rules/AGENTS.md in plugin
    const pluginRulesPath = path.join(pluginDir, 'rules', 'AGENTS.md');
    const pluginRulesExisting = fs.existsSync(pluginRulesPath)
      ? fs.readFileSync(pluginRulesPath, 'utf8')
      : '';
    safeWriteFile(
      pluginRulesPath,
      upsertBrainRuleBlock(pluginRulesExisting, undefined, false),
      dryRun,
      report
    );

    // 5. Link canonical skills into plugin/skills/
    linkSkillsIntoTarget(
      globalSkillNames,
      globalCanonicalSkillsDir,
      path.join(pluginDir, 'skills'),
      dryRun,
      report
    );

    // 6. Global GEMINI.md
    const geminiMdPath = path.join(homeDir, '.gemini', 'GEMINI.md');
    const existingGeminiMd = fs.existsSync(geminiMdPath) ? fs.readFileSync(geminiMdPath, 'utf8') : '';
    const updatedGeminiMd = upsertBrainRuleBlock(existingGeminiMd, undefined, replaceAgentMemory);
    safeWriteFile(geminiMdPath, updatedGeminiMd, dryRun, report);

    report.configuredTargets.push('antigravity');
  }

  // ---------------------------------------------------------------------------
  // Target 2: Claude Code (Global)
  // ---------------------------------------------------------------------------
  if (requestedTargets.includes('claude')) {
    // 1. ~/.claude.json
    const claudeJsonPath = path.join(homeDir, '.claude.json');
    const existingClaudeJson = safeReadJson(claudeJsonPath) || { mcpServers: {} };
    const mergedClaudeJson = mergeMcpConfig(existingClaudeJson, globalMcpServerDef, replaceAgentMemory);
    safeWriteJson(claudeJsonPath, mergedClaudeJson, dryRun, report, 0o600);

    // 2. ~/.claude/settings.json (hooks)
    if (enableHooks) {
      const settingsPath = path.join(homeDir, '.claude', 'settings.json');
      const settings = safeReadJson(settingsPath) || {};
      if (!settings.hooks || typeof settings.hooks !== 'object') {
        settings.hooks = {};
      }

      const hookEvents: Array<{
        event: 'SessionStart' | 'PostToolUse' | 'Stop' | 'SessionEnd';
        script: string;
        matcher: string;
      }> = [
        { event: 'SessionStart', script: 'sessionStart.js', matcher: '' },
        { event: 'PostToolUse', script: 'postToolUse.js', matcher: '*' },
        { event: 'Stop', script: 'sessionStop.js', matcher: '' },
        { event: 'SessionEnd', script: 'sessionStop.js', matcher: '' },
      ];

      for (const { event, script, matcher } of hookEvents) {
        const cmd = formatNodeHookCommand(path.join(installedHooksDir, script));
        const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
        const existingIdx = list.findIndex((item: any) => {
          if (typeof item === 'string') return item.includes(script);
          if (item && typeof item.command === 'string') return item.command.includes(script);
          if (item && Array.isArray(item.hooks)) {
            return item.hooks.some(
              (h: any) => h && typeof h.command === 'string' && h.command.includes(script)
            );
          }
          return false;
        });

        const hookEntry = {
          matcher,
          hooks: [
            {
              type: 'command',
              command: cmd,
              timeout: 30,
            },
          ],
        };

        if (existingIdx >= 0) {
          list[existingIdx] = hookEntry;
        } else {
          list.push(hookEntry);
        }
        settings.hooks[event] = list;
      }
      safeWriteJson(settingsPath, settings, dryRun, report);
    }

    // 3. ~/.claude/CLAUDE.md
    const claudeMdPath = path.join(homeDir, '.claude', 'CLAUDE.md');
    const existingClaudeMd = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf8') : '';
    const updatedClaudeMd = upsertBrainRuleBlock(existingClaudeMd, undefined, replaceAgentMemory);
    safeWriteFile(claudeMdPath, updatedClaudeMd, dryRun, report);

    // 3. Symlink skills into ~/.claude/skills/ only if ~/.claude exists
    if (fs.existsSync(path.join(homeDir, '.claude'))) {
      linkSkillsIntoTarget(
        globalSkillNames,
        globalCanonicalSkillsDir,
        path.join(homeDir, '.claude', 'skills'),
        dryRun,
        report
      );
    }

    report.configuredTargets.push('claude');
  }

  // ---------------------------------------------------------------------------
  // Target 3: Cursor (Global)
  // ---------------------------------------------------------------------------
  if (requestedTargets.includes('cursor')) {
    const cursorMcpPath = path.join(homeDir, '.cursor', 'mcp.json');
    const existingCursorJson = safeReadJson(cursorMcpPath) || { mcpServers: {} };
    const mergedCursorJson = mergeMcpConfig(existingCursorJson, globalMcpServerDef, replaceAgentMemory);
    safeWriteJson(cursorMcpPath, mergedCursorJson, dryRun, report, 0o600);

    report.configuredTargets.push('cursor');
  }

  // ---------------------------------------------------------------------------
  // Target 4: Workspace Project Directory
  // ---------------------------------------------------------------------------
  if (requestedTargets.includes('project')) {
    if (projectDir) {
      const normalizedSlug = resolveProjectSlug(projectDir, options.projectId);
      report.projectId = normalizedSlug;

      const projectMcpServerDef: McpServerDefinition = {
        command: 'neuralbrain',
        args: ['mcp'],
        env: {
          BRAIN_API_URL: apiUrl,
          BRAIN_DEFAULT_PROJECT_ID: normalizedSlug,
        },
      };

      // 1. Write <projectDir>/.brainrc
      const brainrcPath = path.join(projectDir, '.brainrc');
      safeWriteJson(brainrcPath, { project_id: normalizedSlug }, dryRun, report);

      // 2. Project-level Claude Code: <projectDir>/.mcp.json and <projectDir>/.claude/settings.json
      const projectClaudeMcpPath = path.join(projectDir, '.mcp.json');
      const existingClaudeMcp = safeReadJson(projectClaudeMcpPath) || { mcpServers: {} };
      const mergedClaudeMcp = mergeMcpConfig(existingClaudeMcp, projectMcpServerDef, replaceAgentMemory);
      safeWriteJson(projectClaudeMcpPath, mergedClaudeMcp, dryRun, report, 0o600);

      if (enableHooks) {
        const projectClaudeSettingsPath = path.join(projectDir, '.claude', 'settings.json');
        const projectClaudeSettings = safeReadJson(projectClaudeSettingsPath) || {};
        if (!projectClaudeSettings.hooks || typeof projectClaudeSettings.hooks !== 'object') {
          projectClaudeSettings.hooks = {};
        }

        const hookEvents: Array<{
          event: 'SessionStart' | 'PostToolUse' | 'Stop' | 'SessionEnd';
          script: string;
          matcher: string;
        }> = [
          { event: 'SessionStart', script: 'sessionStart.js', matcher: '' },
          { event: 'PostToolUse', script: 'postToolUse.js', matcher: '*' },
          { event: 'Stop', script: 'sessionStop.js', matcher: '' },
          { event: 'SessionEnd', script: 'sessionStop.js', matcher: '' },
        ];

        for (const { event, script, matcher } of hookEvents) {
          const cmd = formatNodeHookCommand(path.join(installedHooksDir, script));
          const list = Array.isArray(projectClaudeSettings.hooks[event])
            ? projectClaudeSettings.hooks[event]
            : [];
          const existingIdx = list.findIndex((item: any) => {
            if (typeof item === 'string') return item.includes(script);
            if (item && typeof item.command === 'string') return item.command.includes(script);
            if (item && Array.isArray(item.hooks)) {
              return item.hooks.some(
                (h: any) => h && typeof h.command === 'string' && h.command.includes(script)
              );
            }
            return false;
          });

          const hookEntry = {
            matcher,
            hooks: [
              {
                type: 'command',
                command: cmd,
                timeout: 30,
              },
            ],
          };

          if (existingIdx >= 0) {
            list[existingIdx] = hookEntry;
          } else {
            list.push(hookEntry);
          }
          projectClaudeSettings.hooks[event] = list;
        }
        safeWriteJson(projectClaudeSettingsPath, projectClaudeSettings, dryRun, report);
      }

      // 3. Project-level Antigravity: <projectDir>/.gemini/hooks.json and skills/brain-memory/SKILL.md
      if (enableHooks) {
        const projectGeminiHooksPath = path.join(projectDir, '.gemini', 'hooks.json');
        const sessionStartHook = formatNodeHookCommand(path.join(installedHooksDir, 'sessionStart.js'));
        const postToolUseHook = formatNodeHookCommand(path.join(installedHooksDir, 'postToolUse.js'));
        const sessionStopHook = formatNodeHookCommand(path.join(installedHooksDir, 'sessionStop.js'));

        const existingProjectHooksRaw = safeReadJson(projectGeminiHooksPath);
        const existingProjectHooks =
          existingProjectHooksRaw &&
          typeof existingProjectHooksRaw === 'object' &&
          !Array.isArray(existingProjectHooksRaw)
            ? existingProjectHooksRaw
            : {};

        safeWriteJson(
          projectGeminiHooksPath,
          {
            ...existingProjectHooks,
            neuralbrain: {
              enabled: true,
              SessionStart: [
                {
                  type: 'command',
                  command: sessionStartHook,
                  timeout: 30,
                },
              ],
              PostToolUse: [
                {
                  matcher: '*',
                  hooks: [
                    {
                      type: 'command',
                      command: postToolUseHook,
                      timeout: 30,
                    },
                  ],
                },
              ],
              Stop: [
                {
                  type: 'command',
                  command: sessionStopHook,
                  timeout: 30,
                },
              ],
            },
          },
          dryRun,
          report
        );
      }

      const projectCanonicalSkillsDir = path.join(projectDir, '.agents', 'skills');
      const projectSkillNames = syncCanonicalSkills(
        brainRepoDir,
        projectCanonicalSkillsDir,
        dryRun,
        report
      );
      linkSkillsIntoTarget(
        projectSkillNames,
        projectCanonicalSkillsDir,
        path.join(projectDir, '.gemini', 'skills'),
        dryRun,
        report
      );
      if (fs.existsSync(path.join(projectDir, '.claude'))) {
        linkSkillsIntoTarget(
          projectSkillNames,
          projectCanonicalSkillsDir,
          path.join(projectDir, '.claude', 'skills'),
          dryRun,
          report
        );
      }

      // 4. Project-level Cursor: <projectDir>/.cursor/mcp.json
      const projectCursorMcpPath = path.join(projectDir, '.cursor', 'mcp.json');
      const existingCursorMcp = safeReadJson(projectCursorMcpPath) || { mcpServers: {} };
      const mergedCursorMcp = mergeMcpConfig(existingCursorMcp, projectMcpServerDef, replaceAgentMemory);
      safeWriteJson(projectCursorMcpPath, mergedCursorMcp, dryRun, report, 0o600);

      // 5. Project-level Rules (<projectDir>/CLAUDE.md / AGENTS.md)
      const isBrainRepo = projectDir === brainRepoDir;
      if (!isBrainRepo) {
        const projectClaudeMd = path.join(projectDir, 'CLAUDE.md');
        const projectAgentsMd = path.join(projectDir, 'AGENTS.md');
        const hasClaudeMd = fs.existsSync(projectClaudeMd);
        const hasAgentsMd = fs.existsSync(projectAgentsMd);

        if (hasClaudeMd) {
          const content = fs.readFileSync(projectClaudeMd, 'utf8');
          const updated = upsertBrainRuleBlock(content, normalizedSlug, replaceAgentMemory);
          safeWriteFile(projectClaudeMd, updated, dryRun, report);
        }

        if (hasAgentsMd) {
          const content = fs.readFileSync(projectAgentsMd, 'utf8');
          const updated = upsertBrainRuleBlock(content, normalizedSlug, replaceAgentMemory);
          safeWriteFile(projectAgentsMd, updated, dryRun, report);
        }

        // If neither exists, create CLAUDE.md with canonical project rule block
        if (!hasClaudeMd && !hasAgentsMd) {
          const newClaudeMd = upsertBrainRuleBlock('', normalizedSlug, replaceAgentMemory);
          safeWriteFile(projectClaudeMd, newClaudeMd, dryRun, report);
        }
      }

      report.configuredTargets.push('project');
    } else {
      if (options.targets && options.targets.includes('project')) {
        report.warnings.push('Target "project" was requested, but no options.projectDir was provided.');
      }
    }
  }

  return report;
}

// -----------------------------------------------------------------------------
// CLI Argument Parsing & Runner
// -----------------------------------------------------------------------------

function requireFlagValue(argv: string[], index: number, flag: string): string {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return next;
}

export function parseCliArgs(argv: string[]): InstallAgentOptions {
  const options: InstallAgentOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--project-dir') {
      options.projectDir = requireFlagValue(argv, i, arg);
      i++;
      continue;
    }

    if (arg === '--project-id') {
      options.projectId = requireFlagValue(argv, i, arg);
      i++;
      continue;
    }

    if (arg === '--global') {
      options.global = true;
      continue;
    }

    if (arg === '--api-key') {
      options.apiKey = requireFlagValue(argv, i, arg);
      i++;
      console.warn(
        '\n[SECURITY WARNING] Passing --api-key on the command line can expose secrets in shell history (~/.bash_history) and process tables (ps aux).' +
        '\nRecommended: Set BRAIN_API_KEY in your .env file instead and run `npm run install-agent`.\n'
      );
      continue;
    }

    if (arg === '--api-url') {
      options.apiUrl = requireFlagValue(argv, i, arg);
      i++;
      continue;
    }

    if (arg === '--no-hooks') {
      options.enableHooks = false;
      continue;
    }

    if (arg === '--keep-agentmemory') {
      options.replaceAgentMemory = false;
      continue;
    }

    if (arg === '--replace-agentmemory') {
      options.replaceAgentMemory = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--target' || arg === '--targets') {
      const rawTargets = requireFlagValue(argv, i, arg).split(',').map((t) => t.trim().toLowerCase());
      i++;
      const validTargets: Array<'antigravity' | 'claude' | 'cursor' | 'project'> = [];
      for (const t of rawTargets) {
        if (t === 'antigravity' || t === 'claude' || t === 'cursor' || t === 'project') {
          validTargets.push(t);
        } else if (t) {
          console.warn(`[WARN] Unknown target '${t}' ignored.`);
        }
      }
      options.targets = validTargets;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printUsage(): void {
  console.log(`
Usage: npm run install-agent -- [options]

Configures coding agents (Antigravity, Claude Code, Cursor, Workspace Projects)
to use neuralbrain persistent memory.

Modes of Operation:
  1. Global Install (default when --project-dir is omitted):
     Installs globally to base agent configurations:
       - Antigravity plugin: ~/.gemini/config/plugins/neuralbrain/
       - Global Rules:       ~/.gemini/GEMINI.md
       - Claude Code:        ~/.claude.json, ~/.claude/settings.json, ~/.claude/CLAUDE.md
       - Cursor:             ~/.cursor/mcp.json

  2. Project-Level Install (when --project-dir <path> is provided):
     Installs ONLY to the specific project workspace, touching ZERO global files:
       - Project ID:         <projectDir>/.brainrc
       - Project Claude MCP: <projectDir>/.mcp.json
       - Project Claude:     <projectDir>/.claude/settings.json
       - Project Gemini:     <projectDir>/.gemini/hooks.json, .gemini/skills/brain-memory/
       - Project Cursor:     <projectDir>/.cursor/mcp.json
       - Project Rules:      <projectDir>/CLAUDE.md / AGENTS.md

  3. Dual Install (--global with --project-dir <path>):
     Installs both global agent configurations and project-level workspace files.

Security Recommendation:
  Set BRAIN_API_KEY and BRAIN_API_URL in your .env file instead of passing keys
  via command-line arguments to avoid leaking credentials into shell history
  (~/.bash_history) or process listings (ps aux).
  Then simply run:
    npm run install-agent
  or:
    npm run install-agent -- --project-dir /path/to/project

Options:
  --project-dir <path>     Target project workspace to initialize .brainrc & rules
  --project-id <slug>      Explicit canonical project slug (defaults to folder name)
  --global                 Force global installation alongside --project-dir
  --api-key <key>          API key (Warning: Prefer setting BRAIN_API_KEY in .env)
  --api-url <url>          Brain API service URL (defaults to .env or http://127.0.0.1:3737)
  --target <list>          Explicit targets: antigravity, claude, cursor, project
  --no-hooks               Do not configure lifecycle hooks in plugin / settings
  --replace-agentmemory    Replace legacy agentmemory MCP configs and rule blocks
  --keep-agentmemory       Preserve legacy agentmemory MCP configs and rule blocks (default)
  --dry-run                Simulate actions without writing files to disk
  -h, --help               Show this help message
`);
}

/**
 * Prints a human-readable summary of an installAgentIntegration run.
 */
export function printInstallAgentReport(report: InstallAgentReport): void {
  console.log('\n===================================================================');
  console.log('             neuralbrain Multi-Agent Installer');
  console.log('===================================================================');
  console.log(`Dry Run:            ${report.dryRun ? 'YES (No files modified)' : 'NO'}`);
  console.log(`Configured Targets: ${report.configuredTargets.join(', ') || 'none'}`);
  if (report.projectId) {
    console.log(`Project ID:         ${report.projectId}`);
  }

  if (report.createdFiles.length > 0) {
    console.log('\nCreated Files:');
    for (const file of report.createdFiles) {
      console.log(`  + ${file}`);
    }
  }

  if (report.modifiedFiles.length > 0) {
    console.log('\nModified Files:');
    for (const file of report.modifiedFiles) {
      console.log(`  * ${file}`);
    }
  }

  if (report.skippedFiles.length > 0) {
    console.log(`\nUnchanged Files (${report.skippedFiles.length}):`);
    for (const file of report.skippedFiles) {
      console.log(`  = ${file}`);
    }
  }

  if (report.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of report.warnings) {
      console.log(`  ! ${w}`);
    }
  }

  console.log('\nNext Steps:');
  console.log('  1. Ensure the brain service is running: neuralbrain start (check with neuralbrain status)');
  if (report.configuredTargets.includes('antigravity')) {
    console.log('  2. For Antigravity: The neuralbrain plugin is ready under ~/.gemini/config/plugins/');
  }
  if (report.configuredTargets.includes('claude')) {
    console.log('  3. For Claude Code: MCP server and hooks configured in ~/.claude.json & ~/.claude/');
  }
  if (report.configuredTargets.includes('cursor')) {
    console.log('  4. For Cursor: MCP server registered in ~/.cursor/mcp.json');
  }
  if (report.configuredTargets.includes('project')) {
    console.log('  5. Project Workspace: Fully initialized with hooks, skills, and .brainrc');
  }
  console.log('===================================================================\n');
}

function main(): void {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const report = installAgentIntegration(options);
    printInstallAgentReport(report);
  } catch (error: any) {
    console.error('\n[ERROR] Multi-Agent Installation failed:');
    console.error(error?.message || error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
