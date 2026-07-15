// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { getManifestsByChannel, type FirmwareChannel } from "@/lib/firmware";

/**
 * ESP Web Tools compatible manifest for browser-based flashing.
 *
 * The binary URL points to our own proxy endpoint (avoids CORS with GitHub
 * Release assets); it serves the merged FACTORY image, flashed at offset 0 for
 * every target — esptool merge-bin bakes in the per-chip bootloader offset
 * (e.g. 0x2000 on ESP32-P4). `chipFamily` MUST match the connected board or
 * esp-web-tools refuses it: "Your <chip> board is not supported".
 *
 * Query params: model=e1002&channel=stable&version=1.0.0 (optional)
 */
const CHIP_FAMILY: Record<string, "ESP32-S3" | "ESP32-P4"> = {
  e1001: "ESP32-S3",
  e1002: "ESP32-S3",
  e1003: "ESP32-S3",
  d1001: "ESP32-P4", // ESP32-P4 + JD9365 MIPI-DSI LCD
};

export async function GET(request: NextRequest) {
  const model = request.nextUrl.searchParams.get("model") ?? "e1002";
  const channel = (request.nextUrl.searchParams.get("channel") ?? "stable") as FirmwareChannel;
  const version = request.nextUrl.searchParams.get("version");

  const manifests = await getManifestsByChannel(channel);

  const target = version
    ? manifests.find((m) => m.version === version)
    : manifests[0];

  if (!target) {
    return Response.json({ error: "No firmware available" }, { status: 404 });
  }

  const binary = target.binaries[model];
  if (!binary) {
    return Response.json({ error: `No binary for model ${model} in v${target.version}` }, { status: 404 });
  }

  const chipFamily = CHIP_FAMILY[model];
  if (!chipFamily) {
    // Fail loud instead of serving a wrong chipFamily — esp-web-tools would
    // otherwise reject the board with a confusing "not supported" (the D1001 bug).
    return Response.json({ error: `Unknown chip family for model ${model}` }, { status: 400 });
  }

  // Proxy URL — avoids CORS issues with GitHub Release assets
  const proxyPath = `/api/v1/admin/flash-binary?model=${model}&channel=${channel}&version=${target.version}`;

  const espManifest = {
    name: `Vellum ${model.toUpperCase()}`,
    version: target.version,
    new_install_prompt_erase: true,
    builds: [
      {
        chipFamily,
        parts: [{ path: proxyPath, offset: 0 }],
      },
    ],
  };

  return Response.json(espManifest);
}
