// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

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
