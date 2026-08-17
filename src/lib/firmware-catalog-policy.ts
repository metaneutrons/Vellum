// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

/** Pure timing policy for the durable firmware catalog. Kept independent from
 * Next.js and PostgreSQL so the failure semantics are exhaustively testable. */

export const FIRMWARE_REFRESH_LEASE_MS = 90_000;
export const FIRMWARE_REFRESH_DEADLINE_MS = 45_000;
export const FIRMWARE_FAILURE_BACKOFF_BASE_MS = 30_000;
export const FIRMWARE_FAILURE_BACKOFF_MAX_MS = 15 * 60_000;

/** Failure count is one-based: the first failure waits 30 s, then 60 s, etc. */
export function firmwareFailureBackoffMs(failureCount: number): number {
  const exponent = Math.max(0, Math.min(20, Math.trunc(failureCount) - 1));
  return Math.min(
    FIRMWARE_FAILURE_BACKOFF_MAX_MS,
    FIRMWARE_FAILURE_BACKOFF_BASE_MS * 2 ** exponent
  );
}

/** Never retry before either our own backoff or an upstream Retry-After/reset. */
export function firmwareNextRetryAt(
  nowMs: number,
  failureCount: number,
  upstreamRetryAtMs?: number | null
): Date {
  const local = nowMs + firmwareFailureBackoffMs(failureCount);
  const upstream = upstreamRetryAtMs && upstreamRetryAtMs > nowMs ? upstreamRetryAtMs : 0;
  return new Date(Math.max(local, upstream));
}

export function firmwareRefreshDue(nextRefreshAt: Date | null, nowMs: number): boolean {
  return !nextRefreshAt || nextRefreshAt.getTime() <= nowMs;
}

/** Remaining budget for one upstream operation within the global refresh cap. */
export function firmwareRequestTimeoutMs(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.min(15_000, deadlineMs - nowMs));
}

/** GitHub's Retry-After may be seconds; X-RateLimit-Reset is an epoch second. */
export function githubRetryAtMs(headers: Headers, nowMs: number): number | null {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return nowMs + seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return date;
  }

  const resetSeconds = Number(headers.get("x-ratelimit-reset"));
  return Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds * 1000 : null;
}
