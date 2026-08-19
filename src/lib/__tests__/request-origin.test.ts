// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { hasTrustedMutationOrigin, checkMutationOrigin } from "@/lib/request-origin";

describe("hasTrustedMutationOrigin", () => {
  it("accepts the canonical public origin behind a reverse proxy", () => {
    const request = new Request("http://server:3000/api/v1/admin/server-update", {
      headers: { origin: "https://vellum.example.com" },
    });
    expect(hasTrustedMutationOrigin(request, "https://vellum.example.com")).toBe(true);
  });

  it("requires an Origin header for browser-session mutations", () => {
    const request = new Request("https://vellum.example.com/api/v1/admin/server-update");
    expect(hasTrustedMutationOrigin(request, "https://vellum.example.com")).toBe(false);
  });

  it("rejects a foreign origin even when forwarded headers claim it is trusted", () => {
    const request = new Request("http://server:3000/api/v1/admin/server-update", {
      headers: {
        origin: "https://attacker.example",
        "x-forwarded-host": "vellum.example.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(hasTrustedMutationOrigin(request, "https://vellum.example.com")).toBe(false);
  });

  it("falls back to the request origin when no canonical URL is configured", () => {
    const request = new Request("http://localhost:3000/api/v1/admin/server-update", {
      headers: { origin: "http://localhost:3000" },
    });
    expect(hasTrustedMutationOrigin(request)).toBe(true);
  });

  it("allows authenticated non-browser clients without an Origin header", () => {
    const request = new Request("https://vellum.example.com/api/v1/admin/server-update");
    expect(hasTrustedMutationOrigin(request, "https://vellum.example.com", true)).toBe(true);
  });

  it("rejects malformed Origin headers", () => {
    const request = new Request("https://vellum.example.com/api/v1/admin/server-update", {
      headers: { origin: "not a url" },
    });
    expect(hasTrustedMutationOrigin(request, "https://vellum.example.com")).toBe(false);
  });
});

describe("behind a TLS-terminating reverse proxy", () => {
  /* The live case, from a browser trace on an instance whose only fault was an
   * unset VELLUM_PUBLIC_URL: the browser spoke https to the proxy, the proxy spoke
   * http to Vellum, and the old fallback compared the browser's https origin
   * against the internal http one. Every admin mutation answered 403. */
  const proxied = () =>
    new Request("http://10.0.0.5:3000/api/v1/admin/server-update", {
      method: "POST",
      headers: {
        origin: "https://anny-display.example.edu",
        host: "anny-display.example.edu",
        "x-forwarded-proto": "https",
      },
    });

  it("accepts the browser's origin when no canonical URL is configured", () => {
    const verdict = checkMutationOrigin(proxied());
    expect(verdict.ok).toBe(true);
    /* Flagged so the caller can log that the deployment is running in the weaker
     * mode rather than the configured one. */
    expect(verdict.derivedFromHost).toBe(true);
  });

  it("still rejects a foreign origin in that weaker mode", () => {
    const request = new Request("http://10.0.0.5:3000/api/v1/admin/server-update", {
      method: "POST",
      headers: { origin: "https://attacker.example", host: "anny-display.example.edu" },
    });
    const verdict = checkMutationOrigin(request);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("mismatch");
    expect(verdict.expected).toBe("anny-display.example.edu");
    expect(verdict.received).toBe("attacker.example");
  });

  it("prefers X-Forwarded-Host over Host when a proxy sets it", () => {
    const request = new Request("http://10.0.0.5:3000/api/v1/admin/server-update", {
      headers: {
        origin: "https://public.example.edu",
        host: "internal.local",
        "x-forwarded-host": "public.example.edu",
      },
    });
    expect(checkMutationOrigin(request).ok).toBe(true);
  });

  /* A configured deployment keeps the strict comparison, including the scheme, so
   * an http origin against an https configuration is still refused. */
  it("keeps the configured origin authoritative when it is set", () => {
    const request = new Request("http://10.0.0.5:3000/api/v1/admin/server-update", {
      headers: { origin: "http://anny-display.example.edu", host: "anny-display.example.edu" },
    });
    const verdict = checkMutationOrigin(request, "https://anny-display.example.edu");
    expect(verdict.ok).toBe(false);
    expect(verdict.expected).toBe("https://anny-display.example.edu");
  });

  it("names why it refused, so a 403 is diagnosable", () => {
    const missing = checkMutationOrigin(
      new Request("https://vellum.example.com/api/v1/admin/server-update")
    );
    expect(missing).toEqual({ ok: false, reason: "missing" });

    const malformed = checkMutationOrigin(
      new Request("https://vellum.example.com/api/v1/admin/server-update", {
        headers: { origin: "not a url" },
      }),
      "https://vellum.example.com"
    );
    expect(malformed.reason).toBe("malformed");
  });
});
