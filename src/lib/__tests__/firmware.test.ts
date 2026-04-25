import { describe, it, expect } from "vitest";

// Mirror the compareSemver logic from firmware.ts
function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[-.]/).map((s) => parseInt(s) || 0);
  const pb = b.replace(/^v/, "").split(/[-.]/).map((s) => parseInt(s) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

describe("Firmware version comparison", () => {
  it("detects newer versions", () => {
    expect(compareSemver("1.2.0", "1.1.0")).toBeGreaterThan(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.0.1", "1.0.0")).toBeGreaterThan(0);
  });

  it("detects same version", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });

  it("detects older versions", () => {
    expect(compareSemver("1.0.0", "1.1.0")).toBeLessThan(0);
    expect(compareSemver("0.9.0", "1.0.0")).toBeLessThan(0);
  });

  it("handles v prefix", () => {
    expect(compareSemver("v1.2.0", "v1.1.0")).toBeGreaterThan(0);
    expect(compareSemver("v1.0.0", "v1.0.0")).toBe(0);
  });
});
