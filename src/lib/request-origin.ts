// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

/**
 * Validate browser mutation requests against Vellum's own origin.
 *
 * The property being protected is CSRF: a cross-site page cannot set `Origin`,
 * so an `Origin` that matches this deployment proves the request came from it.
 * Non-browser API clients omit the header entirely and authenticate with a scoped
 * credential instead.
 *
 * `VELLUM_PUBLIC_URL` is operator-controlled and stays the authoritative source.
 * What changed is the fallback when it is unset.
 *
 * The previous fallback compared against `new URL(request.url).origin`, and behind
 * a TLS-terminating reverse proxy — the documented deployment shape — that can
 * essentially never match. Next.js builds `request.url` from the connection it
 * actually received, so the scheme is `http` even when the browser spoke `https`,
 * and the host may be an internal name. The result was a bare 403 on every admin
 * mutation with nothing logged and nothing to distinguish it from a permission
 * failure. It cost an afternoon on a live instance whose only fault was an unset
 * environment variable.
 *
 * So when `VELLUM_PUBLIC_URL` is absent, the expected host is taken from the
 * request's own `Host` (or `X-Forwarded-Host`) and only the HOST is compared, not
 * the scheme, because the internal scheme is not observable. That is weaker, and
 * deliberately so: the header is spoofable by a direct caller, but a direct caller
 * has no session cookie, and a browser cannot be made to send a false `Origin`.
 * The strong configuration remains setting `VELLUM_PUBLIC_URL`, and an unset one
 * is now reported rather than silently degraded.
 */

export type OriginRejection = "missing" | "malformed" | "mismatch";

export interface OriginVerdict {
  ok: boolean;
  reason?: OriginRejection;
  /** What the deployment believes it is. Safe to log; never a secret. */
  expected?: string;
  /** What the browser claimed. */
  received?: string;
  /** True when no VELLUM_PUBLIC_URL was configured and the Host was used. */
  derivedFromHost?: boolean;
}

function hostFromRequest(request: Request): string | null {
  /* X-Forwarded-Host first, mirroring how rate limiting reads X-Forwarded-For, and
   * with the same caveat: it is only meaningful behind a proxy that sets it. Then
   * Host. Then the request URL, which is all a synthetic Request carries, since
   * `host` is a forbidden header that fetch does not expose. */
  const forwarded = request.headers.get("x-forwarded-host");
  const host = forwarded?.split(",")[0]?.trim() || request.headers.get("host")?.trim();
  if (host) return host;
  try {
    return new URL(request.url).host || null;
  } catch {
    return null;
  }
}

export function checkMutationOrigin(
  request: Request,
  publicUrl?: string,
  allowMissing = false
): OriginVerdict {
  const received = request.headers.get("origin");
  if (!received) return { ok: allowMissing, reason: allowMissing ? undefined : "missing" };

  let originUrl: URL;
  try {
    originUrl = new URL(received);
  } catch {
    return { ok: false, reason: "malformed", received };
  }

  if (publicUrl) {
    try {
      const expected = new URL(publicUrl);
      /* Full origin when configured: a configured https deployment refusing an
       * http origin is a downgrade signal worth keeping. */
      if (expected.origin === originUrl.origin) return { ok: true, expected: expected.origin };
      return {
        ok: false,
        reason: "mismatch",
        expected: expected.origin,
        received: originUrl.origin,
      };
    } catch {
      /* A malformed VELLUM_PUBLIC_URL cannot be validated against, and env.ts
       * already rejects one at boot, so this is unreachable in practice. Failing
       * closed rather than falling through keeps it that way. */
      return { ok: false, reason: "malformed", received: originUrl.origin };
    }
  }

  const host = hostFromRequest(request);
  if (!host) return { ok: false, reason: "mismatch", received: originUrl.origin };
  if (host.toLowerCase() === originUrl.host.toLowerCase()) {
    return { ok: true, expected: host, derivedFromHost: true };
  }
  return {
    ok: false,
    reason: "mismatch",
    expected: host,
    received: originUrl.host,
    derivedFromHost: true,
  };
}

/** Boolean form, for callers that do not report the reason. */
export function hasTrustedMutationOrigin(
  request: Request,
  publicUrl?: string,
  allowMissing = false
): boolean {
  return checkMutationOrigin(request, publicUrl, allowMissing).ok;
}
