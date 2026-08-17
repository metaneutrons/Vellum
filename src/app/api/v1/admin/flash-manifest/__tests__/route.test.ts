// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const manifests = [
  {
    version: "1.4.10",
    channel: "stable",
    date: "2026-08-17T00:00:00Z",
    tag: "firmware-v1.4.10",
    binaries: {
      e1002: {
        url: "https://example.invalid/e1002-factory.bin",
        size: 1,
        otaUrl: "https://example.invalid/e1002-ota.bin",
        otaSha256: "00".repeat(32),
        otaSignature: "signature",
        otaSize: 1,
      },
      d1001: {
        url: "https://example.invalid/d1001-factory.bin",
        size: 1,
        otaUrl: "https://example.invalid/d1001-ota.bin",
        otaSha256: "00".repeat(32),
        otaSignature: "signature",
        otaSize: 1,
      },
    },
  },
];

vi.mock("@/lib/access", () => ({ requestHasPermission: vi.fn(async () => true) }));
vi.mock("@/lib/firmware", () => ({
  getManifestsByChannel: vi.fn(async () => manifests),
}));

import { GET } from "../route";

function request(model: string): NextRequest {
  return new NextRequest(`https://vellum.example.com/api/v1/admin/flash-manifest?model=${model}`);
}

describe("GET /api/v1/admin/flash-manifest", () => {
  it("suppresses ESP Web Tools' generic Wi-Fi step after flashing", async () => {
    const response = await GET(request("e1002"));
    const manifest = await response.json();

    expect(response.status).toBe(200);
    expect(manifest.improv).toBe(false);
    expect(manifest.new_install_improv_wait_time).toBe(0);
  });

  it.each([
    ["e1002", "ESP32-S3"],
    ["d1001", "ESP32-P4"],
  ])("serves %s only to its chip family", async (model, chipFamily) => {
    const response = await GET(request(model));
    const manifest = await response.json();

    expect(manifest.builds).toEqual([expect.objectContaining({ chipFamily })]);
  });
});
