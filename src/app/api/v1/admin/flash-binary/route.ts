// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { getManifestsByChannel, type FirmwareChannel } from "@/lib/firmware";

/**
 * Proxy endpoint for firmware binaries.
 *
 * Fetches the binary from GitHub Releases and streams it to the browser,
 * bypassing CORS restrictions. Used by ESP Web Tools during flashing.
 *
 * Query params: model=e1002&channel=stable&version=1.0.0
 */
export async function GET(request: NextRequest) {
  const model = request.nextUrl.searchParams.get("model");
  const channel = request.nextUrl.searchParams.get("channel") as FirmwareChannel | null;
  const version = request.nextUrl.searchParams.get("version");

  if (!model || !channel || !version) {
    return Response.json({ error: "Missing model, channel, or version" }, { status: 400 });
  }

  const manifests = await getManifestsByChannel(channel);
  const target = manifests.find((m) => m.version === version);

  if (!target) {
    return Response.json({ error: `Version ${version} not found` }, { status: 404 });
  }

  const binary = target.binaries[model];
  if (!binary) {
    return Response.json({ error: `No binary for model ${model}` }, { status: 404 });
  }

  // Fetch from GitHub
  const res = await fetch(binary.url, {
    headers: { "User-Agent": "Vellum-Server" },
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok || !res.body) {
    return Response.json(
      { error: `Failed to fetch binary: ${res.status}` },
      { status: 502 }
    );
  }

  return new Response(res.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": binary.size.toString(),
      "Content-Disposition": `attachment; filename="vellum-${model}-v${version}.bin"`,
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
}
