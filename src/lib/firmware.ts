/**
 * Firmware distribution via GitHub Releases API.
 *
 * SSOT: GitHub Releases. No manual channel URLs needed.
 * - stable = non-prerelease releases with firmware-manifest.json
 * - beta = prerelease releases with firmware-manifest.json
 *
 * Manifests are cached in memory with TTL.
 */

import { log } from "./logger";

const GITHUB_REPO = process.env.GITHUB_REPO ?? "metaneutrons/Vellum";
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

export type FirmwareChannel = "stable" | "beta";

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
  tag: string;
  binaries: Record<string, FirmwareBinary>;
}

interface GitHubRelease {
  tag_name: string;
  prerelease: boolean;
  published_at: string;
  assets: { name: string; browser_download_url: string }[];
}

/* ── In-memory cache ──────────────────────────────────────────── */

let cachedManifests: FirmwareManifest[] = [];
let cachedAt = 0;

/**
 * Fetch all firmware manifests from GitHub Releases.
 * Returns cached result if fresh.
 */
export async function getAllManifests(): Promise<FirmwareManifest[]> {
  if (Date.now() - cachedAt < CACHE_TTL_MS && cachedManifests.length > 0) {
    return cachedManifests;
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=50`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Vellum-Server",
          ...(process.env.GITHUB_TOKEN
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (!res.ok) {
      log.warn("GitHub Releases API failed", { status: res.status });
      return cachedManifests;
    }

    const releases = (await res.json()) as GitHubRelease[];
    const manifests: FirmwareManifest[] = [];

    for (const release of releases) {
      const manifestAsset = release.assets.find(
        (a) => a.name === "firmware-manifest.json"
      );
      if (!manifestAsset) continue;

      // Check if we already have this manifest cached (by tag)
      const existing = cachedManifests.find((m) => m.tag === release.tag_name);
      if (existing) {
        manifests.push(existing);
        continue;
      }

      // Fetch the manifest
      try {
        const mRes = await fetch(manifestAsset.browser_download_url, {
          headers: { "User-Agent": "Vellum-Server" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!mRes.ok) continue;

        const manifest = (await mRes.json()) as FirmwareManifest;
        manifest.tag = release.tag_name;
        manifest.channel = release.prerelease ? "beta" : "stable";
        manifests.push(manifest);
      } catch {
        log.warn("Failed to fetch manifest", { tag: release.tag_name });
      }
    }

    // Sort newest first
    manifests.sort((a, b) => compareSemver(b.version, a.version));

    cachedManifests = manifests;
    cachedAt = Date.now();
    log.info("Firmware manifests refreshed", { count: manifests.length });

    return manifests;
  } catch (err) {
    log.warn("GitHub Releases fetch error", { error: String(err) });
    return cachedManifests;
  }
}

/**
 * Get manifests filtered by channel.
 */
export async function getManifestsByChannel(
  channel: FirmwareChannel
): Promise<FirmwareManifest[]> {
  const all = await getAllManifests();
  return all.filter((m) => m.channel === channel);
}

/**
 * Get all available versions (for admin dropdown).
 */
export async function getAvailableVersions(): Promise<
  { version: string; channel: FirmwareChannel; date: string }[]
> {
  const all = await getAllManifests();
  return all.map((m) => ({
    version: m.version,
    channel: m.channel as FirmwareChannel,
    date: m.date,
  }));
}

/* ── OTA Resolver ─────────────────────────────────────────────── */

export interface OtaInfo {
  otaUrl: string | null;
  otaVersion: string | null;
  otaSha256: string | null;
  otaSignature: string | null;
}

const NO_UPDATE: OtaInfo = {
  otaUrl: null,
  otaVersion: null,
  otaSha256: null,
  otaSignature: null,
};

/**
 * Resolve OTA update for a device.
 *
 * @param currentVersion - Firmware version currently on device
 * @param displayModel - Device model (e.g. "e1001")
 * @param channel - "stable" or "beta"
 * @param pinVersion - Exact version to target (allows downgrade), or null for latest
 */
export async function resolveOta(
  currentVersion: string,
  displayModel: string,
  channel: FirmwareChannel,
  pinVersion: string | null
): Promise<OtaInfo> {
  const manifests = await getManifestsByChannel(channel);
  if (manifests.length === 0) return NO_UPDATE;

  let target: FirmwareManifest | undefined;

  if (pinVersion) {
    // Pinned: find exact version (allows downgrade)
    target = manifests.find((m) => m.version === pinVersion);
    if (!target || pinVersion === currentVersion) return NO_UPDATE;
  } else {
    // Latest in channel
    target = manifests[0]; // already sorted newest first
    if (!target || compareSemver(target.version, currentVersion) <= 0) {
      return NO_UPDATE;
    }
  }

  const binary = target.binaries[displayModel];
  if (!binary) {
    log.warn("No binary for model", { model: displayModel, version: target.version });
    return NO_UPDATE;
  }

  return {
    otaUrl: binary.url,
    otaVersion: target.version,
    otaSha256: binary.sha256,
    otaSignature: binary.signature,
  };
}

/* ── Semver comparison ────────────────────────────────────────── */

/**
 * Compare semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[-.]/).map((s) => parseInt(s) || 0);
  const pb = b.replace(/^v/, "").split(/[-.]/).map((s) => parseInt(s) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
