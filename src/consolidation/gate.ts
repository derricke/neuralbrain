import { randomUUID } from 'crypto';
import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { recordDeadLetter, type DeadLetterReason } from '../memory/deadLetterStore';
import { enqueueForEmbedding } from '../memory/embedQueueStore';
import type { ObservationRecord } from '../memory/observationStore';
import { transaction } from '../lib/sqlite';

export const CONSOLIDATION_SYSTEM_PROMPT = `You extract facts from a coding agent's tool-call log. You do not summarize,
interpret, or explain significance.

Output ONLY this JSON, no prose, no markdown fence:

{
  "files_touched": ["exact/path/from/log"],
  "error_verbatim": "exact error string copied character-for-character, or null",
  "claims": [
    {"text": "a statement restating only what the log literally shows",
     "source_ids": ["<id of each observation supporting it>"]}
  ]
}

HARD RULES — a violation makes the output invalid:
- Every string in "error_verbatim" and every path in "files_touched" MUST appear
  verbatim in the log. Copy, never paraphrase.
- "files_touched" means a path that appeared as a tool call's TARGET file_path.
  A path merely mentioned in command output does NOT count.
- Every claim MUST cite the ids of the observations supporting it.
- If the log does not state a cause, DO NOT supply one.
- If the log does not state why something matters, DO NOT say why it matters.
- No importance scores. No confidence scores. No narrative. No outcome.`;

export interface ConsolidationSubmission {
  lease_id: string;
  outcome?: string | null;
  claims: Array<{ text: string; source_ids: string[] }>;
  files_touched?: string[];
  error_verbatim?: string | null;
  producer_tier?: string;
  producer_model?: string | null;
  prompt_version?: string;
  raw_response?: string;
  finish_reason?: string;
}

export interface GateVerificationFailure {
  ok: false;
  status: 422;
  reason: DeadLetterReason;
  message: string;
  details?: Record<string, any>;
}

export interface GateVerificationSuccess {
  ok: true;
  status: 201;
  summary_id: string;
  outcome: 'success' | 'failure' | 'unknown';
  claims_count: number;
}

export type GateVerificationResult = GateVerificationSuccess | GateVerificationFailure;

export function computeArithmeticOutcome(
  observations: Array<{ failed: number; tool_name?: string | null; kind?: string | null }>
): 'success' | 'failure' | 'unknown' {
  if (observations.some((o) => o.failed === 1)) {
    return 'failure';
  }

  // Check if all observations are purely read-only
  const isPureReadOnly =
    observations.length > 0 &&
    observations.every(
      (o) =>
        o.kind === 'tool_call' &&
        o.tool_name &&
        ['read', 'read_file', 'readfile'].includes(o.tool_name.toLowerCase())
    );

  if (isPureReadOnly || observations.length === 0) {
    return 'unknown';
  }

  return 'success';
}

