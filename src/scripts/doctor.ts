import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { verifyOrCreateStoreMeta } from '../learning/storeMeta';
import {
  runAiConformanceDiagnostics,
  AiDiagnosticsReport,
} from '../consolidation/fixtures';
import { describeAiConfig } from '../ai/config';

export interface DoctorCheck {
  name: string;
  pass: boolean;
  message: string;
}

export interface DoctorReport {
  allPassing: boolean;
  dbOk: boolean;
  schemaAligned: boolean;
  storeMetaMatch: boolean;
  deadLetterCount: number;
  unknownScopeCount: number;
  noteCount: number;
  trajectoryCount: number;
  observationCount: number;
  aiDiagnostics: AiDiagnosticsReport;
  checks: DoctorCheck[];
}

export async function runDoctor(options: {
  ai?: boolean;
  exitOnFinish?: boolean;
} = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // 1. Database Health Check
  let dbOk = false;
  let journalMode = 'unknown';
  try {
    const db = getDb();
    const row = db.prepare('SELECT 1 as val').get() as { val: number } | undefined;
    const pragmaRow = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string } | undefined;
    journalMode = pragmaRow?.journal_mode || 'unknown';
    if (row?.val === 1) {
      dbOk = true;
      checks.push({
        name: 'Database Health',
        pass: true,
        message: `Database accessible and functional (journal_mode: ${journalMode})`,
      });
    } else {
      checks.push({
        name: 'Database Health',
        pass: false,
        message: 'Database query returned unexpected result',
      });
    }
  } catch (err) {
    checks.push({
      name: 'Database Health',
      pass: false,
      message: `Database connection error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 1b. Schema Alignment Check (Q27)
  let schemaAligned = false;
  if (dbOk) {
    try {
      const db = getDb();
      const issues: string[] = [];

      // Foreign keys pragma
      const fkRow = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined;
      if (fkRow?.foreign_keys !== 1) {
        issues.push('PRAGMA foreign_keys is not active');
      }

      const getTableColumns = (tableName: string): Map<string, { name: string; notnull: number; type: string }> => {
        const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; notnull: number; type: string }>;
        return new Map(rows.map((r) => [r.name, r]));
      };

      // trajectories check
      const trajCols = getTableColumns('trajectories');
      if (trajCols.size === 0) {
        issues.push('table trajectories does not exist');
      } else {
        const successCol = trajCols.get('success');
        if (!successCol) issues.push('trajectories.success missing');
        else if (successCol.notnull !== 0) issues.push('trajectories.success is not nullable (notnull=1)');

        const projCol = trajCols.get('project_id');
        if (!projCol) issues.push('trajectories.project_id missing');
        else if (projCol.notnull !== 0) issues.push('trajectories.project_id is not nullable (notnull=1)');

        for (const col of ['session_id', 'rollup_source', 'tool_calls']) {
          if (!trajCols.has(col)) issues.push(`trajectories.${col} missing`);
        }
      }

      // trajectory_archive check
      const trajArcCols = getTableColumns('trajectory_archive');
      if (trajArcCols.size === 0) {
        issues.push('table trajectory_archive does not exist');
      } else {
        const successCol = trajArcCols.get('success');
        if (!successCol) issues.push('trajectory_archive.success missing');
        else if (successCol.notnull !== 0) issues.push('trajectory_archive.success is not nullable (notnull=1)');

        const projCol = trajArcCols.get('project_id');
        if (!projCol) issues.push('trajectory_archive.project_id missing');
        else if (projCol.notnull !== 0) issues.push('trajectory_archive.project_id is not nullable (notnull=1)');

        for (const col of ['session_id', 'rollup_source', 'tool_calls']) {
          if (!trajArcCols.has(col)) issues.push(`trajectory_archive.${col} missing`);
        }
      }

      // observations and observations_archive project_id check
      const obsCols = getTableColumns('observations');
      if (obsCols.size === 0) {
        issues.push('table observations does not exist');
      } else {
        const projCol = obsCols.get('project_id');
        if (!projCol) issues.push('observations.project_id missing');
        else if (projCol.notnull !== 0) issues.push('observations.project_id is not nullable (notnull=1)');
      }

      const obsArcCols = getTableColumns('observations_archive');
      if (obsArcCols.size === 0) {
        issues.push('table observations_archive does not exist');
      } else {
        const projCol = obsArcCols.get('project_id');
        if (!projCol) issues.push('observations_archive.project_id missing');
        else if (projCol.notnull !== 0) issues.push('observations_archive.project_id is not nullable (notnull=1)');
      }

      // entities & entity_edges tables check
      const entitiesCols = getTableColumns('entities');
      if (entitiesCols.size === 0) {
        issues.push('table entities does not exist');
      }
      const entityEdgesCols = getTableColumns('entity_edges');
      if (entityEdgesCols.size === 0) {
        issues.push('table entity_edges does not exist');
      }

      // FTS5 virtual tables check
      const ftsRows = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('fts_notes', 'fts_entities', 'fts_actions')"
        )
        .all() as Array<{ name: string }>;
      const ftsSet = new Set(ftsRows.map((r) => r.name));
      for (const ftsName of ['fts_notes', 'fts_entities', 'fts_actions']) {
        if (!ftsSet.has(ftsName)) {
          issues.push(`FTS5 table ${ftsName} does not exist`);
        }
      }

      // actions reminder/recurrence/user columns check
      const actionCols = getTableColumns('actions');
      if (actionCols.size === 0) {
        issues.push('table actions does not exist');
      } else {
        for (const col of [
          'due_at',
          'remind_at',
          'recurrence',
          'last_reminded_at',
          'snooze_until',
          'user_id',
        ]) {
          if (!actionCols.has(col)) issues.push(`actions.${col} missing`);
        }
      }

      // notes temporal/user columns check
      const noteCols = getTableColumns('notes');
      if (noteCols.size === 0) {
        issues.push('table notes does not exist');
      } else {
        for (const col of ['event_at', 'valid_from', 'valid_until', 'user_id']) {
          if (!noteCols.has(col)) issues.push(`notes.${col} missing`);
        }
      }

      if (issues.length === 0) {
        schemaAligned = true;
        checks.push({
          name: 'Schema Alignment',
          pass: true,
          message: 'Relational schema aligned and foreign keys enabled',
        });
      } else {
        checks.push({
          name: 'Schema Alignment',
          pass: false,
          message: `Schema misalignment detected: ${issues.join('; ')}`,
        });
      }
    } catch (err) {
      checks.push({
        name: 'Schema Alignment',
        pass: false,
        message: `Failed to inspect schema: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    checks.push({
      name: 'Schema Alignment',
      pass: false,
      message: 'Database inaccessible, skipping schema alignment check',
    });
  }

  // 2. Store Meta Consistency Check
  let storeMetaMatch = false;
  try {
    const metaRes = verifyOrCreateStoreMeta();
    storeMetaMatch = metaRes.match;
    if (metaRes.match) {
      checks.push({
        name: 'Store Meta Consistency',
        pass: true,
        message: `Consistent with active config (tier: ${metaRes.recipe.embed_tier}, dim: ${metaRes.recipe.embed_dim})`,
      });
    } else {
      checks.push({
        name: 'Store Meta Consistency',
        pass: false,
        message: `Mismatch detected: ${metaRes.mismatchReason || 'configuration differs from store_meta'}`,
      });
    }
  } catch (err) {
    checks.push({
      name: 'Store Meta Consistency',
      pass: false,
      message: `Failed to verify store_meta: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 3. Operational Counts (Dead Letters, Notes, Trajectories, Observations)
  let deadLetterCount = 0;
  let unknownScopeCount = 0;
  let noteCount = 0;
  let trajectoryCount = 0;
  let observationCount = 0;

  if (dbOk) {
    try {
      const db = getDb();
      const dl = db.prepare('SELECT COUNT(*) as count FROM dead_letters').get() as { count: number };
      deadLetterCount = dl?.count ?? 0;

      const unk = db.prepare("SELECT COUNT(*) as count FROM notes WHERE scope = 'unknown'").get() as { count: number };
      unknownScopeCount = unk?.count ?? 0;

      const notes = db.prepare('SELECT COUNT(*) as count FROM notes').get() as { count: number };
      noteCount = notes?.count ?? 0;

      const traj = db.prepare('SELECT COUNT(*) as count FROM trajectories').get() as { count: number };
      trajectoryCount = traj?.count ?? 0;

      const obs = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
      observationCount = obs?.count ?? 0;
    } catch (err) {
      logger.warn({ error: err }, 'failed to query operational counts');
    }
  }

  // 3b. Generative producer configuration. Resolving a tier is what surfaces
  // an impossible combination (a `vendor` tier with no key, `local` named for
  // a generative function), so it belongs in the doctor report rather than
  // waiting for the first consolidation run.
  try {
    const aiConfig = describeAiConfig() as Record<string, any>;
    const broken = (['summarize', 'consolidate'] as const).filter((fn) => !aiConfig[fn]?.ok);
    if (broken.length === 0) {
      checks.push({
        name: 'Generative Producer Config',
        pass: true,
        message: `summarize: ${aiConfig.summarize.tier}${
          aiConfig.summarize.model ? ` (${aiConfig.summarize.model})` : ''
        }, consolidate: ${aiConfig.consolidate.tier}${
          aiConfig.consolidate.model ? ` (${aiConfig.consolidate.model})` : ''
        }`,
      });
    } else {
      checks.push({
        name: 'Generative Producer Config',
        pass: false,
        message: broken.map((fn) => `${fn}: ${aiConfig[fn].error}`).join(' | '),
      });
    }
  } catch (err) {
    checks.push({
      name: 'Generative Producer Config',
      pass: false,
      message: `Failed to resolve generative config: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 4. AI Conformance Diagnostics (runs conformance fixtures)
  let aiDiagnostics: AiDiagnosticsReport;
  const shouldRunAi = options?.ai !== false;
  if (shouldRunAi) {
    try {
      aiDiagnostics = runAiConformanceDiagnostics();
      checks.push({
        name: 'AI Conformance Diagnostics',
        pass: aiDiagnostics.all_passing,
        message: `${aiDiagnostics.passed_count}/${aiDiagnostics.total_count} assertions passed`,
      });
    } catch (err) {
      aiDiagnostics = {
        status: 'failed',
        all_passing: false,
        passed_count: 0,
        total_count: 0,
        results: [],
      };
      checks.push({
        name: 'AI Conformance Diagnostics',
        pass: false,
        message: `Failed to run diagnostics: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else {
    aiDiagnostics = {
      status: 'ok',
      all_passing: true,
      passed_count: 0,
      total_count: 0,
      results: [],
    };
    checks.push({
      name: 'AI Conformance Diagnostics',
      pass: true,
      message: 'Skipped (--no-ai)',
    });
  }

  // Compute single definitive boolean to prevent contradiction
  const totalChecks = checks.length;
  const passedChecks = checks.filter((c) => c.pass).length;
  const allPassing = passedChecks === totalChecks && dbOk && schemaAligned && storeMetaMatch && aiDiagnostics.all_passing;

  // Print Structured Report
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                      NEURALBRAIN DOCTOR                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  for (const check of checks) {
    const symbol = check.pass ? '✓ PASS' : '✗ FAIL';
    console.log(`  [${symbol}] ${check.name.padEnd(28)} : ${check.message}`);
  }

  console.log('\n  Operational Metrics:');
  console.log(`    - Dead Letters Recorded  : ${deadLetterCount}`);
  console.log(`    - Unknown-Scope Notes    : ${unknownScopeCount}`);
  console.log(`    - Total Notes            : ${noteCount}`);
  console.log(`    - Trajectories Stored    : ${trajectoryCount}`);
  console.log(`    - Observations Stored    : ${observationCount}`);

  if (aiDiagnostics.results && aiDiagnostics.results.length > 0) {
    console.log('\n  AI Diagnostics Breakdown:');
    for (const r of aiDiagnostics.results) {
      const sym = r.pass ? '✓' : '✗';
      console.log(`    ${sym} ${r.name}`);
    }
  }

  console.log('\n══════════════════════════════════════════════════════════════');
  if (allPassing) {
    console.log('  Final Verdict: PASS (All checks passing)');
  } else {
    console.log(`  Final Verdict: FAIL (${passedChecks}/${totalChecks} checks passing)`);
  }
  console.log('══════════════════════════════════════════════════════════════\n');

  if (options.exitOnFinish) {
    process.exit(allPassing ? 0 : 1);
  }

  return {
    allPassing,
    dbOk,
    schemaAligned,
    storeMetaMatch,
    deadLetterCount,
    unknownScopeCount,
    noteCount,
    trajectoryCount,
    observationCount,
    aiDiagnostics,
    checks,
  };
}

if (require.main === module) {
  const isNoAi = process.argv.includes('--no-ai');
  const isAi = (process.argv.includes('--ai') || process.argv.includes('--consolidator')) && !isNoAi;
  runDoctor({ ai: isNoAi ? false : isAi, exitOnFinish: true }).catch((err) => {
    console.error('Doctor execution crashed:', err);
    process.exit(1);
  });
}
