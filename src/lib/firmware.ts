/**
 * Firmware manifest fetcher and OTA version resolver.
 *
 * Fetches firmware-manifest.json from GitHub Releases,
 * caches in DB, and resolves the correct binary URL
 * for a device based on its channel, model, and version.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { firmwareChannels } from "@/db/schema";
import { log } from "./logger";

const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

export interface FirmwareBinary {
  url: string;
  sha256: string;
  signature: string;
  size: number;
}

export interface FirmwareManifest {
  version: string;
  channel: string;
  date: string;
  binaries: Record<string, FirmwareBinary>;
}

/**
 * Fetch and cache the manifest for a firmware channel.
 */
async function fetchManifest(channelId: string): Promise<FirmwareManifest | null> {
  const [channel] = await db
    .select()
    .from(firmwareChannels)
    .where(eq(firmwareChannels.id, channelId))
    .limit(1);

  if (!channel) return null;

  // Return cache if fresh
  if (channel.manifestCache && channel.cachedAt) {
    const age = Date.now() - new Date(channel.cachedAt).getTime();
    if (age < CACHE_TTL_MS) {
      return channel.manifestCache as FirmwareManifest;
    }
  }

  // Fetch from GitHub
  try {
    const res = await fetch(channel.manifestUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn("Manifest fetch failed", { channel: channel.name, status: res.status });
      return channel.manifestCache as FirmwareManifest | null;
    }

    const manifest = (await res.json()) as FirmwareManifest;

    // Cache in DB
    await db
      .update(firmwareChannels)
      .set({ manifestCache: manifest, cachedAt: new Date() })
      .where(eq(firmwareChannels.id, channelId));

    return manifest;
  } catch (err) {
    log.warn("Manifest fetch error", { channel: channel.name, error: String(err) });
    return channel.manifestCache as FirmwareManifest | null;
  }
}

/**
 * Compare semver strings. Returns true if a > b.
 */
function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(/[-.]/).map((s) => parseInt(s) || 0);
  const pb = b.replace(/^v/, "").split(/[-.]/).map((s) => parseInt(s) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
}

export interface OtaInfo {
  otaUrl: string | null;
  otaVersion: string | null;
  otaSha256: string | null;
  otaSignature: string | null;
}

/**
 * Resolve OTA update info for a device.
 *
 * @param deviceFirmwareVer - Current firmware version on device
 * @param displayModel - Device display model (e.g. "e1002")
 * @param channelId - Firmware channel ID (nullable → default stable)
 * @param pinVersion - Pinned version (nullable → use channel latest)
 */
export async function resolveOta(
  deviceFirmwareVer: string,
  displayModel: string,
  channelId: string | null,
  pinVersion: string | null
): Promise<OtaInfo> {
  const none: OtaInfo = { otaUrl: null, otaVersion: null, otaSha256: null, otaSignature: null };

  // Get the default stable channel if none assigned
  if (!channelId) {
    const [stable] = await db
      .select()
      .from(firmwareChannels)
      .where(eq(firmwareChannels.name, "stable"))
      .limit(1);
    if (!stable) return none;
    channelId = stable.id;
  }

  const manifest = await fetchManifest(channelId);
  if (!manifest) return none;

  // If pinned, check if pin version differs from current
  const targetVersion = pinVersion ?? manifest.version;
  if (!targetVersion) return none;

  // Check if update needed
  if (pinVersion) {
    // Pinned: update if versions differ (allows downgrade)
    if (pinVersion === deviceFirmwareVer) return none;
  } else {
    // Channel: update only if manifest is newer
    if (!isNewer(targetVersion, deviceFirmwareVer)) return none;
  }

  // Find binary for this display model
  const binary = manifest.binaries[displayModel];
  if (!binary) {
    log.warn("No binary for model in manifest", { model: displayModel, version: targetVersion });
    return none;
  }

  return {
    otaUrl: binary.url,
    otaVersion: targetVersion,
    otaSha256: binary.sha256,
    otaSignature: binary.signature,
  };
}
