import { getDb, resetDb } from '../../lib/db';
import { runDoctor } from '../../scripts/doctor';
import { createNote } from '../../memory/noteStore';

describe('Doctor Scripts Tests', () => {
  beforeAll(() => {
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'none';
    resetDb();
    // A small store for the counts doctor reports: 3 project-scoped notes, 2 unknown.
    for (let i = 0; i < 5; i++) {
      createNote({
        id: `note-doctor-${i}`,
        scope: i < 3 ? 'project' : 'unknown',
        projectId: i < 3 ? 'demo-project' : undefined,
        type: 'fact',
        title: `Doctor fixture ${i}`,
        content: `Fixture note ${i} for doctor diagnostics.`,
      });
    }
  });

  afterAll(() => {
    resetDb();
  });

  describe('Doctor Diagnostics CLI', () => {
    it('executes doctor checks and returns consistent verdict with all checks passing', async () => {
      const report = await runDoctor({ ai: true });

      expect(report.dbOk).toBe(true);
      expect(report.schemaAligned).toBe(true);
      expect(report.storeMetaMatch).toBe(true);
      expect(report.noteCount).toBe(5);
      expect(report.unknownScopeCount).toBe(2);
      expect(report.aiDiagnostics).toBeDefined();
      expect(report.aiDiagnostics.all_passing).toBe(true);
      expect(report.aiDiagnostics.total_count).toBe(8);
      expect(report.aiDiagnostics.passed_count).toBe(8);

      const schemaCheck = report.checks.find((c) => c.name === 'Schema Alignment');
      expect(schemaCheck).toBeDefined();
      expect(schemaCheck?.pass).toBe(true);

      // Ensure allPassing boolean never contradicts itself
      const checkPasses = report.checks.every((c) => c.pass);
      expect(report.allPassing).toBe(checkPasses && report.aiDiagnostics.all_passing);
      expect(report.allPassing).toBe(true);
    });

    it('reports failure accurately when a check fails and never claims all passing', async () => {
      process.env.BRAIN_EMBED = 'local';
      const db = getDb();
      // Temporarily tamper store_meta with an invalid tier/dim to provoke failure
      db.prepare('UPDATE store_meta SET embed_dim = 99999 WHERE id = 1').run();

      const report = await runDoctor({ ai: true });
      expect(report.allPassing).toBe(false);

      const storeMetaCheck = report.checks.find((c) => c.name === 'Store Meta Consistency');
      expect(storeMetaCheck).toBeDefined();
      expect(storeMetaCheck?.pass).toBe(false);

      // Revert store_meta and BRAIN_EMBED
      db.prepare('UPDATE store_meta SET embed_dim = 0 WHERE id = 1').run();
      process.env.BRAIN_EMBED = 'none';
    });

    it('detects schema misalignment when columns or nullability fail checks (Q27)', async () => {
      const db = getDb();

      // Temporarily create a table with non-nullable success and missing columns to simulate misalignment
      db.exec(`
        CREATE TABLE trajectories_backup AS SELECT * FROM trajectories;
        DROP TABLE trajectories;
        CREATE TABLE trajectories (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          project_id TEXT,
          success INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);

      const report = await runDoctor({ ai: false });
      expect(report.schemaAligned).toBe(false);
      expect(report.allPassing).toBe(false);

      const schemaCheck = report.checks.find((c) => c.name === 'Schema Alignment');
      expect(schemaCheck).toBeDefined();
      expect(schemaCheck?.pass).toBe(false);
      expect(schemaCheck?.message).toContain('trajectories.success is not nullable');
      expect(schemaCheck?.message).toContain('trajectories.session_id missing');

      // Restore table
      db.exec(`
        DROP TABLE trajectories;
        CREATE TABLE trajectories AS SELECT * FROM trajectories_backup;
        DROP TABLE trajectories_backup;
      `);
    });

    it('detects disabled foreign keys pragma (Q27)', async () => {
      const db = getDb();
      db.exec('PRAGMA foreign_keys = OFF;');

      const report = await runDoctor({ ai: false });
      expect(report.schemaAligned).toBe(false);
      const schemaCheck = report.checks.find((c) => c.name === 'Schema Alignment');
      expect(schemaCheck?.pass).toBe(false);
      expect(schemaCheck?.message).toContain('PRAGMA foreign_keys is not active');

      db.exec('PRAGMA foreign_keys = ON;');
    });
  });
});
