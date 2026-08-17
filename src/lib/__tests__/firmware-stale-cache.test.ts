// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

const manifest = {
  version: "1.4.12",
  channel: "stable",
  date: "2026-08-17T00:00:00Z",
  tag: "firmware-v1.4.12",
  binaries: {},
};

const stateRow = {
  source: "github-releases",
  manifests: [manifest],
  etag: '"catalog-etag"',
  lastAttemptAt: null,
  lastSuccessAt: new Date("2026-08-17T00:00:00Z"),
  nextRefreshAt: null,
  failureCount: 0,
  lastError: null,
  leaseOwner: null,
  leaseUntil: null,
  updatedAt: new Date("2026-08-17T00:00:00Z"),
};

const insert = vi.fn(() => ({
  values: vi.fn(() => ({ onConflictDoNothing: vi.fn(async () => undefined) })),
}));
const select = vi.fn(() => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({ limit: vi.fn(async () => [stateRow]) })),
  })),
}));
const update = vi.fn(() => ({
  set: vi.fn(() => ({
    where: vi.fn(() => ({ returning: vi.fn(async () => [{ failureCount: 0 }]) })),
  })),
}));

vi.mock("@/db", () => ({
  db: { insert, select, update },
  withDbRead: (operation: () => Promise<unknown>) => operation(),
  withDbWrite: (operation: () => Promise<unknown>) => operation(),
}));
vi.mock("../settings", () => ({ getSetting: vi.fn(async () => 900) }));
vi.mock("../rollout", () => ({
  deviceFailedTarget: vi.fn(async () => false),
  isDeviceInRollout: vi.fn(async () => true),
}));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("firmware catalog stale-while-revalidate", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    );
  });

  it("returns the durable snapshot without waiting for an in-flight GitHub request", async () => {
    const { getAllManifests } = await import("../firmware");
    const timeout = new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100));

    const result = await Promise.race([getAllManifests(), timeout]);

    expect(result).toEqual([manifest]);
    // Let the leased background task advance through its DB claim.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
