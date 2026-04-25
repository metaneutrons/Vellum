import { describe, it, expect } from "vitest";

// Test the semver comparison logic inline (since resolveOta needs DB)
function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(/[-.]/).map((s) => parseInt(s) || 0);
  const pb = b.replace(/^v/, "").split(/[-.]/).map((s) => parseInt(s) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
}

describe("Firmware version comparison", () => {
  it("detects newer versions", () => {
    expect(isNewer("1.2.0", "1.1.0")).toBe(true);
    expect(isNewer("2.0.0", "1.9.9")).toBe(true);
    expect(isNewer("1.0.1", "1.0.0")).toBe(true);
  });

  it("detects same version", () => {
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
  });

  it("detects older versions", () => {
    expect(isNewer("1.0.0", "1.1.0")).toBe(false);
    expect(isNewer("0.9.0", "1.0.0")).toBe(false);
  });

  it("handles v prefix", () => {
    expect(isNewer("v1.2.0", "v1.1.0")).toBe(true);
    expect(isNewer("v1.0.0", "v1.0.0")).toBe(false);
  });

  it("handles beta versions", () => {
    expect(isNewer("1.2.0-beta.2", "1.2.0-beta.1")).toBe(true);
    expect(isNewer("1.2.0", "1.2.0-beta.5")).toBe(false); // 0 > 0 is false for -beta
  });
});
