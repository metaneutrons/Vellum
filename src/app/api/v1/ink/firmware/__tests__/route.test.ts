// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOtaDownloadUrl } from "@/lib/firmware-download";
import { firmwareBinaryCache } from "@/lib/firmware-binary-cache";

const mocks = vi.hoisted(() => ({
  device: { status: "approved", token: "approved-device-token" } as { status: string; token: string | null } | undefined,
  evidence: undefined as Record<string, unknown> | undefined,
  safeFetch: vi.fn(),
  manifests: [{
    version: "1.4.3",
    channel: "stable",
    date: "2026-08-15T00:00:00Z",
    tag: "firmware-v1.4.3",
    binaries: {
      e1003: {
        url: "https://example.invalid/factory.bin",
        size: 4,
        otaUrl: "https://github.com/metaneutrons/Vellum/releases/download/firmware-v1.4.3/e1003-ota.bin",
        otaSha256: "00".repeat(32),
        otaSignature: "signature",
        otaSize: 4,
      },
    },
  }],
}));

vi.mock("@/db", () => ({
  db: {
    select: vi.fn((selection: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          "securityProfile" in selection
            ? {
                orderBy: vi.fn(() => ({
                  limit: vi.fn(() => (mocks.evidence ? [mocks.evidence] : [])),
                })),
              }
            : { limit: vi.fn(() => (mocks.device ? [mocks.device] : [])) }
        ),
      })),
    })),
  },
  withDbRead: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock("@/lib/firmware", () => ({ getAllManifests: vi.fn(async () => mocks.manifests) }));
vi.mock("@/lib/safe-fetch", () => ({ safeFetch: mocks.safeFetch }));
vi.mock("@/lib/rate-limit", () => ({
  apiLimiter: {},
  applyRateLimit: vi.fn(() => null),
  getClientIp: vi.fn(() => "test"),
}));

import { GET } from "../route";

function signedRequest(nowSeconds = Math.floor(Date.now() / 1000)): Request {
  const url = createOtaDownloadUrl("https://vellum.example.com", {
    mac: "AA:BB:CC:DD:EE:FF",
    tag: "firmware-v1.4.3",
    model: "e1003",
  }, "approved-device-token", nowSeconds);
  return new Request(url);
}

beforeEach(() => {
  firmwareBinaryCache.clear();
  mocks.device = { status: "approved", token: "approved-device-token" };
  mocks.evidence = undefined;
  mocks.safeFetch.mockReset();
  mocks.safeFetch.mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
});

describe("GET /api/v1/ink/firmware", () => {
  it("serves the assigned OTA image through a valid device-scoped grant", async () => {
    const response = await GET(signedRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(mocks.safeFetch).toHaveBeenCalledWith(expect.stringContaining("e1003-ota.bin"), expect.any(Object));
  });

  it("rejects a tampered release before contacting the upstream", async () => {
    const url = new URL(signedRequest().url);
    url.searchParams.set("tag", "firmware-v9.9.9");
    const response = await GET(new Request(url));
    expect(response.status).toBe(401);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it("rejects a grant after the device is revoked", async () => {
    mocks.device = { status: "rejected", token: "approved-device-token" };
    const response = await GET(signedRequest());
    expect(response.status).toBe(401);
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it("refuses a truncated upstream image", async () => {
    mocks.safeFetch.mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200 }));
    const response = await GET(signedRequest());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Firmware upstream unavailable" });
  });
});
