// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { eq } from "drizzle-orm";
import { db, withDbRead } from "@/db";
import { devices } from "@/db/schema";
import { getAllManifests } from "@/lib/firmware";
import { verifyOtaDownloadGrant, type OtaDownloadGrant } from "@/lib/firmware-download";
import { safeFetch } from "@/lib/safe-fetch";
import { apiLimiter, applyRateLimit, getClientIp } from "@/lib/rate-limit";
import { log } from "@/lib/logger";
import { firmwareBinaryCache } from "@/lib/firmware-binary-cache";

/**
 * Device-facing OTA delivery endpoint.
 *
 * Displays need network access only to their configured Vellum origin. The
 * server fetches the immutable signed image from GitHub, while the device still
 * verifies model identity, SHA-256 and Ed25519 before making it bootable.
 */
export async function GET(request: Request) {
  const rateLimited = applyRateLimit(apiLimiter, getClientIp(request));
  if (rateLimited) return rateLimited;

  const url = new URL(request.url);
  const grant: OtaDownloadGrant = {
    mac: url.searchParams.get("mac") ?? "",
    tag: url.searchParams.get("tag") ?? "",
    model: url.searchParams.get("model") ?? "",
    expires: Number(url.searchParams.get("expires")),
  };
  const signature = url.searchParams.get("signature") ?? "";
  if (!grant.mac || !grant.tag || !grant.model || !Number.isSafeInteger(grant.expires)) {
    return Response.json({ error: "Invalid firmware download grant" }, { status: 400 });
  }

  const [device] = await withDbRead(
    () => db.select({ status: devices.status, token: devices.token })
      .from(devices).where(eq(devices.mac, grant.mac)).limit(1),
    "authorize-firmware-download",
  );
  if (!device?.token || device.status !== "approved" ||
      !verifyOtaDownloadGrant(grant, signature, device.token)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const manifest = (await getAllManifests()).find((candidate) => candidate.tag === grant.tag);
  const binary = manifest?.binaries[grant.model];
  if (!manifest || !binary) {
    return Response.json({ error: "Firmware is no longer available" }, { status: 404 });
  }

  let payload: ArrayBuffer;
  try {
    const cacheKey = `${grant.tag}:${grant.model}:${binary.otaSha256}:${binary.otaSize}`;
    const bytes = await firmwareBinaryCache.get(cacheKey, binary.otaSize, async () => {
      const upstream = await safeFetch(binary.otaUrl, {
        headers: { "User-Agent": "Vellum-Server" },
        timeoutMs: 120_000,
      });
      if (!upstream.ok) throw new Error(`upstream HTTP ${upstream.status}`);
      return upstream.arrayBuffer();
    });
    payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } catch (error) {
    log.warn("Firmware upstream fetch failed", {
      tag: grant.tag,
      model: grant.model,
      error: String(error),
    });
    return Response.json({ error: "Firmware upstream unavailable" }, { status: 502 });
  }
  return new Response(payload, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(binary.otaSize),
      "Content-Disposition": `attachment; filename="vellum-${grant.model}-v${manifest.version}-ota.bin"`,
      // The signed URL is deliberately short-lived and device-scoped. Do not let
      // shared reverse proxies retain it or serve it across authorization state.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
