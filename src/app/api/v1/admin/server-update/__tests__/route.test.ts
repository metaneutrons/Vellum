// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  managedExternally: false,
  /* The parameters mirror writeAudit's own signature, so the recorded calls
   * carry an arity and can be read by position. */
  writeAudit: vi.fn(
    async (
      _actor: unknown,
      _action: string,
      _targetType: string,
      _targetId?: string | null,
      _metadata?: Record<string, unknown>,
      _outcome?: "success" | "failure"
    ) => undefined
  ),
  requestServerUpdate: vi.fn(async () => ({ supported: true, managedBy: null })),
  requestServerUpdateCheck: vi.fn(async () => ({ supported: true, managedBy: null })),
  configureServerUpdates: vi.fn(async () => ({ supported: true, managedBy: null })),
  getServerUpdateStatus: vi.fn(async () => ({
    supported: false,
    availabilityReason: "not-configured",
    state: "unavailable",
    currentVersion: null,
    availableVersion: null,
    managedBy: "coolify",
  })),
}));

vi.mock("@/lib/access", () => ({
  getRequestPrincipal: vi.fn(async () => ({ type: "user", id: "u1" })),
  hasPermission: vi.fn(() => true),
  writeAudit: mocks.writeAudit,
}));
vi.mock("@/lib/request-origin", () => ({
  checkMutationOrigin: vi.fn(() => ({ ok: true })),
}));
vi.mock("@/lib/env", () => ({ env: { VELLUM_PUBLIC_URL: "https://vellum.example.com" } }));
vi.mock("@/lib/logger", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/server-updater", () => ({
  isManagedExternally: () => mocks.managedExternally,
  getServerUpdateStatus: mocks.getServerUpdateStatus,
  requestServerUpdate: mocks.requestServerUpdate,
  requestServerUpdateCheck: mocks.requestServerUpdateCheck,
  configureServerUpdates: mocks.configureServerUpdates,
}));

import { POST } from "../route";

function post(body: unknown): Request {
  return new Request("https://vellum.example.com/api/v1/admin/server-update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.managedExternally = false;
});

describe("POST /api/v1/admin/server-update under a platform that deploys itself", () => {
  /* 409 rather than 503: the installation is not broken, the request conflicts
   * with how it is deployed. */
  it("refuses every action with 409 and asks the updater nothing", async () => {
    mocks.managedExternally = true;

    for (const body of [
      { action: "check" },
      { action: "apply" },
      { action: "configure", mode: "manual", maintenanceTime: "02:00", timezone: "UTC" },
    ]) {
      const response = await POST(post(body));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ managedBy: "coolify" });
    }

    expect(mocks.requestServerUpdate).not.toHaveBeenCalled();
    expect(mocks.requestServerUpdateCheck).not.toHaveBeenCalled();
    expect(mocks.configureServerUpdates).not.toHaveBeenCalled();
  });

  /* A refused update is worth seeing in the trail, but it must not be recorded
   * as an intent that reached anything. */
  it("records the refusal and not a request", async () => {
    mocks.managedExternally = true;

    await POST(post({ action: "apply" }));

    const actions = mocks.writeAudit.mock.calls.map((call) => call[1]);
    expect(actions).toEqual(["server.update.apply.rejected"]);
    expect(mocks.writeAudit.mock.calls[0]?.[4]).toMatchObject({ managedBy: "coolify" });
  });

  it("leaves a plain Compose installation alone", async () => {
    const response = await POST(post({ action: "apply" }));

    expect(response.status).toBe(202);
    expect(mocks.requestServerUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit.mock.calls.map((call) => call[1])).toEqual([
      "server.update.apply.requested",
      "server.update.apply.accepted",
    ]);
  });

  /* An invalid body is still a 400: the refusal must not swallow input errors
   * and report a conflict for something that was never a valid request. */
  it("still rejects an invalid action with 400", async () => {
    mocks.managedExternally = true;

    expect((await POST(post({ action: "reboot" }))).status).toBe(400);
  });
});
