// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * SSRF-guarded fetch for server-side requests to admin/user-controlled URLs
 * (iCal feeds, provider endpoints, firmware mirrors).
 *
 * Enforces http(s), resolves the hostname and rejects any address in a
 * loopback / link-local / private / cloud-metadata range, follows redirects
 * manually and re-validates every hop. (Residual DNS-rebinding TOCTOU remains;
 * pinning the resolved IP at the socket layer would close it fully.)
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 4;
const DEFAULT_TIMEOUT_MS = 15_000;

function ipToBytes(ip: string): number[] | null {
  if (isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    return p.length === 4 && p.every((n) => n >= 0 && n <= 255) ? p : null;
  }
  return null;
}

/** True for loopback / link-local / private / unique-local / metadata ranges. */
function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const b = ipToBytes(ip);
    if (!b) return true;
    const [a, c] = b;
    if (a === 0 || a === 10 || a === 127) return true; // this-host, private, loopback
    if (a === 169 && c === 254) return true; // link-local + cloud metadata (169.254.169.254)
    if (a === 172 && c >= 16 && c <= 31) return true; // 172.16/12
    if (a === 192 && c === 168) return true; // 192.168/16
    if (a === 100 && c >= 64 && c <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    const lc = ip.toLowerCase().replace(/^\[|\]$/g, "");
    if (lc === "::1" || lc === "::") return true; // loopback / unspecified
    if (lc.startsWith("fe80") || lc.startsWith("fc") || lc.startsWith("fd")) return true; // link-local / ULA
    if (lc.startsWith("::ffff:")) return isBlockedAddress(lc.slice(7)); // IPv4-mapped
    if (lc.startsWith("ff")) return true; // multicast
    return false;
  }
  return true; // not a literal IP shouldn't reach here
}

async function assertAllowedHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const candidates =
    isIP(host) !== 0 ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (candidates.length === 0) throw new Error(`safeFetch: cannot resolve ${hostname}`);
  for (const addr of candidates) {
    if (isBlockedAddress(addr)) {
      throw new Error(`safeFetch: blocked address ${addr} for host ${hostname}`);
    }
  }
}

export interface SafeFetchOptions extends RequestInit {
  timeoutMs?: number;
  /** Allow plaintext http:// (default: only outside production). */
  allowHttp?: boolean;
}

export async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, allowHttp, ...init } = opts;
  const httpOk = allowHttp ?? process.env.NODE_ENV !== "production";

  let url = input;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`safeFetch: invalid URL ${url}`);
    }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && httpOk)) {
      throw new Error(`safeFetch: blocked protocol ${parsed.protocol}`);
    }
    await assertAllowedHost(parsed.hostname);

    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });

    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      url = new URL(res.headers.get("location") as string, parsed).toString();
      continue;
    }
    return res;
  }
  throw new Error("safeFetch: too many redirects");
}