export function verifyAndStoreSummary(
  submission: ConsolidationSubmission
): GateVerificationResult {
  const db = getDb();
  const producer = submission.producer_model || submission.producer_tier || 'agent';

  const reject = (
    reason: DeadLetterReason,
    message: string,
    details?: Record<string, any>
  ): GateVerificationFailure => {
    logger.warn({ reason, message, producer, details }, 'consolidation verification failed');
    try {
      recordDeadLetter({
        source: 'consolidate',
        reason,
        producer,
        payload: submission,
      });
    } catch (err) {
      logger.error({ error: err }, 'failed to record dead letter for consolidation');
    }

    return {
      ok: false,
      status: 422,
      reason,
      message,
      details,
    };
  };

  // 1. empty_content
  if (submission.raw_response !== undefined && submission.raw_response.trim() === '') {
    return reject('empty_content', 'Response content is empty');
  }

  // 2. truncated
  if (submission.finish_reason === 'length') {
    return reject('truncated', 'Response was truncated due to token length limit');
  }

  // 3. unparseable (if raw_response provided)
  let parsedPayload: any = submission;
  if (submission.raw_response !== undefined) {
    const raw = submission.raw_response.trim();
    if (raw.startsWith('```') || raw.includes('```')) {
      return reject('unparseable', 'Raw response contains markdown code fences');
    }
    if (!raw.startsWith('{') || !raw.endsWith('}')) {
      return reject('unparseable', 'Raw response contains prose outside JSON object');
    }
    try {
      parsedPayload = JSON.parse(raw);
    } catch (err) {
      return reject('unparseable', 'Raw response could not be parsed as JSON', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. schema_invalid
  const forbiddenKeys = ['narrative', 'importance', 'confidence', 'strength'];
  for (const key of forbiddenKeys) {
    if (key in parsedPayload || (submission as any)[key] !== undefined) {
      return reject('schema_invalid', `Forbidden field '${key}' found in submission`);
    }
  }

  const claims = parsedPayload.claims ?? submission.claims;
  if (!Array.isArray(claims)) {
    return reject('schema_invalid', 'Submission must contain a claims array');
  }
  if (claims.length === 0) {
    return reject('empty_content', 'Submission must contain a non-empty claims array');
  }

  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    if (
      !claim ||
      typeof claim !== 'object' ||
      typeof claim.text !== 'string' ||
      claim.text.trim() === '' ||
      !Array.isArray(claim.source_ids)
    ) {
      return reject('schema_invalid', `Claim at index ${i} is missing valid text or source_ids`);
    }
  }

  const filesTouched = parsedPayload.files_touched ?? submission.files_touched;
  if (filesTouched !== undefined && !Array.isArray(filesTouched)) {
    return reject('schema_invalid', 'files_touched must be an array of strings if provided');
  }

  const errorVerbatim = parsedPayload.error_verbatim ?? submission.error_verbatim;
  if (errorVerbatim !== undefined && errorVerbatim !== null && typeof errorVerbatim !== 'string') {
    return reject('schema_invalid', 'error_verbatim must be a string or null');
  }

  // 5. Verify lease
  const leaseId = submission.lease_id?.trim();
  if (!leaseId) {
    return reject('schema_invalid', 'lease_id is required');
  }

  const now = Math.floor(Date.now() / 1000);
  const lease = db
    .prepare('SELECT * FROM consolidation_leases WHERE lease_id = ?')
    .get(leaseId) as
    | {
        lease_id: string;
        kind: string;
        scope: string;
        project_id: string | null;
        session_id: string;
        observation_ids: string;
        expires_at: number;
        completed_at: number | null;
      }
    | undefined;

  if (!lease) {
    return reject('schema_invalid', `Lease '${leaseId}' not found`);
  }

  if (lease.completed_at !== null) {
    return reject('schema_invalid', `Lease '${leaseId}' has already been completed`);
  }

  if (lease.expires_at < now) {
    return reject('schema_invalid', `Lease '${leaseId}' has expired`);
  }

  let leaseObsIds: string[] = [];
  try {
    leaseObsIds = JSON.parse(lease.observation_ids);
  } catch {
    return reject('schema_invalid', `Lease '${leaseId}' has invalid observation_ids`);
  }
  const validObsIdSet = new Set(leaseObsIds);

  // Load source observations
  const placeholders = leaseObsIds.map(() => '?').join(',');
  const sourceObservations = (
    placeholders
      ? db.prepare(`SELECT * FROM observations WHERE id IN (${placeholders})`).all(...leaseObsIds)
      : []
  ) as ObservationRecord[];

  // 6. citation_unresolved
  for (const claim of claims) {
    if (!claim.source_ids || claim.source_ids.length === 0) {
      return reject('citation_unresolved', `Claim '${claim.text}' has no source_ids citations`);
    }
    for (const srcId of claim.source_ids) {
      if (!validObsIdSet.has(srcId)) {
        return reject(
          'citation_unresolved',
          `Citation id '${srcId}' in claim '${claim.text}' does not resolve to an observation in lease '${leaseId}'`
        );
      }
    }
  }

  // 7. not_verbatim on error_verbatim
  if (errorVerbatim && typeof errorVerbatim === 'string' && errorVerbatim.trim() !== '') {
    const errorStr = errorVerbatim.trim();
    const appearsInLog = sourceObservations.some((obs) => {
      const inInput = obs.input ? obs.input.includes(errorStr) : false;
      const inOutput = obs.output ? obs.output.includes(errorStr) : false;
      return inInput || inOutput;
    });

    if (!appearsInLog) {
      return reject(
        'not_verbatim',
        `error_verbatim string does not appear verbatim in any source observation input/output`
      );
    }
  }

  // 8. not_verbatim on files_touched
  if (Array.isArray(filesTouched) && filesTouched.length > 0) {
    // files_touched means a path that appeared as a tool call's TARGET file_path.
    // A path merely mentioned in command output does NOT count.
    const targetPaths = new Set<string>();
    for (const obs of sourceObservations) {
      if (obs.file_path && obs.file_path.trim() !== '') {
        targetPaths.add(obs.file_path.trim());
      }
    }

    for (const path of filesTouched) {
      const cleanPath = String(path).trim();
      if (!targetPaths.has(cleanPath)) {
        return reject(
          'not_verbatim',
          `Path '${cleanPath}' in files_touched did not appear as a tool call target file_path`
        );
      }
    }
  }

  // 9. Check quotes in claim texts
  for (const claim of claims) {
    const quotes = claim.text.match(/"([^"]+)"/g);
    if (quotes) {
      for (const q of quotes) {
        const quoteContent = q.slice(1, -1);
        if (quoteContent.length > 5) {
          const found = sourceObservations.some((obs) => {
            const inInput = obs.input ? obs.input.includes(quoteContent) : false;
            const inOutput = obs.output ? obs.output.includes(quoteContent) : false;
            const inFile = obs.file_path ? obs.file_path.includes(quoteContent) : false;
            return inInput || inOutput || inFile;
          });
          if (!found) {
            return reject(
              'not_verbatim',
              `Quoted string '${quoteContent}' in claim does not appear in source observations`
            );
          }
        }
      }
    }
  }

  // PASSED: Compute outcome arithmetically
  const outcome = computeArithmeticOutcome(sourceObservations);

  const windowFrom =
    sourceObservations.length > 0
      ? Math.min(...sourceObservations.map((o) => o.created_at))
      : now;
  const windowTo =
    sourceObservations.length > 0
      ? Math.max(...sourceObservations.map((o) => o.created_at))
      : now;

  const summaryId = `sum_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const producerTier = submission.producer_tier || 'agent';
  const producerModel = submission.producer_model || null;
  const promptVersion = submission.prompt_version || 'extract-v1';

  try {
    transaction(db, () => {
      db.prepare(`
        INSERT INTO summaries (
          id, scope, project_id, kind, window_from, window_to, outcome,
          producer_tier, producer_model, prompt_version, verified, version,
          supersedes, is_latest, sources_expired, embedding, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, NULL, 1, 0, NULL, unixepoch())
      `).run(
        summaryId,
        lease.scope,
        lease.project_id,
        lease.kind,
        windowFrom,
        windowTo,
        outcome,
        producerTier,
        producerModel,
        promptVersion
      );

      const claimStmt = db.prepare(`
        INSERT INTO summary_claims (id, summary_id, text, ordinal)
        VALUES (?, ?, ?, ?)
      `);

      const sourceStmt = db.prepare(`
        INSERT INTO summary_sources (summary_id, claim_id, record_id, grain)
        VALUES (?, ?, ?, 'observation')
      `);

      for (let i = 0; i < claims.length; i++) {
        const claim = claims[i];
        const claimId = `clm_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        claimStmt.run(claimId, summaryId, claim.text.trim(), i);

        for (const srcId of claim.source_ids) {
          sourceStmt.run(summaryId, claimId, srcId);
        }
      }

      // Mark lease completed
      const updateResult = db.prepare(`
        UPDATE consolidation_leases
        SET completed_at = unixepoch()
        WHERE lease_id = ? AND completed_at IS NULL
      `).run(leaseId);

      if (updateResult.changes !== 1) {
        throw new Error(`Failed to complete lease '${leaseId}': lease already completed or not found`);
      }

      // Enqueue summary for embedding inside write transaction (Rule 2)
      enqueueForEmbedding(summaryId, 'summary');
    })();

    logger.info(
      { summaryId, outcome, claimsCount: claims.length, leaseId },
      'summary successfully verified and stored'
    );

    return {
      ok: true,
      status: 201,
      summary_id: summaryId,
      outcome,
      claims_count: claims.length,
    };
  } catch (err) {
    logger.error(
      { leaseId, error: err instanceof Error ? err.message : String(err) },
      'database error storing summary'
    );
    throw err;
  }
}
