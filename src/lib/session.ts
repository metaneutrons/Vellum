// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Signed admin session tokens.
 *
 * Replaces the previous constant `admin_session="authenticated"` cookie (which
 * was trivially forgeable) with an HMAC-SHA256-signed, expiring token:
 *
 *   <base64url(payload)>.<base64url(HMAC-SHA256(payload, SESSION_SECRET))>
 *
 * Built on the Web Crypto API (`crypto.subtle`) so the same code runs in the
 * Edge middleware and in Node server actions. The secret is read straight from
 * `process.env` (not the heavy env loader) to stay Edge-safe — `src/lib/env.ts`
 * still validates that `SESSION_SECRET` is present and ≥32 chars at boot.
 */

const COOKIE_NAME = "admin_session";
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export const SESSION_COOKIE = COOKIE_NAME;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    // env.ts already hard-fails at boot; this guards Edge/test paths.
    return process.env.NODE_ENV === "test" || process.env.VITEST
      ? "test-session-secret-at-least-32-chars-long"
      : "";
  }
  return s;
}

const encoder = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlEncodeStr(s: string): string {
  return b64urlEncode(encoder.encode(s));
}

function b64urlDecodeStr(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return bin;
}

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

/** Constant-time comparison of two equal-purpose strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Create a signed, expiring session token for an opaque database session id. */
export async function createSessionToken(
  subject: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<string> {
  const payload = b64urlEncodeStr(JSON.stringify({ sub: subject, exp: Date.now() + ttlMs }));
  const sig = await hmac(payload);
  return `${payload}.${sig}`;
}

/** Verify a session token: signature valid AND not expired. */
export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  if (!token || !secret()) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(payload);
  if (!timingSafeEqual(sig, expected)) return false;
  try {
    const data = JSON.parse(b64urlDecodeStr(payload)) as { exp?: number };
    return typeof data.exp === "number" && data.exp > Date.now();
  } catch {
    return false;
  }
}

/** Return a verified token subject without making this Edge-safe module depend on the DB. */
export async function getSessionTokenSubject(
  token: string | undefined | null
): Promise<string | null> {
  if (!(await verifySessionToken(token)) || !token) return null;
  try {
    const payload = token.slice(0, token.indexOf("."));
    const data = JSON.parse(b64urlDecodeStr(payload)) as { sub?: unknown };
    return typeof data.sub === "string" && data.sub.length > 0 ? data.sub : null;
  } catch {
    return null;
  }
}

/**
 * Constant-time comparison of a secret (e.g. the admin API key) regardless of
 * length: HMAC both sides with the session secret and compare fixed-size
 * digests, so neither length nor content leaks via timing.
 */
export async function safeEqualSecret(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const [ha, hb] = await Promise.all([hmac(a), hmac(b)]);
  return timingSafeEqual(ha, hb);
}
