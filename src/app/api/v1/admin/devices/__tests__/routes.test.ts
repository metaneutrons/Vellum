// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const unsubscribe = vi.fn();

vi.mock("@/lib/access", () => ({
  requestHasPermission: vi.fn(async () => true),
}));
vi.mock("@/lib/device-snapshot", () => ({
  getDeviceSnapshots: vi.fn(async (macs?: readonly string[]) =>
    (macs ?? ["AA:BB:CC:DD:EE:FF"]).map((mac) => ({ mac }))
  ),
}));
vi.mock("@/lib/device-events", () => ({
  subscribeDeviceEvents: vi.fn((listener: (event: object) => void) => {
    listener({ type: "status", status: "live" });
    return unsubscribe;
  }),
}));

import { requestHasPermission } from "@/lib/access";
import { getDeviceSnapshots } from "@/lib/device-snapshot";
import { GET as getEvents } from "../events/route";
import { GET as getSnapshot } from "../snapshot/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("device live snapshot", () => {
  it("returns a deduplicated targeted snapshot", async () => {
    const request = new NextRequest(
      "https://vellum.example.com/api/v1/admin/devices/snapshot" +
        "?mac=AA:BB:CC:DD:EE:FF&mac=AA:BB:CC:DD:EE:FF"
    );
    const response = await getSnapshot(request);

    expect(response.status).toBe(200);
    expect(getDeviceSnapshots).toHaveBeenCalledWith(["AA:BB:CC:DD:EE:FF"]);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects malformed MAC addresses before querying", async () => {
    const request = new NextRequest(
      "https://vellum.example.com/api/v1/admin/devices/snapshot?mac=not-a-mac"
    );
    const response = await getSnapshot(request);

    expect(response.status).toBe(400);
    expect(getDeviceSnapshots).not.toHaveBeenCalled();
  });
});

describe("device live event stream", () => {
  it("requires device read permission", async () => {
    vi.mocked(requestHasPermission).mockResolvedValueOnce(false);
    const response = await getEvents(
      new Request("https://vellum.example.com/api/v1/admin/devices/events")
    );

    expect(response.status).toBe(403);
  });

  it("starts with an authoritative sync and exposes listener health", async () => {
    const controller = new AbortController();
    const response = await getEvents(
      new Request("https://vellum.example.com/api/v1/admin/devices/events", {
        signal: controller.signal,
      })
    );
    const reader = response.body!.getReader();
    const first = await reader.read();
    const second = await reader.read();
    const decoder = new TextDecoder();
    const payload = decoder.decode(first.value) + decoder.decode(second.value);

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(payload).toContain('{"type":"sync"}');
    expect(payload).toContain('{"type":"status","status":"live"}');

    controller.abort();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
