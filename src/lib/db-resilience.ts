// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file db-resilience.ts
 * @brief Enterprise-grade database resilience layer.
 *
 * Provides:
 * - Automatic retry with exponential backoff for transient failures
 * - Circuit breaker pattern (halts operations after repeated failures)
 * - Health state tracking exposed to WebUI and API
 * - Event emitter for UI notifications
 * - Graceful degradation: read-only mode when DB is unreachable
 */

import { log } from "@/lib/logger";
import { EventEmitter } from "events";

/* ── Configuration ────────────────────────────────────────────── */

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 10_000;
const CIRCUIT_BREAKER_THRESHOLD = 5; // consecutive failures to open circuit
const CIRCUIT_BREAKER_RESET_MS = 30_000; // time before half-open retry
const HEALTH_CHECK_INTERVAL_MS = 10_000;

/* ── Types ────────────────────────────────────────────────────── */

export type CircuitState = "closed" | "open" | "half-open";

export interface DbHealthState {
  connected: boolean;
  circuit: CircuitState;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
  totalRetries: number;
  totalFailures: number;
}

export type DbEvent =
  | { type: "connected" }
  | { type: "disconnected"; error: string }
  | { type: "circuit_open"; failures: number }
  | { type: "circuit_closed" }
  | { type: "retry"; attempt: number; maxAttempts: number; error: string };

/* ── Transient error detection ────────────────────────────────── */

const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", // connection_exception
  "08003", // connection_does_not_exist
  "08006", // connection_failure
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);

function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
  if (e.cause && typeof e.cause === "object") {
    const cause = e.cause as Record<string, unknown>;
    if (typeof cause.code === "string" && TRANSIENT_CODES.has(cause.code)) return true;
  }
  const msg = String(e.message ?? "");
  return msg.includes("ECONNREFUSED") || msg.includes("ENETUNREACH") || msg.includes("ETIMEDOUT");
}

/* ── Resilience Manager (Singleton) ──────────────────────────── */

class DbResilienceManager extends EventEmitter {
  private circuit: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private lastErrorAt: Date | null = null;
  private lastSuccessAt: Date | null = null;
  private totalRetries = 0;
  private totalFailures = 0;
  private circuitOpenedAt: number = 0;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private _checkDbFn: (() => Promise<void>) | null = null;

  /** Register the health check function (avoids circular import) */
  registerHealthCheck(fn: () => Promise<void>) {
    this._checkDbFn = fn;
  }

  /** Start periodic health monitoring */
  startMonitoring() {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(() => this.probe(), HEALTH_CHECK_INTERVAL_MS);
    this.probe();
  }

  stopMonitoring() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /** Get current health state (for API/WebUI) */
  getState(): DbHealthState {
    return {
      connected: this.circuit !== "open",
      circuit: this.circuit,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt?.toISOString() ?? null,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      totalRetries: this.totalRetries,
      totalFailures: this.totalFailures,
    };
  }

  /** Execute a database operation with retry and circuit breaker */
  async execute<T>(operation: () => Promise<T>, label?: string): Promise<T> {
    // Circuit breaker: reject immediately if open
    if (this.circuit === "open") {
      const elapsed = Date.now() - this.circuitOpenedAt;
      if (elapsed < CIRCUIT_BREAKER_RESET_MS) {
        throw new DbUnavailableError(
          `Database circuit breaker open (${this.consecutiveFailures} consecutive failures). ` +
          `Retry in ${Math.ceil((CIRCUIT_BREAKER_RESET_MS - elapsed) / 1000)}s.`
        );
      }
      // Half-open: allow one attempt
      this.circuit = "half-open";
      log.info("Database circuit half-open, attempting reconnect");
    }

    // Retry loop with exponential backoff
    let lastErr: unknown;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        const result = await operation();
        this.recordSuccess();
        return result;
      } catch (err) {
        lastErr = err;

        if (!isTransientError(err)) {
          // Non-transient (e.g. SQL syntax error) — don't retry
          throw err;
        }

        this.totalRetries++;
        const delay = Math.min(
          RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
          RETRY_MAX_DELAY_MS
        );

        if (attempt < RETRY_ATTEMPTS) {
          log.warn("Database operation failed, retrying", {
            label,
            attempt,
            maxAttempts: RETRY_ATTEMPTS,
            delay,
            error: String(err),
          });
          this.emitEvent({ type: "retry", attempt, maxAttempts: RETRY_ATTEMPTS, error: String(err) });
          await sleep(delay);
        }
      }
    }

    // All retries exhausted
    this.recordFailure(lastErr);
    throw lastErr;
  }

  private recordSuccess() {
    if (this.consecutiveFailures > 0 || this.circuit !== "closed") {
      log.info("Database connection restored", {
        previousFailures: this.consecutiveFailures,
      });
      this.emitEvent({ type: "connected" });
      this.emitEvent({ type: "circuit_closed" });
    }
    this.consecutiveFailures = 0;
    this.circuit = "closed";
    this.lastSuccessAt = new Date();
  }

  private recordFailure(err: unknown) {
    this.consecutiveFailures++;
    this.totalFailures++;
    this.lastError = String(err);
    this.lastErrorAt = new Date();

    log.error("Database operation failed after retries", {
      consecutiveFailures: this.consecutiveFailures,
      error: this.lastError,
    });

    this.emitEvent({ type: "disconnected", error: this.lastError });

    // Open circuit breaker if threshold reached
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && this.circuit !== "open") {
      this.circuit = "open";
      this.circuitOpenedAt = Date.now();
      log.error("Database circuit breaker OPEN — halting DB operations", {
        failures: this.consecutiveFailures,
        resetIn: `${CIRCUIT_BREAKER_RESET_MS / 1000}s`,
      });
      this.emitEvent({ type: "circuit_open", failures: this.consecutiveFailures });
    }
  }

  private async probe() {
    if (!this._checkDbFn) return;
    try {
      await this._checkDbFn();
      if (this.circuit === "open" || this.consecutiveFailures > 0) {
        this.recordSuccess();
      }
    } catch {
      // Probe failure is silent — just updates state
      if (this.circuit === "closed") {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          this.circuit = "open";
          this.circuitOpenedAt = Date.now();
          this.emitEvent({ type: "circuit_open", failures: this.consecutiveFailures });
        }
      }
    }
  }

  private emitEvent(event: DbEvent) {
    this.emit("db_event", event);
  }
}

/* ── Error class ──────────────────────────────────────────────── */

export class DbUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbUnavailableError";
  }
}

/* ── Singleton export ─────────────────────────────────────────── */

export const dbResilience = new DbResilienceManager();

/* ── Helper ───────────────────────────────────────────────────── */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
