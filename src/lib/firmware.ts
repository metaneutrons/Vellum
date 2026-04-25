/**
 * Firmware distribution via GitHub Releases API.
 *
 * SSOT: GitHub Releases. No manual channel URLs needed.
 * - stable = non-prerelease releases with firmware-manifest.json
 * - beta = prerelease releases with firmware-manifest.json
 *
 * Caching strategy:
 * - Individual manifests are cached permanently (releases are immutable)
 * - Release list uses ETag conditional requests (no rate limit cost)
 * - Only new releases trigger manifest downloads
 */

import { log } from "./logger";

const GITHUB_REPO = process.env.GITHUB_REPO ?? "metaneutrons/Vellum";
const POLL_INTERVAL_MS = 15 * 60_000; // check for new releases every 15 min

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

/* ── Cache ────────────────────────────────────────────────────── */

/** Permanent cache: tag → manifest (immutable, never expires) */
const manifestCache = new Map<string, FirmwareManifest>();

/** ETag from last releases list fetch */
let releasesEtag = "";

/** Last time we polled the releases list */
let lastPollAt = 0;

/** Sorted result cache (rebuilt when new releases are found) */
let sortedManifests: FirmwareManifest[] = [];

function githubHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Vellum-Server",
  };
  if (process.env.GITHUB_TOKEN) {
    h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return h;
}

/**
 * Fetch all firmware manifests from GitHub Releases.
 * Uses ETag conditional requests — 304 Not Modified costs no rate limit.
 * Individual manifests are cached permanently (immutable).
 */
export async function getAllManifests(): Promise<FirmwareManifest[]> {
  if (Date.now() - lastPollAt < POLL_INTERVAL_MS && sortedManifests.length > 0) {
    return sortedManifests;
  }

  try {
    const headers = githubHeaders();
    if (releasesEtag) {
      headers["If-None-Match"] = releasesEtag;
    }

    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=50`,
      { headers, signal: AbortSignal.timeout(15_000) }
    );

    lastPollAt = Date.now();

    // 304 Not Modified — no new releases, return cached
    if (res.status === 304) {
      return sortedManifests;
    }

    if (!res.ok) {
      log.warn("GitHub Releases API failed", { status: res.status });
      return sortedManifests;
    }

    // Store ETag for next conditional request
    const etag = res.headers.get("etag");
    if (etag) releasesEtag = etag;

    const releases = (await res.json()) as GitHubRelease[];
    let newCount = 0;

    for (const release of releases) {
      const manifestAsset = release.assets.find(
        (a) => a.name === "firmware-manifest.json"
      );
      if (!manifestAsset) continue;

      // Already cached permanently — skip
      if (manifestCache.has(release.tag_name)) continue;

      // Fetch and cache the manifest (will never change)
      try {
        const mRes = await fetch(manifestAsset.browser_download_url, {
          headers: { "User-Agent": "Vellum-Server" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!mRes.ok) continue;

        const manifest = (await mRes.json()) as FirmwareManifest;
        manifest.tag = release.tag_name;
        manifest.channel = release.prerelease ? "beta" : "stable";
        manifestCache.set(release.tag_name, manifest);
        newCount++;
      } catch {
        log.warn("Failed to fetch manifest", { tag: release.tag_name });
      }
    }

    // Rebuild sorted list
    sortedManifests = [...manifestCache.values()].sort(
      (a, b) => compareSemver(b.version, a.version)
    );

    if (newCount > 0) {
      log.info("Firmware manifests updated", { new: newCount, total: sortedManifests.length });
    }

    return sortedManifests;
  } catch (err) {
    log.warn("GitHub Releases fetch error", { error: String(err) });
    return sortedManifests;
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
    target = manifests.find((m) => m.version === pinVersion);
    if (!target || pinVersion === currentVersion) return NO_UPDATE;
  } else {
    target = manifests[0];
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

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[-.]/).map((s) => parseInt(s) || 0);
  const pb = b.replace(/^v/, "").split(/[-.]/).map((s) => parseInt(s) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
