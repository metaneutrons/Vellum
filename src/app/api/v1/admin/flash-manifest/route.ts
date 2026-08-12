// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { getManifestsByChannel, type FirmwareChannel } from "@/lib/firmware";
import { requestHasPermission } from "@/lib/access";

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
/**
 * chipFamily by model prefix — `e*` (e1001/e1002/e1003) run ESP32-S3, `d*`
 * (d1001) is ESP32-P4. Prefix-based so new revisions (e1004, d1002) work with no
 * server change; an unrecognised prefix returns undefined → 400, rather than
 * silently serving a wrong chip.
 */
function getChipFamily(model: string): "ESP32-S3" | "ESP32-P4" | undefined {
  const m = model.toLowerCase();
  if (m.startsWith("e")) return "ESP32-S3";
  if (m.startsWith("d")) return "ESP32-P4";
  return undefined;
}

export async function GET(request: NextRequest) {
  if (!(await requestHasPermission(request, "firmware.flash"))) return Response.json({ error: "Forbidden" }, { status: 403 });
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

  const chipFamily = getChipFamily(model);
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
    // ESP Web Tools defaults this to true and would offer its own Wi-Fi step
    // after flashing. Vellum provisions over the same cable with its own Improv
    // frames, which additionally carry the server URL, the device token, an NTP
    // override and the wall clock — none of which the generic dialog can supply.
    // Leaving it enabled lets an operator end up with a device that has Wi-Fi
    // but no server, so the step is disabled and "Provision over USB" stays the
    // single path.
    improv: false,
    builds: [
      {
        chipFamily,
        parts: [{ path: proxyPath, offset: 0 }],
      },
    ],
  };

  return Response.json(espManifest);
}
