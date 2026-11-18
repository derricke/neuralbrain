import fs from 'fs';
import path from 'path';
import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { NoteType, NoteScope } from '../memory/noteStore';
import { transaction } from '../lib/sqlite';

export interface MigrationOptions {
  sourceUrl?: string;
  snapshotPath?: string;
  /** Skip the live API and read the bundled snapshot. Implied under test. */
  snapshotOnly?: boolean;
}

export interface MigrationResult {
  totalRead: number;
  imported: number;
  projectScoped: number;
  unknownScoped: number;
  conceptsCount: number;
  filesCount: number;
}

const VALID_TYPES = new Set<NoteType>([
  'fact',
  'architecture',
  'pattern',
  'workflow',
  'bug',
  'preference',
]);

export async function migrateAgentMemoryNotes(
  options: MigrationOptions = {}
): Promise<MigrationResult> {
  let rawData: any = null;
  const sourceUrl = options.sourceUrl || 'http://127.0.0.1:3113/memories?limit=1000';

  // The live agentmemory store is a moving target — because records can still be added by
  // hand even with its compression layer disabled. Anything asserting exact
  // counts (tests, reproducible imports) must pin the source to the snapshot
  // rather than read a number that changes under it.
  const snapshotOnly =
    options.snapshotOnly === true ||
    process.env.BRAIN_MIGRATE_SNAPSHOT_ONLY === '1' ||
    process.env.NODE_ENV === 'test' ||
    Boolean(process.env.JEST_WORKER_ID);

  // 1. Try fetching from live agentmemory REST API
  if (!options.snapshotPath && !snapshotOnly) {
    let timeoutId: NodeJS.Timeout | null = null;
    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 1500);
      timeoutId.unref();
      const resp = await fetch(sourceUrl, { signal: controller.signal });
      if (resp.ok) {
        rawData = await resp.json();
        logger.info({ sourceUrl }, 'fetched memories from live agentmemory REST API');
      }
    } catch {
      // Fall through to snapshot fallback
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  // 2. Fall back to local snapshot
  if (!rawData) {
    const candidatePaths = [
      options.snapshotPath,
      process.env.AGENTMEMORY_SNAPSHOT_PATH,
      path.join(process.cwd(), 'data', 'agentmemory-202-snapshot.json'),
      path.resolve(__dirname, '../../data/agentmemory-202-snapshot.json'),
    ].filter(Boolean) as string[];

    let loaded = false;
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf-8');
          rawData = JSON.parse(content);
          logger.info({ snapshotPath: p }, 'loaded memories from local snapshot');
          loaded = true;
          break;
        } catch (err) {
          logger.warn({ snapshotPath: p, error: err }, 'failed to parse snapshot file');
        }
      }
    }

    if (!loaded) {
      throw new Error(
        'Failed to fetch from agentmemory REST API and local snapshot file was not found'
      );
    }
  }

  const memories: any[] = Array.isArray(rawData) ? rawData : rawData.memories || [];
  const totalRead = memories.length;

  const db = getDb();

  let imported = 0;
  let projectScoped = 0;
  let unknownScoped = 0;
  let conceptsCount = 0;
  let filesCount = 0;

  const insertNote = db.prepare(`
    INSERT OR IGNORE INTO notes (
      id, scope, project_id, type, title, content, author, author_kind,
      version, supersedes, is_latest, embedding, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `);

  const insertConcept = db.prepare(`
    INSERT OR IGNORE INTO note_concepts (note_id, concept) VALUES (?, ?)
  `);

  const insertFile = db.prepare(`
    INSERT OR IGNORE INTO note_files (note_id, file_path) VALUES (?, ?)
  `);

  const enqueueStmt = db.prepare(`
    INSERT INTO embed_queue (record_id, grain, status, attempts, last_error, target, queued_at)
    VALUES (?, 'note', 'pending', 0, NULL, 'live', unixepoch())
    ON CONFLICT(record_id, grain, target) DO UPDATE SET
      status = 'pending',
      attempts = 0,
      last_error = NULL,
      queued_at = unixepoch()
  `);

  transaction(db, () => {
    for (const rec of memories) {
      const id: string = rec.id;
      const title: string = (rec.title || '').trim() || 'Untitled Note';
      const content: string = rec.content || '';
      const rawType = rec.type as NoteType;
      const type: NoteType = VALID_TYPES.has(rawType) ? rawType : 'fact';
      const version: number = typeof rec.version === 'number' ? rec.version : 1;
      const isLatest: number = rec.isLatest === false ? 0 : 1;

      const authorKind = 'agent';
      const author = rec.origin?.channel || 'agentmemory';

      // Scope rule:
      // The 86 records with non-null project import with scope = 'project' and project_id = record.project
      // The 116 records with null/missing project import with scope = 'unknown' and project_id = null
      let scope: NoteScope = 'unknown';
      let projectId: string | null = null;
      if (rec.project && typeof rec.project === 'string' && rec.project.trim().length > 0) {
        scope = 'project';
        projectId = rec.project.trim();
        projectScoped++;
      } else {
        scope = 'unknown';
        projectId = null;
        unknownScoped++;
      }

      // Convert createdAt and updatedAt to unix epoch seconds
      let createdAt = Math.floor(Date.now() / 1000);
      if (rec.createdAt) {
        const parsed = Math.floor(new Date(rec.createdAt).getTime() / 1000);
        if (!isNaN(parsed)) createdAt = parsed;
      }
      let updatedAt = createdAt;
      if (rec.updatedAt) {
        const parsed = Math.floor(new Date(rec.updatedAt).getTime() / 1000);
        if (!isNaN(parsed)) updatedAt = parsed;
      }

      const supersedes: string | null =
        Array.isArray(rec.supersedes) && rec.supersedes.length > 0
          ? String(rec.supersedes[0])
          : null;

      // Note: strength (e.g. 7.00 on all 202) is deliberately DROPPED per rule 6!

      const res = insertNote.run(
        id,
        scope,
        projectId,
        type,
        title,
        content,
        author,
        authorKind,
        version,
        supersedes,
        isLatest,
        createdAt,
        updatedAt
      );

      if (res.changes > 0) {
        imported++;
      }

      // Insert concepts
      if (Array.isArray(rec.concepts)) {
        for (const concept of rec.concepts) {
          if (typeof concept === 'string' && concept.trim().length > 0) {
            const cRes = insertConcept.run(id, concept.trim());
            if (cRes.changes > 0) {
              conceptsCount++;
            }
          }
        }
      }

      // Insert files
      if (Array.isArray(rec.files)) {
        for (const file of rec.files) {
          if (typeof file === 'string' && file.trim().length > 0) {
            const fRes = insertFile.run(id, file.trim());
            if (fRes.changes > 0) {
              filesCount++;
            }
          }
        }
      }

      // Enqueue imported note into embed_queue
      enqueueStmt.run(id);
    }
  })();

  logger.info(
    {
      totalRead,
      imported,
      projectScoped,
      unknownScoped,
      conceptsCount,
      filesCount,
    },
    'agentmemory migration complete'
  );

  return {
    totalRead,
    imported,
    projectScoped,
    unknownScoped,
    conceptsCount,
    filesCount,
  };
}

if (require.main === module) {
  migrateAgentMemoryNotes()
    .then((result) => {
      console.log('Migration succeeded:', JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
