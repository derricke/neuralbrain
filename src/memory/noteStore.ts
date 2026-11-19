import { randomUUID } from 'crypto';
import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { resolveScope } from '../lib/scope';
import { redactSecrets } from '../lib/redactSecrets';
import { enqueueForEmbedding } from './embedQueueStore';
import { transaction } from '../lib/sqlite';

export type NoteScope = 'project' | 'global' | 'unknown';
export type NoteType = 'fact' | 'architecture' | 'pattern' | 'workflow' | 'bug' | 'preference' | 'lesson';
export type AuthorKind = 'human' | 'agent';

export interface NoteRecord {
  id: string;
  scope: NoteScope;
  project_id: string | null;
  session_id: string | null;
  type: NoteType;
  title: string;
  content: string;
  author: string | null;
  author_kind: AuthorKind | null;
  version: number;
  supersedes: string | null;
  is_latest: number;
  created_at: number;
  updated_at: number;
}

const NOTE_COLUMNS =
  'id, scope, project_id, session_id, type, title, content, author, author_kind, version, supersedes, is_latest, created_at, updated_at';
const NOTE_COLUMNS_ALIASED = NOTE_COLUMNS.split(', ')
  .map((c) => `n.${c}`)
  .join(', ');

export interface NoteWithRelations extends NoteRecord {
  concepts: string[];
  files: string[];
}

