import { NextRequest } from "next/server";
import { getManifestsByChannel, type FirmwareChannel } from "@/lib/firmware";

/**
 * ESP Web Tools compatible manifest for browser-based flashing.
 *
 * The binary URL points to our own proxy endpoint to avoid CORS issues
 * with GitHub Release assets. ESP32-S3 OTA binary is flashed at offset 0x0
 * (combined bootloader+partition+app image from idf.py build).
 *
 * Query params: model=e1002&channel=stable&version=1.0.0 (optional)
 */
export async function GET(request: NextRequest) {
  const model = request.nextUrl.searchParams.get("model") ?? "e1002";
  const channel = (request.nextUrl.searchParams.get("channel") ?? "stable") as FirmwareChannel;
  const version = request.nextUrl.searchParams.get("version");

  const manifests = await getManifestsByChannel(channel);

  let target = version
    ? manifests.find((m) => m.version === version)
    : manifests[0];

  if (!target) {
    return Response.json({ error: "No firmware available" }, { status: 404 });
  }

  const binary = target.binaries[model];
  if (!binary) {
    return Response.json({ error: `No binary for model ${model} in v${target.version}` }, { status: 404 });
  }

  // Proxy URL — avoids CORS issues with GitHub Release assets
  const proxyPath = `/api/v1/admin/flash-binary?model=${model}&channel=${channel}&version=${target.version}`;

  const espManifest = {
    name: `Vellum ${model.toUpperCase()}`,
    version: target.version,
    new_install_prompt_erase: true,
    builds: [
      {
        chipFamily: "ESP32-S3",
        parts: [{ path: proxyPath, offset: 0 }],
      },
    ],
  };

  return Response.json(espManifest);
}
