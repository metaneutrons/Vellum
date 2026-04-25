import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { firmwareChannels } from "@/db/schema";

/**
 * Generates an ESP Web Tools compatible manifest for browser-based flashing.
 * Query params: model=e1002&channel=stable
 */
export async function GET(request: NextRequest) {
  const model = request.nextUrl.searchParams.get("model") ?? "e1002";
  const channelName = request.nextUrl.searchParams.get("channel") ?? "stable";

  const [channel] = await db
    .select()
    .from(firmwareChannels)
    .where(eq(firmwareChannels.name, channelName))
    .limit(1);

  if (!channel?.manifestCache) {
    return Response.json({ error: "No manifest cached for channel" }, { status: 404 });
  }

  const manifest = channel.manifestCache as {
    version?: string;
    binaries?: Record<string, { url: string; size: number }>;
  };

  const binary = manifest.binaries?.[model];
  if (!binary) {
    return Response.json({ error: "No binary for model " + model }, { status: 404 });
  }

  // ESP Web Tools manifest format
  const espManifest = {
    name: "Vellum " + model.toUpperCase(),
    version: manifest.version ?? "unknown",
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
