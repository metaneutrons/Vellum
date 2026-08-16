// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

/**
 * Validate browser mutation requests against Vellum's canonical public origin.
 *
 * Reverse proxies legitimately make `request.url` differ from the URL seen by
 * the browser. `VELLUM_PUBLIC_URL` is operator-controlled and therefore the
 * only trusted production source; forwarded headers remain intentionally
 * ignored. Development installations without a canonical URL fall back to the
 * request URL. Non-browser API clients may omit Origin and still authenticate
 * with their scoped credential.
 */
export function hasTrustedMutationOrigin(
  request: Request,
  publicUrl?: string,
  allowMissing = false
): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return allowMissing;

  try {
    const expected = new URL(publicUrl ?? request.url).origin;
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}
