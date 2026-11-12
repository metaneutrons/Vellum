// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* `server-updater` is `server-only` and reads the environment through the `env`
 * module, so both are replaced here. The env object is mutable so a case can
 * decide what the installation looks like without reloading the module. */
const mocks = vi.hoisted(() => ({
  env: {
    UPDATER_URL: "http://updater:8080",
    UPDATER_TOKEN: "t".repeat(32),
    COOLIFY_RESOURCE_UUID: undefined as string | undefined,
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ env: mocks.env }));

import { getServerUpdateStatus, isManagedExternally, requestServerUpdate } from "../server-updater";

const updaterStatus = (overrides: Record<string, unknown> = {}) => ({
  state: "current",
  currentVersion: "v1.23.4",
  availableVersion: "v1.23.4",
  updateAvailable: false,
  updateMode: "manual",
  maintenanceTime: "02:00",
  timezone: "UTC",
  lastCheckedAt: null,
  lastUpdatedAt: null,
  lastError: null,
  ...overrides,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.env.UPDATER_URL = "http://updater:8080";
  mocks.env.UPDATER_TOKEN = "t".repeat(32);
  mocks.env.COOLIFY_RESOURCE_UUID = undefined;
  fetchMock = vi.fn(async () => new Response(JSON.stringify(updaterStatus()), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an installation a platform deploys itself", () => {
  /* The whole point: no request may leave the server. Asking the updater would
   * be pointless — it is about to be replaced by the platform — and under
   * Coolify the updater is not even reachable in the same way. */
  it("is recognised from the environment and no updater is asked", async () => {
    mocks.env.COOLIFY_RESOURCE_UUID = "0f6c0b4e-1e2a-4a0a-9a1b-3f9a1c2d4e5f";

    const status = await getServerUpdateStatus();

    expect(status.managedBy).toBe("coolify");
    expect(status.supported).toBe(false);
    expect(status.availabilityReason).toBe("not-configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /* A token left over from an earlier Compose installation must not re-enable
   * updating, so the platform check has to run BEFORE the configured check. */
  it("is recognised even when an updater is still configured", async () => {
    mocks.env.COOLIFY_RESOURCE_UUID = "any-value";

    expect(isManagedExternally()).toBe(true);
    expect((await requestServerUpdate()).managedBy).toBe("coolify");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is not assumed when the variable is absent", async () => {
    const status = await getServerUpdateStatus();

    expect(status.managedBy).toBeNull();
    expect(isManagedExternally()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /* The server cannot see container labels, so an installation whose server was
   * started without the variable is still caught by what the updater reports. */
  it("is taken from the updater when only the updater can see it", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(updaterStatus({ managedBy: "coolify" })), { status: 200 })
    );

    const status = await getServerUpdateStatus();

    expect(status.managedBy).toBe("coolify");
    expect(status.supported).toBe(true);
  });

  it("accepts an updater that does not report the field yet", async () => {
    const status = await getServerUpdateStatus();

    expect(status.managedBy).toBeNull();
    expect(status.supported).toBe(true);
  });

  it("reports no platform when the updater is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const status = await getServerUpdateStatus();

    expect(status.availabilityReason).toBe("unreachable");
    expect(status.managedBy).toBeNull();
  });
});
