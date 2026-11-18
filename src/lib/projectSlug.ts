import fs from 'fs';
import path from 'path';
import { normalizeProjectId } from './scope';
import { getBrainHomeDir } from './brainHome';

export interface ResolveProjectIdOptions {
  explicitProjectId?: string;
  cwd?: string;
  fallbackToDirname?: boolean;
}

/**
 * Resolves the canonical project ID slug for a workspace or directory.
 *
 * The id names the project's ROOT folder, never whichever subfolder the agent
 * happens to be in. Precedence:
 * 1. Explicit project ID (validated and normalized).
 * 2. .brainrc or .brain.json, found by walking up every parent of cwd (or process.cwd()).
 * 3. If fallbackToDirname: the git repository root's folder name. In a git
 *    worktree that is the MAIN repository, not the worktree folder.
 * 4. BRAIN_DEFAULT_PROJECT_ID environment variable.
 * 5. If fallbackToDirname and cwd is provided: basename of cwd (sanitized).
 * 6. null.
 */
export function resolveCanonicalProjectId(options?: ResolveProjectIdOptions): string | null {
  // 1. Explicit project ID
  if (options?.explicitProjectId && typeof options.explicitProjectId === 'string') {
    const trimmed = options.explicitProjectId.trim();
    if (trimmed !== '') {
      const norm = normalizeProjectId(trimmed);
      if (norm.ok) {
        return norm.projectId;
      }
    }
  }

  // 2. Walk up from options.cwd || process.cwd(), through every parent
  const startDir = path.resolve(options?.cwd || process.cwd());
  let currentDir = startDir;

  for (;;) {
    const candidates = ['.brainrc', '.brain.json'];
    for (const filename of candidates) {
      const candidatePath = path.join(currentDir, filename);
      if (fs.existsSync(candidatePath)) {
        try {
          const content = fs.readFileSync(candidatePath, 'utf-8');
          let slug: string | null = null;
          try {
            const parsed = JSON.parse(content);
            if (parsed && typeof parsed === 'object') {
              slug = parsed.project_id || parsed.projectId || parsed.project || null;
            } else if (typeof parsed === 'string') {
              slug = parsed;
            }
          } catch {
            // Not valid JSON, try plain string
            slug = content.trim();
          }

          if (slug && typeof slug === 'string') {
            const norm = normalizeProjectId(slug.trim());
            if (norm.ok) {
              return norm.projectId;
            }
          }
        } catch {
          // Ignore read error and continue walking
        }
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached filesystem root
      break;
    }
    currentDir = parentDir;
  }

  // 3. Git repository root (worktrees resolve to the main repository)
  if (options?.fallbackToDirname) {
    const gitRoot = findGitProjectRoot(startDir);
    if (gitRoot) {
      const slug = slugFromFolderName(path.basename(gitRoot));
      if (slug) return slug;
    }
  }

  // 4. BRAIN_DEFAULT_PROJECT_ID environment variable
  const envDefault = process.env.BRAIN_DEFAULT_PROJECT_ID;
  if (envDefault && typeof envDefault === 'string' && envDefault.trim() !== '') {
    const norm = normalizeProjectId(envDefault.trim());
    if (norm.ok) {
      return norm.projectId;
    }
  }

  // 5. Fallback to dirname if enabled and cwd is provided
  if (options?.fallbackToDirname && options?.cwd && typeof options.cwd === 'string' && options.cwd.trim() !== '') {
    const slug = slugFromFolderName(path.basename(path.resolve(options.cwd)));
    if (slug) return slug;
  }

  // 6. Otherwise return null
  return null;
}

function slugFromFolderName(name: string): string | null {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sanitized) return null;
  const norm = normalizeProjectId(sanitized);
  return norm.ok ? norm.projectId : null;
}

/**
 * Returns the folder that names the project for a git checkout containing
 * startDir, or null if startDir is not inside one.
 *
 * - `.git` directory: that folder is the repository root.
 * - `.git` file pointing into `<repo>/.git/worktrees/<name>`: a linked
 *   worktree, so the project is `<repo>`, wherever the worktree lives
 *   (agents put them in places like ~/.gemini/.../worktrees/<repo>/<branch>).
 * - any other `.git` file (e.g. a submodule): that folder is its own project.
 *
 * Only the filesystem is read; no git process is spawned.
 */
