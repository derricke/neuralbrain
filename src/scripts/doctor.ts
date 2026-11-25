import fs from 'fs';
import path from 'path';
import { getDbPath, withIsolatedDb } from '../lib/db';
import { loadBrainEnv } from '../lib/brainHome';
import { openDatabase, type Database } from '../lib/sqlite';
import { createLocalTlsFetch } from '../lib/tls';
import {
  formatVersionSummary,
  getInstallInfo,
  type InstallInfo,
} from '../lib/version';
import {
  countStoreRecords,
  inspectDatabaseHealth,
  inspectSchemaAlignment,
  type StoreCounts,
} from '../lib/storeDiagnostics';
import { compareStoreMeta } from '../learning/storeMeta';
import { resolveEmbedderRecipe } from '../learning/embedding';
import type { StoreMetaRecord } from '../learning/types';
import {
  runAiConformanceDiagnostics,
  AiDiagnosticsReport,
} from '../consolidation/fixtures';
import { describeAiConfig } from '../ai/config';
import { resolveApiKey, resolveApiUrl } from './installAgent';

export interface DoctorCheck {
  name: string;
  pass: boolean;
  message: string;
}

/**
 * Where the doctor's answers came from.
 * - `service`: the running brain service, over HTTP. The doctor never opens the
 *   database file, so the service stays its only writer.
 * - `local`: the service was not reachable, so the database file was opened
 *   read-only (the sanctioned read-only diagnosis) and the AI conformance
 *   fixtures ran against a throwaway temp database.
 */
export type DoctorSource = 'service' | 'local';

