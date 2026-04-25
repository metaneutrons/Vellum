import { NextRequest } from "next/server";
import { getManifestsByChannel, type FirmwareChannel } from "@/lib/firmware";

/**
 * Generates an ESP Web Tools compatible manifest for browser-based flashing.
 * Query params: model=e1002&channel=stable
 */
export async function GET(request: NextRequest) {
  const model = request.nextUrl.searchParams.get("model") ?? "e1002";
  const channel = (request.nextUrl.searchParams.get("channel") ?? "stable") as FirmwareChannel;

  const manifests = await getManifestsByChannel(channel);
  const latest = manifests[0];

  if (!latest) {
    return Response.json({ error: "No firmware available" }, { status: 404 });
  }

  const binary = latest.binaries[model];
  if (!binary) {
    return Response.json({ error: "No binary for model " + model }, { status: 404 });
  }

  // ESP Web Tools manifest format
  const espManifest = {
    name: "Vellum " + model.toUpperCase(),
    version: latest.version,
    new_install_prompt_erase: true,
    builds: [
      {
        chipFamily: "ESP32-S3",
        parts: [{ path: binary.url, offset: 0 }],
      },
    ],
  };

  return Response.json(espManifest);
}