export interface CreateNoteInput {
  id?: string;
  scope: NoteScope;
  projectId?: string | null;
  project_id?: string | null;
  sessionId?: string | null;
  session_id?: string | null;
  type: NoteType;
  title: string;
  content: string;
  author?: string | null;
  authorKind?: AuthorKind | null;
  concepts?: string[];
  files?: string[];
  supersedes?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

const VALID_TYPES = new Set<NoteType>([
  'fact',
  'architecture',
  'pattern',
  'workflow',
  'bug',
  'preference',
  'lesson',
]);

export function createNote(input: CreateNoteInput): NoteWithRelations {
  if (!input.scope) {
    const err = new Error("Scope is required and must be 'project', 'global', or 'unknown'");
    (err as any).code = 'SCOPE_REQUIRED';
    throw err;
  }

  const rawProject = input.projectId ?? input.project_id;
  const scoped = resolveScope(input.scope, rawProject);
  if (!scoped.ok) {
    const err = new Error(scoped.error);
    (err as any).code = 'SCHEMA_INVALID';
    throw err;
  }

  const scope: NoteScope = scoped.scope;
  const projectId: string | null = scoped.projectId;

  if (!VALID_TYPES.has(input.type)) {
    const err = new Error(`Invalid note type '${String(input.type)}'`);
    (err as any).code = 'SCHEMA_INVALID';
    throw err;
  }

  if (!input.title || input.title.trim() === '') {
    const err = new Error('title is required and cannot be empty');
    (err as any).code = 'SCHEMA_INVALID';
    throw err;
  }

  if (!input.content || input.content.trim() === '') {
    const err = new Error('content is required and cannot be empty');
    (err as any).code = 'SCHEMA_INVALID';
    throw err;
  }

  const authorKind = input.authorKind ?? null;
  if (authorKind !== null && authorKind !== 'human' && authorKind !== 'agent') {
    const err = new Error(`Invalid authorKind '${String(authorKind)}'. Must be 'human', 'agent', or null`);
    (err as any).code = 'SCHEMA_INVALID';
    throw err;
  }

  const db = getDb();
  const id = input.id?.trim() || `note_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const sessionId = (input.sessionId ?? input.session_id)?.trim() || null;
  const now = Math.floor(Date.now() / 1000);
  const createdAt = input.createdAt ?? now;
  const updatedAt = input.updatedAt ?? now;

  const result = transaction(db, () => {
    let version = 1;
    const supersedesId = input.supersedes?.trim() || null;

    if (supersedesId) {
      const parent = db.prepare('SELECT id, version FROM notes WHERE id = ?').get(supersedesId) as { id: string; version: number } | undefined;
      if (!parent) {
        const err = new Error(`Parent note '${supersedesId}' to supersede not found`);
        (err as any).code = 'PARENT_NOT_FOUND';
        throw err;
      }

      version = parent.version + 1;

      // Mark parent as superseded (is_latest = 0)
      db.prepare(`
        UPDATE notes
        SET is_latest = 0, updated_at = unixepoch()
        WHERE id = ?
      `).run(supersedesId);
    }

    const sanitizedTitle = redactSecrets(input.title.trim());
    const sanitizedContent = redactSecrets(input.content);

    db.prepare(`
      INSERT INTO notes (
        id, scope, project_id, session_id, type, title, content, author, author_kind,
        version, supersedes, is_latest, embedding, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
    `).run(
      id,
      scope,
      projectId,
      sessionId,
      input.type,
      sanitizedTitle,
      sanitizedContent,
      input.author?.trim() ?? null,
      authorKind,
      version,
      supersedesId,
      createdAt,
      updatedAt
    );

    const concepts = Array.isArray(input.concepts)
      ? Array.from(new Set(input.concepts.map((c) => String(c).trim()).filter(Boolean)))
      : [];

    if (concepts.length > 0) {
      const conceptStmt = db.prepare('INSERT OR IGNORE INTO note_concepts (note_id, concept) VALUES (?, ?)');
      for (const concept of concepts) {
        conceptStmt.run(id, concept);
      }
    }

    const files = Array.isArray(input.files)
      ? Array.from(new Set(input.files.map((f) => String(f).trim()).filter(Boolean)))
      : [];

    if (files.length > 0) {
      const fileStmt = db.prepare('INSERT OR IGNORE INTO note_files (note_id, file_path) VALUES (?, ?)');
      for (const file of files) {
        fileStmt.run(id, file);
      }
    }

    // Call enqueueForEmbedding atomically inside the transaction
    enqueueForEmbedding(id, 'note');

    return {
      id,
      scope,
      project_id: projectId,
      session_id: sessionId,
      type: input.type,
      title: sanitizedTitle,
      content: sanitizedContent,
      author: input.author?.trim() ?? null,
      author_kind: authorKind,
      version,
      supersedes: supersedesId,
      is_latest: 1,
      created_at: createdAt,
      updated_at: updatedAt,
      concepts,
      files,
    };
  })();

  return result;
}

export function getNote(id: string): NoteWithRelations | undefined {
  const db = getDb();
  const note = db.prepare(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`).get(id) as NoteRecord | undefined;
  if (!note) return undefined;

  const conceptRows = db
    .prepare('SELECT concept FROM note_concepts WHERE note_id = ? ORDER BY concept ASC')
    .all(id) as Array<{ concept: string }>;
  const fileRows = db
    .prepare('SELECT file_path FROM note_files WHERE note_id = ? ORDER BY file_path ASC')
    .all(id) as Array<{ file_path: string }>;

  return {
    ...note,
    concepts: conceptRows.map((r) => r.concept),
    files: fileRows.map((r) => r.file_path),
  };
}

function attachNoteRelations(notes: NoteRecord[], db: ReturnType<typeof getDb>): NoteWithRelations[] {
  if (notes.length === 0) return [];

  const noteIds = notes.map((n) => n.id);
  const conceptsByNote = new Map<string, string[]>();
  const filesByNote = new Map<string, string[]>();

  for (const id of noteIds) {
    conceptsByNote.set(id, []);
    filesByNote.set(id, []);
  }

  const CHUNK_SIZE = 500;
  for (let i = 0; i < noteIds.length; i += CHUNK_SIZE) {
    const chunk = noteIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');

    const conceptRows = db
      .prepare(
        `SELECT note_id, concept FROM note_concepts WHERE note_id IN (${placeholders}) ORDER BY concept ASC`
      )
      .all(...chunk) as Array<{ note_id: string; concept: string }>;

    for (const row of conceptRows) {
      conceptsByNote.get(row.note_id)?.push(row.concept);
    }

    const fileRows = db
      .prepare(
        `SELECT note_id, file_path FROM note_files WHERE note_id IN (${placeholders}) ORDER BY file_path ASC`
      )
      .all(...chunk) as Array<{ note_id: string; file_path: string }>;

    for (const row of fileRows) {
      filesByNote.get(row.note_id)?.push(row.file_path);
    }
  }

  return notes.map((note) => ({
    ...note,
    concepts: conceptsByNote.get(note.id) ?? [],
    files: filesByNote.get(note.id) ?? [],
  }));
}

export function getNotesByFile(filePath: string, projectId?: string, limit = 50): NoteWithRelations[] {
  const db = getDb();
  const cleanPath = filePath.trim();
  const boundedLimit = Math.min(Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50), 200);

