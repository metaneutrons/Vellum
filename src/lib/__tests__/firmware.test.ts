// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, it, expect } from "vitest";
// Import the REAL exported function — not a divergent local copy. The previous
// mirror used split(/[-.]/) and got prerelease ordering wrong, so it "passed"
// while the shipped comparator could have regressed unnoticed (it drives every
// OTA roll-forward/rollback decision).
import {
  compareSemver,
  parseFirmwareManifest,
  reconcileFirmwareManifestCache,
  type FirmwareManifest,
} from "../firmware";

describe("compareSemver (the real exported comparator)", () => {
  it("orders major.minor.patch", () => {
    expect(compareSemver("1.2.0", "1.1.0")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("0.9.0", "1.0.0")).toBeLessThan(0);
  });

  it("handles the v prefix", () => {
    expect(compareSemver("v1.2.0", "v1.1.0")).toBeGreaterThan(0);
    expect(compareSemver("v1.0.0", "1.0.0")).toBe(0);
  });

  it("ignores build metadata (+sha)", () => {
    expect(compareSemver("1.1.0+abc123", "1.1.0+def456")).toBe(0);
    expect(compareSemver("1.1.0-beta.4+abc", "1.1.0-beta.4+xyz")).toBe(0);
    expect(compareSemver("v1.1.0+sha", "v1.1.0")).toBe(0);
  });

  it("orders a release ABOVE its own prereleases", () => {
    expect(compareSemver("1.1.0", "1.1.0-beta.4")).toBeGreaterThan(0);
    expect(compareSemver("1.1.0-beta.4", "1.1.0")).toBeLessThan(0);
    // The bug that motivated this: a beta device on 1.1.0-beta.4 must see stable
    // 1.1.0 as NEWER (roll forward), not the other way round.
    expect(compareSemver("1.1.0", "1.0.0-beta.361")).toBeGreaterThan(0);
  });

  it("orders prerelease numbers NUMERICALLY, not lexically (beta.10 > beta.3)", () => {
    expect(compareSemver("1.0.0-beta.10", "1.0.0-beta.3")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
    expect(compareSemver("1.0.0-beta.5", "1.0.0-beta.5")).toBe(0);
  });
});

describe("firmware release cache reconciliation", () => {
  it("removes retired GitHub releases from a warm process cache", () => {
    const manifest = (version: string): FirmwareManifest => ({
      version,
      channel: "stable",
      date: "2026-08-15T00:00:00Z",
      tag: `firmware-v${version}`,
      binaries: {},
    });
    const cache = new Map([
      ["firmware-v1.3.4", manifest("1.3.4")],
      ["firmware-v1.4.3", manifest("1.4.3")],
    ]);

    expect(reconcileFirmwareManifestCache(cache, new Set(["firmware-v1.4.3"]))).toBe(1);
    expect([...cache.keys()]).toEqual(["firmware-v1.4.3"]);
  });
});

describe("firmware manifest trust boundary", () => {
  const payload = {
    version: "1.4.12-beta.1",
    channel: "untrusted-upstream-value",
    date: "2026-08-17T00:00:00Z",
    binaries: {
      e1002: {
        url: "https://github.com/example/factory.bin",
        size: 123,
        otaUrl: "https://github.com/example/ota.bin",
        otaSha256: "a".repeat(64),
        otaSignature: "",
        otaKeyId: "",
        otaSize: 100,
      },
    },
  };

  it("accepts the release workflow's unsigned beta shape and owns tag/channel", () => {
    const manifest = parseFirmwareManifest(payload, "firmware-v1.4.12-beta.1", true);
    expect(manifest.tag).toBe("firmware-v1.4.12-beta.1");
    expect(manifest.channel).toBe("beta");
    expect(manifest.binaries.e1002!.otaSignature).toBe("");
  });

  it("rejects malformed hashes before they can become OTA offers", () => {
    expect(() =>
      parseFirmwareManifest(
        {
          ...payload,
          binaries: { e1002: { ...payload.binaries.e1002, otaSha256: "not-a-digest" } },
        },
        "firmware-v1.4.12",
        false
      )
    ).toThrow();
  });
});
