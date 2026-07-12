// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * In-memory sliding-window rate limiter.
 *
 * Each limiter instance tracks request counts per key (typically IP)
 * within a configurable time window. Thread-safe for single-process
 * deployments; for multi-instance, replace with Redis-backed store.
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimiterConfig {
  /** Maximum requests per window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxRequests: 60,
  windowMs: 60_000,
};

export class RateLimiter {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly config: RateLimiterConfig;

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if a request from the given key is allowed.
   * Returns { allowed, remaining, resetAt }.
   */
  check(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || now >= entry.resetAt) {
      const resetAt = now + this.config.windowMs;
      this.store.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.config.maxRequests - 1, resetAt };
    }

    entry.count++;
    const remaining = Math.max(0, this.config.maxRequests - entry.count);
    return {
      allowed: entry.count <= this.config.maxRequests,
      remaining,
      resetAt: entry.resetAt,
    };
  }
}

/** Rate limiter for unauthenticated endpoints (hello) — stricter */
export const helloLimiter = new RateLimiter({ maxRequests: 10, windowMs: 60_000 });

/** Admin login — very strict to blunt password brute-forcing (per IP). */
export const loginLimiter = new RateLimiter({ maxRequests: 5, windowMs: 15 * 60_000 });

/** Rate limiter for authenticated endpoints — more generous */
export const apiLimiter = new RateLimiter({ maxRequests: 60, windowMs: 60_000 });

/**
 * Extract the client IP used to key rate limits.
 *
 * Forwarding headers (`X-Forwarded-For` / `X-Real-IP`) are honored ONLY when the
 * app is behind a trusted reverse proxy that OVERWRITES them — the shipped Docker
 * deployment. A directly-exposed instance MUST set `TRUST_PROXY_HEADERS=false`,
 * otherwise a client could spoof `X-Forwarded-For` to mint a fresh rate-limit
 * bucket per request and bypass every limit (login brute-force + API flood).
 * When headers are not trusted (or absent) all such requests share one bucket,
 * which errs toward over-limiting rather than allowing a bypass.
 */
export function getClientIp(request: Request): string {
  if (process.env.TRUST_PROXY_HEADERS !== "false") {
    const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (fwd) return fwd;
    const real = request.headers.get("x-real-ip");
    if (real) return real;
  }
  return "direct";
}

/**
 * Apply rate limit check and return a 429 Response if exceeded,
 * or null if the request is allowed.
 */
export function applyRateLimit(
  limiter: RateLimiter,
  key: string
): Response | null {
  const { allowed, remaining, resetAt } = limiter.check(key);
  if (!allowed) {
    return new Response(
      JSON.stringify({ status: "error", data: null, error: "Too many requests" }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.ceil((resetAt - Date.now()) / 1000)),
          "X-RateLimit-Remaining": "0",
        },
      }
    );
  }
  // Headers will be added by the caller if needed
  void remaining;
  return null;
}