export interface DoctorReport {
  allPassing: boolean;
  version: string;
  install: InstallInfo;
  serviceVersion: string | null;
  source: DoctorSource;
  target: string;
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

export interface DoctorOptions {
  ai?: boolean;
  exitOnFinish?: boolean;
  /** `auto` (default) uses the service when it answers /health, else `local`. */
  mode?: 'auto' | 'service' | 'local';
  apiUrl?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
  /** Local mode: database file to open read-only (default: the configured path). */
  dbPath?: string;
  /** Local mode, tests only: inspect this already-open connection instead of opening dbPath. */
  db?: Database;
  /** Suppress the printed report (tests). */
  quiet?: boolean;
}

const HEALTH_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 60000;

const SKIPPED_AI: AiDiagnosticsReport = {
  status: 'ok',
  all_passing: true,
  passed_count: 0,
  total_count: 0,
  results: [],
};

const FAILED_AI: AiDiagnosticsReport = {
  status: 'failed',
  all_passing: false,
  passed_count: 0,
  total_count: 0,
  results: [],
};

const ZERO_COUNTS: StoreCounts = {
  dead_letters: 0,
  unknown_scope_notes: 0,
  notes: 0,
  trajectories: 0,
  observations: 0,
};

interface Findings {
  dbOk: boolean;
  schemaAligned: boolean;
  storeMetaMatch: boolean;
  counts: StoreCounts;
  aiDiagnostics: AiDiagnosticsReport;
  checks: DoctorCheck[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function packageRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

function describeGenerativeConfig(aiConfig: Record<string, any>): DoctorCheck {
  const broken = (['summarize', 'consolidate'] as const).filter((fn) => !aiConfig[fn]?.ok);
  if (broken.length > 0) {
    return {
      name: 'Generative Producer Config',
      pass: false,
      message: broken.map((fn) => `${fn}: ${aiConfig[fn]?.error ?? 'not resolved'}`).join(' | '),
    };
  }
  const fmt = (fn: 'summarize' | 'consolidate') =>
    `${aiConfig[fn].tier}${aiConfig[fn].model ? ` (${aiConfig[fn].model})` : ''}`;
  return {
    name: 'Generative Producer Config',
    pass: true,
    message: `summarize: ${fmt('summarize')}, consolidate: ${fmt('consolidate')}`,
  };
}

function aiCheck(report: AiDiagnosticsReport): DoctorCheck {
  return {
    name: 'AI Conformance Diagnostics',
    pass: report.all_passing,
    message: `${report.passed_count}/${report.total_count} assertions passed`,
  };
}

async function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Returns the parsed /health body, or null when nothing answered. */
async function probeHealth(fetchFn: typeof fetch, apiUrl: string): Promise<Record<string, any> | null> {
  try {
    const res = await fetchWithTimeout(fetchFn, `${apiUrl}/health`, {}, HEALTH_TIMEOUT_MS);
    const body = (await res.json().catch(() => null)) as Record<string, any> | null;
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

async function runServiceChecks(
  fetchFn: typeof fetch,
  apiUrl: string,
  apiKey: string | undefined,
  health: Record<string, any>,
  runAi: boolean
): Promise<Findings> {
  const checks: DoctorCheck[] = [];
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  const getJson = async (
    route: string
  ): Promise<{ ok: true; body: any } | { ok: false; error: string; status?: number }> => {
    try {
      const res = await fetchWithTimeout(fetchFn, `${apiUrl}${route}`, { headers }, REQUEST_TIMEOUT_MS);
      if (res.status === 401) {
        return {
          ok: false,
          error: `GET ${route} was rejected (401): set BRAIN_API_KEY to a valid key for this service`,
        };
      }
      const body = (await res.json().catch(() => null)) as any;
      if (!res.ok || body === null) {
        return {
          ok: false,
          status: res.status,
          error: `GET ${route} returned ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''}`,
        };
      }
      return { ok: true, body };
    } catch (err) {
      return { ok: false, error: `GET ${route} failed: ${errorMessage(err)}` };
    }
  };

  // 1. Database health and schema, inspected by the service on its own connection.
  let dbOk = false;
  let schemaAligned = false;
  let counts = ZERO_COUNTS;
  const store = await getJson('/diagnostics/store');
  if (!store.ok && store.status === 404) {
    // A service older than this CLI: /health still answers for the database,
    // but schema and counts need a restart on this version.
    dbOk = health.db === 'ok';
    checks.push({
      name: 'Database Health',
      pass: dbOk,
      message: dbOk ? 'Database reported ok by /health' : `Database unhealthy: health reports db=${health.db}`,
    });
    checks.push({
      name: 'Schema Alignment',
      pass: false,
      message: `The service at ${apiUrl} predates GET /diagnostics/store; restart it on this version to check the schema`,
    });
  } else if (!store.ok) {
    checks.push({ name: 'Database Health', pass: false, message: store.error });
    checks.push({ name: 'Schema Alignment', pass: false, message: 'Skipped: store diagnostics unavailable' });
  } else {
    dbOk = store.body.db?.ok === true && health.db === 'ok';
    checks.push(
      dbOk
        ? {
            name: 'Database Health',
            pass: true,
            message: `Database accessible and functional (journal_mode: ${store.body.db.journal_mode})`,
          }
        : {
            name: 'Database Health',
            pass: false,
            message: `Database unhealthy: ${store.body.db?.error || `health reports db=${health.db}`}`,
          }
    );
    const issues: string[] = store.body.schema?.issues ?? [];
    schemaAligned = store.body.schema?.aligned === true;
    checks.push(
      schemaAligned
        ? { name: 'Schema Alignment', pass: true, message: 'Relational schema aligned and foreign keys enabled' }
        : { name: 'Schema Alignment', pass: false, message: `Schema misalignment detected: ${issues.join('; ')}` }
    );
    counts = store.body.counts ?? ZERO_COUNTS;
  }

  // 2. Store meta, as the service resolved it from its own environment. In
  // Docker mode that environment is the container's, which can differ from the
  // host shell the doctor runs in.
  const meta = health.store_meta;
  const storeMetaMatch = meta?.match === true;
  checks.push(
    storeMetaMatch
      ? {
          name: 'Store Meta Consistency',
          pass: true,
          message: `Consistent with active config (tier: ${meta.embed_tier}, dim: ${meta.embed_dim})`,
        }
      : {
          name: 'Store Meta Consistency',
          pass: false,
          message: `Mismatch detected: ${meta?.mismatch_reason || 'service reports store_meta mismatch'}`,
        }
  );

  // 3. Generative producer configuration, as the service resolved it.
  const aiConfig = await getJson('/diagnostics/ai-config');
  checks.push(
    aiConfig.ok
      ? describeGenerativeConfig(aiConfig.body)
      : { name: 'Generative Producer Config', pass: false, message: aiConfig.error }
  );

  // 4. AI conformance fixtures, run by the service (the only writer) against its store.
  let aiDiagnostics = SKIPPED_AI;
  if (runAi) {
    const ai = await getJson('/diagnostics/ai');
    if (ai.ok) {
      aiDiagnostics = ai.body as AiDiagnosticsReport;
      checks.push(aiCheck(aiDiagnostics));
    } else {
      aiDiagnostics = FAILED_AI;
      checks.push({ name: 'AI Conformance Diagnostics', pass: false, message: ai.error });
    }
  } else {
    checks.push({ name: 'AI Conformance Diagnostics', pass: true, message: 'Skipped (--no-ai)' });
  }

  return { dbOk, schemaAligned, storeMetaMatch, counts, aiDiagnostics, checks };
}

function runLocalChecks(db: Database | null, dbLabel: string, openError: string | null, runAi: boolean): Findings {
  const checks: DoctorCheck[] = [];
  let dbOk = false;
  let schemaAligned = false;
  let storeMetaMatch = false;
  let counts = ZERO_COUNTS;

  if (!db) {
    checks.push({ name: 'Database Health', pass: false, message: openError || `Could not open ${dbLabel}` });
    checks.push({ name: 'Schema Alignment', pass: false, message: 'Database inaccessible, skipping schema alignment check' });
    checks.push({ name: 'Store Meta Consistency', pass: false, message: 'Database inaccessible, skipping store_meta check' });
  } else {
    const health = inspectDatabaseHealth(db);
    dbOk = health.ok;
    checks.push(
      dbOk
        ? {
            name: 'Database Health',
            pass: true,
            message: `Database accessible read-only (journal_mode: ${health.journal_mode})`,
          }
        : {
            name: 'Database Health',
            pass: false,
            message: `Database connection error: ${health.error}`,
          }
    );

    if (dbOk) {
      try {
        // foreign_keys is per-connection; this read-only handle says nothing about the service's.
        const schema = inspectSchemaAlignment(db, { checkForeignKeys: false });
        schemaAligned = schema.aligned;
        checks.push(
          schemaAligned
            ? { name: 'Schema Alignment', pass: true, message: 'Relational schema aligned' }
            : {
                name: 'Schema Alignment',
                pass: false,
                message: `Schema misalignment detected: ${schema.issues.join('; ')} (the service migrates the schema on start)`,
              }
        );
      } catch (err) {
        checks.push({ name: 'Schema Alignment', pass: false, message: `Failed to inspect schema: ${errorMessage(err)}` });
      }

      try {
        const existing = db.prepare('SELECT * FROM store_meta WHERE id = 1').get() as StoreMetaRecord | undefined;
        const recipe = resolveEmbedderRecipe();
        if (!existing) {
          // A fresh store: the service commits store_meta on its first start.
          storeMetaMatch = true;
          checks.push({
            name: 'Store Meta Consistency',
            pass: true,
            message: `Not yet initialized; the service will commit tier ${recipe.embed_tier}, dim ${recipe.embed_dim} on first start`,
          });
        } else {
          const cmp = compareStoreMeta(existing, recipe);
          storeMetaMatch = cmp.match;
          checks.push(
            cmp.match
              ? {
                  name: 'Store Meta Consistency',
                  pass: true,
                  message: `Consistent with active config (tier: ${recipe.embed_tier}, dim: ${recipe.embed_dim})`,
                }
              : { name: 'Store Meta Consistency', pass: false, message: `Mismatch detected: ${cmp.mismatchReason}` }
          );
        }
      } catch (err) {
        checks.push({ name: 'Store Meta Consistency', pass: false, message: `Failed to verify store_meta: ${errorMessage(err)}` });
      }

      counts = countStoreRecords(db);
    } else {
      checks.push({ name: 'Schema Alignment', pass: false, message: 'Database inaccessible, skipping schema alignment check' });
      checks.push({ name: 'Store Meta Consistency', pass: false, message: 'Database inaccessible, skipping store_meta check' });
    }
  }

  // Generative config resolves from this process's environment (loadBrainEnv).
  try {
    checks.push(describeGenerativeConfig(describeAiConfig() as Record<string, any>));
  } catch (err) {
    checks.push({
      name: 'Generative Producer Config',
      pass: false,
      message: `Failed to resolve generative config: ${errorMessage(err)}`,
    });
  }

  // The fixtures seed and delete rows, so they never touch the real file:
  // they run against a throwaway temp database.
  let aiDiagnostics = SKIPPED_AI;
  if (runAi) {
    try {
      aiDiagnostics = withIsolatedDb(() => runAiConformanceDiagnostics());
      checks.push(aiCheck(aiDiagnostics));
    } catch (err) {
      aiDiagnostics = FAILED_AI;
      checks.push({ name: 'AI Conformance Diagnostics', pass: false, message: `Failed to run diagnostics: ${errorMessage(err)}` });
    }
  } else {
    checks.push({ name: 'AI Conformance Diagnostics', pass: true, message: 'Skipped (--no-ai)' });
  }

  return { dbOk, schemaAligned, storeMetaMatch, counts, aiDiagnostics, checks };
}

function openReadOnly(dbPath: string): { db: Database | null; error: string | null } {
  if (dbPath === ':memory:' || dbPath.startsWith('file::memory:')) {
    return { db: null, error: 'DATABASE_URL is :memory:; there is no database file to inspect' };
  }
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) {
    return {
      db: null,
      error: `No database at ${resolved}. Start the service once (neuralbrain start) to create it.`,
    };
  }
  try {
    return { db: openDatabase(resolved, { readOnly: true }), error: null };
  } catch (err) {
    return { db: null, error: `Could not open ${resolved} read-only: ${errorMessage(err)}` };
  }
}

function isTestRun(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.JEST_WORKER_ID);
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const mode = options.mode ?? 'auto';
  // Mirrors db.ts refusing real database paths under test: a test must name the
  // service it talks to, or it would probe (and authenticate against) a real
  // brain on the default port.
  if (isTestRun() && mode !== 'local' && !options.apiUrl && !options.fetchFn) {
    throw new Error(
      "runDoctor() under test must pass mode: 'local' or an explicit apiUrl/fetchFn; refusing to probe a real service."
    );
  }
  const runAi = options.ai !== false;
  const fetchFn = options.fetchFn ?? createLocalTlsFetch();
  const apiUrl = (options.apiUrl ?? resolveApiUrl({}, packageRoot(), process.cwd())).replace(/\/+$/, '');

  let source: DoctorSource = 'local';
  let target = '';
  let findings: Findings;

  const health = mode === 'local' ? null : await probeHealth(fetchFn, apiUrl);

  if (health) {
    source = 'service';
    target = apiUrl;
    const apiKey = options.apiKey ?? resolveApiKey({}, packageRoot(), process.cwd());
    findings = await runServiceChecks(fetchFn, apiUrl, apiKey, health, runAi);
  } else if (mode === 'service') {
    source = 'service';
    target = apiUrl;
    findings = {
      dbOk: false,
      schemaAligned: false,
      storeMetaMatch: false,
      counts: ZERO_COUNTS,
      aiDiagnostics: runAi ? FAILED_AI : SKIPPED_AI,
      checks: [{ name: 'Service Reachable', pass: false, message: `No response from ${apiUrl}/health` }],
    };
  } else if (options.db) {
    target = 'provided connection';
    findings = runLocalChecks(options.db, target, null, runAi);
  } else {
    const dbPath = options.dbPath ?? getDbPath();
    target = path.resolve(dbPath);
    const { db, error } = openReadOnly(dbPath);
    try {
      findings = runLocalChecks(db, target, error, runAi);
    } finally {
      db?.close();
    }
  }

  const { checks, aiDiagnostics, counts } = findings;
  const totalChecks = checks.length;
  const passedChecks = checks.filter((c) => c.pass).length;
  // One verdict, computed once, so the report can never say "N/M passing" and
  // "all checks passing" at the same time.
  const allPassing =
    passedChecks === totalChecks &&
    findings.dbOk &&
    findings.schemaAligned &&
    findings.storeMetaMatch &&
    aiDiagnostics.all_passing;

  const install = getInstallInfo(packageRoot());
  const serviceVersion =
    health && typeof health.version === 'string' && health.version.trim()
      ? health.version.trim()
      : null;

  if (!options.quiet) {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║                      NEURALBRAIN DOCTOR                      ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
    console.log(`  Version: ${formatVersionSummary(install)}`);
    console.log(
      source === 'service'
        ? `  Source:  running service at ${target}${serviceVersion ? ` (v${serviceVersion})` : ''}\n`
        : `  Source:  service not reachable at ${apiUrl}; inspected ${target} read-only\n`
    );

    for (const check of checks) {
      const symbol = check.pass ? '✓ PASS' : '✗ FAIL';
      console.log(`  [${symbol}] ${check.name.padEnd(28)} : ${check.message}`);
    }

    console.log('\n  Operational Metrics:');
    console.log(`    - Dead Letters Recorded  : ${counts.dead_letters}`);
    console.log(`    - Unknown-Scope Notes    : ${counts.unknown_scope_notes}`);
    console.log(`    - Total Notes            : ${counts.notes}`);
    console.log(`    - Trajectories Stored    : ${counts.trajectories}`);
    console.log(`    - Observations Stored    : ${counts.observations}`);

    if (aiDiagnostics.results && aiDiagnostics.results.length > 0) {
      console.log('\n  AI Diagnostics Breakdown:');
      for (const r of aiDiagnostics.results) {
        console.log(`    ${r.pass ? '✓' : '✗'} ${r.name}`);
      }
    }

    console.log('\n══════════════════════════════════════════════════════════════');
    console.log(
      allPassing
        ? '  Final Verdict: PASS (All checks passing)'
        : `  Final Verdict: FAIL (${passedChecks}/${totalChecks} checks passing)`
    );
    console.log('══════════════════════════════════════════════════════════════\n');
  }

  if (options.exitOnFinish) {
    process.exit(allPassing ? 0 : 1);
  }

  return {
    allPassing,
    version: install.version,
    install,
    serviceVersion,
    source,
    target,
    dbOk: findings.dbOk,
    schemaAligned: findings.schemaAligned,
    storeMetaMatch: findings.storeMetaMatch,
    deadLetterCount: counts.dead_letters,
    unknownScopeCount: counts.unknown_scope_notes,
    noteCount: counts.notes,
    trajectoryCount: counts.trajectories,
    observationCount: counts.observations,
    aiDiagnostics,
    checks,
  };
}

if (require.main === module) {
  // `npm run doctor` runs this file directly; `neuralbrain doctor` has already
  // loaded the env, and loadBrainEnv never clobbers what is set.
  loadBrainEnv();
  const isNoAi = process.argv.includes('--no-ai');
  const isAi = (process.argv.includes('--ai') || process.argv.includes('--consolidator')) && !isNoAi;
  const mode = process.argv.includes('--local') ? 'local' : process.argv.includes('--service') ? 'service' : 'auto';
  runDoctor({ ai: isNoAi ? false : isAi, exitOnFinish: true, mode }).catch((err) => {
    console.error('Doctor execution crashed:', err);
    process.exit(1);
  });
}
