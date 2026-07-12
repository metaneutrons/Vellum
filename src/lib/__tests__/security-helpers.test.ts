// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, it, expect, afterEach } from "vitest";
import { isBlockedAddress, safeFetch } from "../safe-fetch";
import { RateLimiter, getClientIp } from "../rate-limit";
import { otaReportSchema, renderQuerySchema, macSchema } from "../validation";
import { dbResilience } from "../db-resilience";

describe("safe-fetch SSRF guard — isBlockedAddress", () => {
  it.each([
    ["127.0.0.1", true], ["10.0.0.1", true], ["172.16.0.1", true], ["172.31.255.1", true],
    ["192.168.1.1", true], ["169.254.169.254", true], ["100.64.0.1", true], ["0.0.0.0", true],
    ["224.0.0.1", true], ["::1", true], ["fe80::1", true], ["fc00::1", true], ["fd12::1", true],
    ["::ffff:127.0.0.1", true],
    ["8.8.8.8", false], ["1.1.1.1", false], ["172.32.0.1", false], ["93.184.216.34", false],
    ["2606:4700:4700::1111", false],
  ])("%s → blocked=%s", (ip, blocked) => {
    expect(isBlockedAddress(ip)).toBe(blocked);
  });

  it("safeFetch rejects a loopback/metadata literal IP before any fetch", async () => {
    await expect(safeFetch("http://127.0.0.1/x", { allowHttp: true })).rejects.toThrow(/blocked address/);
    await expect(safeFetch("http://169.254.169.254/latest/meta-data", { allowHttp: true })).rejects.toThrow(/blocked address/);
  });

  it("safeFetch rejects non-http(s) protocols", async () => {
    await expect(safeFetch("ftp://example.com/")).rejects.toThrow(/blocked protocol/);
    await expect(safeFetch("file:///etc/passwd")).rejects.toThrow(/blocked protocol/);
  });
});

describe("rate-limit", () => {
  it("allows up to maxRequests then blocks within the window", () => {
    const rl = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
    expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(true);
    expect(rl.check("k").allowed).toBe(false); // 4th blocked
    expect(rl.check("other").allowed).toBe(true); // independent bucket
  });

  afterEach(() => { delete process.env.TRUST_PROXY_HEADERS; });

  it("getClientIp trusts X-Forwarded-For only when proxy headers are trusted", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
    delete process.env.TRUST_PROXY_HEADERS;
    expect(getClientIp(req)).toBe("1.2.3.4");
    process.env.TRUST_PROXY_HEADERS = "false";
    expect(getClientIp(req)).toBe("direct"); // spoofable header ignored
  });
});

describe("validation schemas", () => {
  it("macSchema accepts canonical MACs, rejects junk", () => {
    expect(macSchema.safeParse("AA:BB:CC:DD:EE:FF").success).toBe(true);
    expect(macSchema.safeParse("not-a-mac").success).toBe(false);
    expect(macSchema.safeParse("AA:BB:CC:DD:EE").success).toBe(false);
  });

  it("otaReportSchema requires a valid phase enum", () => {
    expect(otaReportSchema.safeParse({ mac: "AA:BB:CC:DD:EE:FF", phase: "not-a-phase" }).success).toBe(false);
    const ok = otaReportSchema.safeParse({ mac: "AA:BB:CC:DD:EE:FF", phase: "applied", toVersion: "1.1.0" });
    expect(ok.success).toBe(true);
  });

  it("renderQuerySchema requires a mac", () => {
    expect(renderQuerySchema.safeParse({}).success).toBe(false);
    expect(renderQuerySchema.safeParse({ mac: "AA:BB:CC:DD:EE:FF" }).success).toBe(true);
  });
});

describe("db-resilience execute()", () => {
  it("returns the operation result on success", async () => {
    await expect(dbResilience.execute(async () => 42)).resolves.toBe(42);
  });

  it("retries a TRANSIENT failure (ECONNREFUSED) then succeeds", async () => {
    let calls = 0;
    const result = await dbResilience.execute(async () => {
      calls++;
      if (calls < 2) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does NOT retry a non-transient error (e.g. SQL syntax) — fails fast", async () => {
    let calls = 0;
    await expect(
      dbResilience.execute(async () => { calls++; throw new Error("syntax error at or near"); })
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