export function findGitProjectRoot(startDir: string): string | null {
  let currentDir = path.resolve(startDir);
  for (;;) {
    const dotGit = path.join(currentDir, '.git');
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) return currentDir;
    if (stat?.isFile()) {
      try {
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf-8'));
        if (match) {
          const gitDir = path.resolve(currentDir, match[1]);
          const worktree = /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(gitDir);
          if (worktree && worktree[1]) return worktree[1];
        }
      } catch {
        // unreadable .git file: treat this folder as the root
      }
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export interface ResolveSessionProjectIdOptions {
  sessionId?: string | null;
  cwd?: string;
  explicitProjectId?: string;
  /** Where session pins live. Defaults to <BRAIN_HOME>/sessions. */
  pinDir?: string;
}

const PIN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Resolves the project for an event inside an agent session, and keeps it
 * fixed for the rest of that session.
 *
 * Hooks fire with the agent's *current* directory, which moves whenever the
 * agent `cd`s into a subfolder or a subagent runs elsewhere. Resolving per
 * event split one session's observations across projects named after its
 * subfolders. So the first resolution in a session is pinned (in
 * <BRAIN_HOME>/sessions/<session id>.json) and every later event reuses it.
 * A pinned null means the session was unscoped, and stays unscoped.
 *
 * An explicit project id always wins and is not pinned.
 */
export function resolveSessionProjectId(options: ResolveSessionProjectIdOptions): string | null {
  if (options.explicitProjectId && options.explicitProjectId.trim() !== '') {
    return resolveCanonicalProjectId({ explicitProjectId: options.explicitProjectId });
  }

  const pinFile = options.sessionId ? sessionPinPath(options.sessionId, options.pinDir) : null;
  if (pinFile) {
    try {
      const pinned = JSON.parse(fs.readFileSync(pinFile, 'utf-8'));
      if (pinned && typeof pinned === 'object' && 'project_id' in pinned) {
        return typeof pinned.project_id === 'string' ? pinned.project_id : null;
      }
    } catch {
      // no pin yet (or unreadable): resolve below
    }
  }

  const projectId = resolveCanonicalProjectId({ cwd: options.cwd, fallbackToDirname: true });

  if (pinFile) {
    try {
      fs.mkdirSync(path.dirname(pinFile), { recursive: true });
      fs.writeFileSync(
        pinFile,
        JSON.stringify({ project_id: projectId, cwd: options.cwd ?? null, pinned_at: new Date().toISOString() })
      );
      prunePins(path.dirname(pinFile));
    } catch {
      // pinning is best effort; the resolution itself is still correct
    }
  }
  return projectId;
}

function sessionPinPath(sessionId: string, pinDir?: string): string | null {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  if (!safe) return null;
  if (pinDir) return path.join(pinDir, `${safe}.json`);
  // Under test, never write into the developer's real BRAIN_HOME.
  const underTest = process.env.NODE_ENV === 'test' || !!process.env.JEST_WORKER_ID;
  if (underTest && !process.env.BRAIN_HOME) return null;
  return path.join(getBrainHomeDir(), 'sessions', `${safe}.json`);
}

function prunePins(dir: string): void {
  const cutoff = Date.now() - PIN_MAX_AGE_MS;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
}

/**
 * Writes a canonical .brainrc file in projectDir with { "project_id": "<slug>" }.
 */
export function writeBrainRc(
  projectDir: string,
  projectId?: string
): { filePath: string; projectId: string } {
  const resolvedDir = path.resolve(projectDir);
  let slug: string | null = null;

  if (projectId && typeof projectId === 'string' && projectId.trim() !== '') {
    const initialNorm = normalizeProjectId(projectId.trim());
    if (initialNorm.ok) {
      slug = initialNorm.projectId;
    } else {
      const sanitized = projectId
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const sanitizedNorm = normalizeProjectId(sanitized);
      if (sanitizedNorm.ok) {
        slug = sanitizedNorm.projectId;
      }
    }
  }

  if (!slug) {
    const basename = path.basename(resolvedDir);
    const sanitized = basename
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const norm = normalizeProjectId(sanitized);
    if (!norm.ok) {
      throw new Error(`Failed to derive valid project_id for '${projectDir}': ${norm.error}`);
    }
    slug = norm.projectId;
  }

  const filePath = path.join(resolvedDir, '.brainrc');
  const content = JSON.stringify({ project_id: slug }, null, 2) + '\n';
  fs.writeFileSync(filePath, content, 'utf-8');

  return { filePath, projectId: slug };
}