  let query = `
    SELECT ${NOTE_COLUMNS_ALIASED}
    FROM notes n
    JOIN note_files nf ON n.id = nf.note_id
    WHERE nf.file_path = ? AND n.is_latest = 1
  `;
  const params: unknown[] = [cleanPath];

  if (projectId) {
    query += ` AND ((n.project_id = ? AND n.scope = 'project') OR n.scope = 'global')`;
    params.push(projectId.trim());
  }

  query += ` ORDER BY n.updated_at DESC LIMIT ?`;
  params.push(boundedLimit);

  const rows = db.prepare(query).all(...params) as NoteRecord[];
  return attachNoteRelations(rows, db);
}

export function listNotes(filters?: {
  scope?: string;
  projectId?: string;
  includeGlobal?: boolean;
  type?: string[];
  concept?: string;
  filePath?: string;
  onlyLatest?: boolean;
  limit?: number;
  offset?: number;
}): NoteWithRelations[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  const onlyLatest = filters?.onlyLatest !== false;
  if (onlyLatest) {
    conditions.push('n.is_latest = 1');
  }

  if (filters?.scope) {
    conditions.push('n.scope = ?');
    params.push(filters.scope);
  }

  if (filters?.projectId) {
    if (filters.includeGlobal) {
      conditions.push("((n.project_id = ? AND n.scope = 'project') OR n.scope = 'global')");
      params.push(filters.projectId.trim());
    } else {
      conditions.push("(n.project_id = ? AND n.scope = 'project')");
      params.push(filters.projectId.trim());
    }
  }

  if (Array.isArray(filters?.type) && filters.type.length > 0) {
    const typePlaceholders = filters.type.map(() => '?').join(',');
    conditions.push(`n.type IN (${typePlaceholders})`);
    params.push(...filters.type);
  }

  if (filters?.concept) {
    conditions.push(`EXISTS (SELECT 1 FROM note_concepts nc WHERE nc.note_id = n.id AND nc.concept = ?)`);
    params.push(filters.concept.trim());
  }

  if (filters?.filePath) {
    conditions.push(`EXISTS (SELECT 1 FROM note_files nf WHERE nf.note_id = n.id AND nf.file_path = ?)`);
    params.push(filters.filePath.trim());
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;
  params.push(limit, offset);

  const rows = db
    .prepare(`
      SELECT ${NOTE_COLUMNS_ALIASED}
      FROM notes n
      ${whereClause}
      ORDER BY n.updated_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params) as NoteRecord[];

  return attachNoteRelations(rows, db);
}

export function updateNoteScope(
  id: string,
  scope: NoteScope,
  projectId?: string | null
): NoteWithRelations {
  if (!scope) {
    const err = new Error("Scope is required and must be 'project', 'global', or 'unknown'");
    (err as any).code = 'SCOPE_REQUIRED';
    throw err;
  }

  const scoped = resolveScope(scope, projectId);
  if (!scoped.ok) {
    const err = new Error(scoped.error);
    (err as any).code = 'SCHEMA_INVALID';
    throw err;
  }

  const db = getDb();
  const note = getNote(id);
  if (!note) {
    const err = new Error(`Note '${id}' not found`);
    (err as any).code = 'NOT_FOUND';
    throw err;
  }

  transaction(db, () => {
    db.prepare(`
      UPDATE notes
      SET scope = ?, project_id = ?, updated_at = unixepoch()
      WHERE id = ?
    `).run(scoped.scope, scoped.projectId, id);

    enqueueForEmbedding(id, 'note');
  })();

  return getNote(id)!;
}
