/**
 * The non-agent consolidation driver: it leases candidates, asks the
 * configured generative producer to extract, and hands the raw reply to the
 * verification gate.
 *
 * Three properties this file exists to preserve:
 *
 * 1. **It is read-side only.** Observations are already committed before any
 *    model sees them, so nothing here can sit between a client's POST and a
 *    committed row (rule 1).
 * 2. **It never pre-chews the model's reply.** The raw text and the normalised
 *    `finish_reason` go straight to `verifyAndStoreSummary`, so a vendor
 *    producer is verified exactly like a local one — citations must resolve,
 *    strings must be verbatim. There is no bypass.
 * 3. **A dependency being down is not a dead letter** (rule 3). A timeout or
 *    an open breaker releases the lease and stops; only a 200 with malformed
 *    content is dead-lettered, attributed to the producer that wrote it.
 */

import { getDb } from '../lib/db';
import { logger } from '../lib/logger';
import { resolveChatConfig, type GenerativeFunction } from '../ai/config';
import { runChat } from '../ai/chat';
import { getConsolidationCandidates, type ConsolidationCandidate } from './candidates';
import { CONSOLIDATION_SYSTEM_PROMPT, verifyAndStoreSummary } from './gate';
import type { ObservationRecord } from '../memory/observationStore';
import type { GenerativeTier } from '../learning/types';

export const CONSOLIDATION_PROMPT_VERSION = 'extract-v1';

function clip(value: string | null, limit: number): string {
  if (!value) return '';
  if (value.length <= limit) return value;
  // Truncating the *prompt* is safe in a way ingest-path truncation is not:
  // there the truncated text becomes the record, while here the full rows stay
  // in SQLite and the gate verifies every quoted string against them. A model
  // that quotes across this boundary gets rejected, not stored.
  return `${value.slice(0, limit)}\n…[truncated, ${value.length - limit} chars omitted]`;
}

/** Renders a lease's observations as a log the model can only copy from. */
export function renderObservationLog(
  observations: ObservationRecord[],
  fieldChars: number
): string {
  const lines: string[] = [`OBSERVATION COUNT: ${observations.length}`, ''];

  for (const obs of observations) {
    lines.push(
      `[id=${obs.id}] kind=${obs.kind} tool=${obs.tool_name ?? '-'} file_path=${obs.file_path ?? '-'} failed=${obs.failed}`
    );
    lines.push(`input:\n${clip(obs.input, fieldChars)}`);
    lines.push(`output:\n${clip(obs.output, fieldChars)}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Hands a lease back so the session can be re-leased later. Used when the
 * producer is unreachable: the work was not done, and nothing about the
 * observations was wrong.
 */
export function releaseLease(leaseId: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE consolidation_leases
        SET expires_at = unixepoch() - 1
      WHERE lease_id = ? AND completed_at IS NULL`
  ).run(leaseId);
}

export interface ConsolidationRunReport {
  status: 'ok' | 'disabled' | 'agent' | 'unavailable' | 'misconfigured';
  tier: GenerativeTier | null;
  producer_model: string | null;
  message?: string;
  considered: number;
  stored: Array<{
    lease_id: string;
    summary_id: string;
    outcome: string;
    claims_count: number;
    producer_tier: string;
    producer_model: string | null;
  }>;
  rejected: Array<{
    lease_id: string;
    reason: string;
    message: string;
    producer_tier: string;
    producer_model: string | null;
  }>;
  released: Array<{ lease_id: string; error: string }>;
}

export async function runConsolidation(params?: {
  projectId?: string;
  limit?: number;
  leaseDurationSec?: number;
  fn?: GenerativeFunction;
}): Promise<ConsolidationRunReport> {
  const fn: GenerativeFunction = params?.fn ?? 'consolidate';

  const report: ConsolidationRunReport = {
    status: 'ok',
    tier: null,
    producer_model: null,
    considered: 0,
    stored: [],
    rejected: [],
    released: [],
  };

  let cfg;
  try {
    cfg = resolveChatConfig(fn);
  } catch (err) {
    report.status = 'misconfigured';
    report.message = err instanceof Error ? err.message : String(err);
    return report;
  }

  report.tier = cfg.tier;
  report.producer_model = cfg.model;

  if (cfg.tier === 'none') {
    // A finished state, not a broken one. Capture, storage, retrieval and
    // injection all keep working with every derived row absent (rule 6).
    report.status = 'disabled';
    report.message = `BRAIN_AI_${fn.toUpperCase()}/BRAIN_AI resolves to 'none': consolidation is deliberately off.`;
    return report;
  }

  if (cfg.tier === 'agent') {
    // The default. The host agent already holds the context, so it pulls
    // candidates and posts summaries back over MCP; leasing here would take
    // candidates away from it.
    report.status = 'agent';
    report.message =
      "tier 'agent' is the default: the host agent pulls candidates from GET /consolidate/candidates " +
      'and posts verified summaries to POST /consolidate/summaries. No server-side model runs.';
    return report;
  }

  const { candidates } = getConsolidationCandidates({
    projectId: params?.projectId,
    limit: params?.limit,
    leaseDurationSec: params?.leaseDurationSec,
  });
  report.considered = candidates.length;

  for (const candidate of candidates) {
    const user = buildUserPrompt(candidate, cfg.fieldChars);

    let completion;
    try {
      completion = await runChat(fn, { system: CONSOLIDATION_SYSTEM_PROMPT, user }, cfg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      releaseLease(candidate.lease_id);
      report.released.push({ lease_id: candidate.lease_id, error: message });
      report.status = 'unavailable';
      report.message = message;
      logger.error(
        { leaseId: candidate.lease_id, error: message },
        'consolidation producer unreachable; lease released and run stopped'
      );
      // Stop the run: the breaker is already counting, and there is nothing to
      // gain from asking a dead endpoint about the next candidate.
      break;
    }

    const result = verifyAndStoreSummary({
      lease_id: candidate.lease_id,
      claims: [],
      producer_tier: completion.producer_tier,
      producer_model: completion.producer_model,
      prompt_version: CONSOLIDATION_PROMPT_VERSION,
      // Raw and unedited. Empty content, finish_reason 'length' and
      // unparseable JSON all arrive as HTTP 200 and throw nothing, so the gate
      // is the only thing that can catch them.
      raw_response: completion.content,
      finish_reason: completion.finish_reason ?? undefined,
    });

    if (result.ok) {
      report.stored.push({
        lease_id: candidate.lease_id,
        summary_id: result.summary_id,
        outcome: result.outcome,
        claims_count: result.claims_count,
        producer_tier: completion.producer_tier,
        producer_model: completion.producer_model,
      });
    } else {
      report.rejected.push({
        lease_id: candidate.lease_id,
        reason: result.reason,
        message: result.message,
        producer_tier: completion.producer_tier,
        producer_model: completion.producer_model,
      });
      // The lease goes back so a better producer can retry the same session.
      releaseLease(candidate.lease_id);
    }
  }

  return report;
}

function buildUserPrompt(candidate: ConsolidationCandidate, fieldChars: number): string {
  return [
    `SESSION: ${candidate.session_id}`,
    `PROJECT: ${candidate.project_id ?? '(unscoped)'}`,
    '',
    renderObservationLog(candidate.observations, fieldChars),
  ].join('\n');
}
