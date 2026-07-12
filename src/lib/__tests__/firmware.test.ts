// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, it, expect } from "vitest";
// Import the REAL exported function — not a divergent local copy. The previous
// mirror used split(/[-.]/) and got prerelease ordering wrong, so it "passed"
// while the shipped comparator could have regressed unnoticed (it drives every
// OTA roll-forward/rollback decision).
import { compareSemver } from "../firmware";

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
