/**
 * A circuit breaker so a dead endpoint cannot stall the consolidation queue.
 *
 * A pattern worth keeping from earlier memory tools. Keyed per
 * producer (tier + endpoint/vendor + model) so one dead vendor does not open
 * the circuit for a healthy local endpoint.
 *
 * A tripped breaker is a *dependency* failure, never a dead letter: rule 3
 * says dead letters are for malformed records only, never for a dependency
 * being down.
 */

import { logger } from '../lib/logger';

export class CircuitOpenError extends Error {
  readonly code = 'circuit_open';
  readonly retryAfterMs: number;

  constructor(key: string, retryAfterMs: number) {
    super(
      `circuit breaker open for producer '${key}' — retry in ${retryAfterMs}ms. ` +
        'No record was written and nothing was dead-lettered; this is a dependency failure.'
    );
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}

export function isCircuitOpenError(error: unknown): error is CircuitOpenError {
  return error instanceof CircuitOpenError;
}

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
  lastError: string | null;
}

const breakers = new Map<string, BreakerState>();

function stateFor(key: string): BreakerState {
  let state = breakers.get(key);
  if (!state) {
    state = { consecutiveFailures: 0, openedAt: null, lastError: null };
    breakers.set(key, state);
  }
  return state;
}

export interface BreakerOptions {
  threshold: number;
  cooldownMs: number;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
}

/** Throws CircuitOpenError when the breaker is open and still cooling down. */
export function assertCircuitClosed(key: string, options: BreakerOptions): void {
  const state = stateFor(key);
  if (state.openedAt === null) return;

  const now = (options.now ?? Date.now)();
  const elapsed = now - state.openedAt;
  if (elapsed < options.cooldownMs) {
    throw new CircuitOpenError(key, options.cooldownMs - elapsed);
  }

  // Cooldown elapsed: half-open. One request is allowed through; its result
  // either closes the breaker or re-opens it.
  state.openedAt = null;
  state.consecutiveFailures = options.threshold - 1;
  logger.info({ producer: key }, 'circuit breaker half-open, allowing one probe request');
}

export function recordSuccess(key: string): void {
  const state = stateFor(key);
  if (state.consecutiveFailures > 0 || state.openedAt !== null) {
    logger.info({ producer: key }, 'circuit breaker closed after successful request');
  }
  state.consecutiveFailures = 0;
  state.openedAt = null;
  state.lastError = null;
}

export function recordFailure(key: string, error: unknown, options: BreakerOptions): void {
  const state = stateFor(key);
  state.consecutiveFailures += 1;
  state.lastError = error instanceof Error ? error.message : String(error);

  if (state.consecutiveFailures >= options.threshold && state.openedAt === null) {
    state.openedAt = (options.now ?? Date.now)();
    logger.error(
      {
        producer: key,
        consecutiveFailures: state.consecutiveFailures,
        cooldownMs: options.cooldownMs,
        lastError: state.lastError,
      },
      'circuit breaker opened for generative producer'
    );
  }
}

export function getBreakerStatus(): Array<{
  producer: string;
  open: boolean;
  consecutive_failures: number;
  last_error: string | null;
}> {
  return Array.from(breakers.entries()).map(([producer, state]) => ({
    producer,
    open: state.openedAt !== null,
    consecutive_failures: state.consecutiveFailures,
    last_error: state.lastError,
  }));
}

export function resetCircuitBreakers(): void {
  breakers.clear();
}
