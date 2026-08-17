// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  FIRMWARE_FAILURE_BACKOFF_MAX_MS,
  firmwareFailureBackoffMs,
  firmwareNextRetryAt,
  firmwareRefreshDue,
  firmwareRequestTimeoutMs,
  githubRetryAtMs,
} from "../firmware-catalog-policy";

describe("firmware catalog refresh policy", () => {
  it("backs off exponentially and caps prolonged failures", () => {
    expect(firmwareFailureBackoffMs(1)).toBe(30_000);
    expect(firmwareFailureBackoffMs(2)).toBe(60_000);
    expect(firmwareFailureBackoffMs(3)).toBe(120_000);
    expect(firmwareFailureBackoffMs(99)).toBe(FIRMWARE_FAILURE_BACKOFF_MAX_MS);
  });

  it("honors an upstream retry boundary when it is later", () => {
    const now = Date.parse("2026-08-17T12:00:00Z");
    expect(firmwareNextRetryAt(now, 1, now + 120_000).getTime()).toBe(now + 120_000);
    expect(firmwareNextRetryAt(now, 2, now + 10_000).getTime()).toBe(now + 60_000);
  });

  it("treats a missing or elapsed refresh boundary as due", () => {
    const now = 100_000;
    expect(firmwareRefreshDue(null, now)).toBe(true);
    expect(firmwareRefreshDue(new Date(now), now)).toBe(true);
    expect(firmwareRefreshDue(new Date(now + 1), now)).toBe(false);
  });

  it("bounds individual requests by the global deadline", () => {
    expect(firmwareRequestTimeoutMs(60_000, 40_000)).toBe(15_000);
    expect(firmwareRequestTimeoutMs(60_000, 55_000)).toBe(5_000);
    expect(firmwareRequestTimeoutMs(60_000, 60_001)).toBe(0);
  });

  it("parses Retry-After and GitHub rate-limit reset headers", () => {
    const now = 1_000_000;
    expect(githubRetryAtMs(new Headers({ "retry-after": "12" }), now)).toBe(now + 12_000);
    expect(githubRetryAtMs(new Headers({ "x-ratelimit-reset": "2000" }), now)).toBe(2_000_000);
    expect(githubRetryAtMs(new Headers(), now)).toBeNull();
  });
});
