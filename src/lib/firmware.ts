// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Firmware distribution via GitHub Releases API.
 *
 * SSOT: GitHub Releases. No manual channel URLs needed.
 * - stable = non-prerelease releases with firmware-manifest.json
 * - beta = prerelease releases with firmware-manifest.json
 *
 * Caching strategy:
 * - Individual manifests are cached while their immutable release exists
 * - Release list uses ETag conditional requests (no rate limit cost)
 * - Only new releases trigger manifest downloads
 */

import { log } from "./logger";
import { getSetting } from "./settings";
import { deviceFailedTarget, isDeviceInRollout } from "./rollout";

const GITHUB_REPO = process.env.GITHUB_REPO ?? "metaneutrons/Vellum";

/** Releases fetched per API page. */
const RELEASES_PER_PAGE = 50;
/**
 * Hard cap on release pages walked in one poll (safety bound: 2000 releases).
 * Server releases (tag `v*`, no firmware manifest) and betas now share the same
 * /releases list as stable firmware releases, so the newest stable firmware can
 * sit many manifest-less releases deep. The page-1 ETag fast-path and permanent
 * per-release manifest cache keep the steady-state cost near zero; this bound
 * only matters on a cold cache and gives years of headroom before the walk could
 * fail to reach the newest firmware (a fail-safe NO_UPDATE, never a bad image).
 */
const MAX_RELEASE_PAGES = 40;

export type FirmwareChannel = "stable" | "beta";

export interface FirmwareBinary {
  /** Merged full-flash image (bootloader+partition-table+ota_data+app) written
   *  at offset 0x0 — used by the browser web-flasher (ESP Web Tools). */
  url: string;
  size: number;
  /** App-only image for over-the-air updates (esp_https_ota on the device). */
  otaUrl: string;
  /** Hex SHA-256 of the app image's *appended* digest — this is exactly what
   *  esp_partition_get_sha256() returns on-device (NOT sha256sum of the file). */
  otaSha256: string;
  /** Base64 Ed25519 signature over the raw 32-byte appended digest. */
  otaSignature: string;
  otaSize: number;
  /** Id of the key that produced otaSignature. A non-authoritative fast-path
   *  hint for the device's trust store; older manifests omit it. */
  otaKeyId?: string;
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

/** Manifest cache: tag → manifest (immutable; evicted if its release is removed) */
const manifestCache = new Map<string, FirmwareManifest>();

/** ETag from last releases list fetch */
let releasesEtag = "";

/** Last time we polled the releases list */
let lastPollAt = 0;

async function getPollIntervalMs(): Promise<number> {
  const s = await getSetting("firmware.pollIntervalS");
  return Math.max(60_000, s * 1000);
}

/** Sorted result cache (rebuilt when new releases are found) */
let sortedManifests: FirmwareManifest[] = [];

/** Drop manifests whose GitHub releases disappeared from a complete discovery
 * snapshot. This matters for deliberate release retirement: the process-local
 * cache is long-lived, but a deleted release must stop being pinnable without
 * requiring a server restart. */
export function reconcileFirmwareManifestCache(
  cache: Map<string, FirmwareManifest>,
  visibleTags: ReadonlySet<string>
): number {
  let removed = 0;
  for (const tag of cache.keys()) {
    if (!visibleTags.has(tag)) {
      cache.delete(tag);
      removed++;
    }
  }
  return removed;
}

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
  const pollInterval = await getPollIntervalMs();
  if (Date.now() - lastPollAt < pollInterval && sortedManifests.length > 0) {
    return sortedManifests;
  }

  try {
    let newCount = 0;
    let removedCount = 0;
    const visibleManifestTags = new Set<string>();
    let snapshotComplete = false;
    // Releases are returned newest-first. Walk the complete collection because
    // operators can pin any retained firmware, including an intentional signed
    // downgrade. The first-page ETag keeps unchanged steady-state polls cheap.

    for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
      const headers = githubHeaders();
      // The ETag conditional request is only meaningful on the FIRST page (it
      // identifies the newest-releases page). Keeping it there preserves the
      // common 304 fast-path — an unchanged release list costs no rate limit.
      // Deeper pages are only fetched when page 1 has already changed, so they
      // would never 304 anyway.
      if (page === 1 && releasesEtag) {
        headers["If-None-Match"] = releasesEtag;
      }

      const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`,
        { headers, signal: AbortSignal.timeout(15_000) }
      );

      if (page === 1) {
        lastPollAt = Date.now();

        // 304 Not Modified — newest page unchanged, nothing new to discover.
        if (res.status === 304) {
          return sortedManifests;
        }
      }

      if (!res.ok) {
        // Any HTTP error: fall back to the last-good cache. On page 1 this is a
        // hard failure; on later pages we keep whatever earlier pages yielded.
        if (page === 1) {
          log.warn("GitHub Releases API failed", { status: res.status });
          return sortedManifests;
        }
        log.warn("GitHub Releases pagination stopped early", {
          status: res.status,
          page,
        });
        break;
      }

      // Store ETag from the first page only, for the next conditional request.
      if (page === 1) {
        const etag = res.headers.get("etag");
        if (etag) releasesEtag = etag;
      }

      const releases = (await res.json()) as GitHubRelease[];
      if (releases.length === 0) {
        snapshotComplete = true;
        break; // walked past the last page
      }

      for (const release of releases) {
        const manifestAsset = release.assets.find(
          (a) => a.name === "firmware-manifest.json"
        );
        if (!manifestAsset) continue;
        visibleManifestTags.add(release.tag_name);

        // Already cached permanently — skip the download (releases are immutable).
        if (manifestCache.has(release.tag_name)) continue;

        // Fetch and cache the manifest (will never change).
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

      // A short page is a complete snapshot. The hard page cap above remains a
      // safety bound; reaching it deliberately skips destructive reconciliation.
      if (releases.length < RELEASES_PER_PAGE) {
        snapshotComplete = true;
        break;
      }
    }

    /* Only reconcile after reaching the end of the collection. A partial
     * snapshot caused by a later-page API failure or the safety cap must not
     * evict still-valid last-good entries. */
    if (snapshotComplete) {
      removedCount = reconcileFirmwareManifestCache(manifestCache, visibleManifestTags);
    }

    // Rebuild sorted list
    sortedManifests = [...manifestCache.values()].sort(
      (a, b) => compareSemver(b.version, a.version)
    );

    if (newCount > 0 || removedCount > 0) {
      log.info("Firmware manifests updated", {
        new: newCount,
        removed: removedCount,
        total: sortedManifests.length,
      });
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
  { version: string; channel: FirmwareChannel; date: string; tag: string }[]
> {
  const all = await getAllManifests();
  return all.map((m) => ({
    version: m.version,
    channel: m.channel as FirmwareChannel,
    date: m.date,
    tag: m.tag,
  }));
}

/* ── OTA Resolver ─────────────────────────────────────────────── */

export interface OtaInfo {
  otaUrl: string | null;
  /** GitHub release identity used to scope the server-local download grant. */
  otaTag: string | null;
  otaVersion: string | null;
  otaSha256: string | null;
  otaSignature: string | null;
  /** Id of the signing key (fast-path hint for the device trust store); null
   *  when the manifest predates key-id stamping. */
  otaKeyId: string | null;
  /** True only when the server INTENTIONALLY offers an older version (an operator
   *  pin-downgrade). The device refuses a strictly-older image unless this is set,
   *  so a compromised/replayed offer can't silently roll a device back. */
  allowDowngrade: boolean;
}

const NO_UPDATE: OtaInfo = {
  otaUrl: null,
  otaTag: null,
  otaVersion: null,
  otaSha256: null,
  otaSignature: null,
  otaKeyId: null,
  allowDowngrade: false,
};

/**
 * Resolve OTA update for a device.
 *
 * `mac` gates the auto-update path through the rollout engine: a deterministic
 * canary cohort + a fleet-wide kill-switch, plus a per-device failure blocklist
 * that breaks the brick-retry loop. An explicit `pinVersion` is an operator
 * override for a single device and bypasses those gates by design.
 */
export async function resolveOta(
  currentVersion: string,
  displayModel: string,
  channel: FirmwareChannel,
  pinVersion: string | null,
  mac: string
): Promise<OtaInfo> {
  // Channel semantics: 'beta' is a SUPERSET of 'stable'. A device tracking the
  // beta channel — typically sitting at a pre-release — must still roll forward
  // onto a superseding STABLE release, so its candidate set is stable ∪ beta
  // (newest by compareSemver wins). 'stable' devices only ever see stable.
  const all = await getAllManifests();
  const manifests =
    channel === "beta" ? all : all.filter((m) => m.channel === "stable");
  if (manifests.length === 0) return NO_UPDATE;

  let target: FirmwareManifest | undefined;
  const pinned = Boolean(pinVersion);

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

  // Auto-update gates (skipped for an explicit per-device pin).
  if (!pinned) {
    // Break the brick-retry loop: never re-offer a version this device already
    // failed (it would roll back, re-report the old version, and re-download).
    if (await deviceFailedTarget(mac, target.version)) return NO_UPDATE;
    // Rollout gate: canary cohort / percentage / paused / halted kill-switch.
    // Key on the TARGET RELEASE's channel, NOT the device's subscription channel:
    // rollout rows are created per (version, release-channel), so a beta-channel
    // device rolling forward onto a STABLE build must be gated by that stable
    // rollout row — otherwise the operator's halt/canary is silently bypassed for
    // exactly the beta cohort most likely to be running risky firmware.
    if (!(await isDeviceInRollout(mac, target.version, target.channel))) return NO_UPDATE;
  }

  return {
    otaUrl: binary.otaUrl,
    otaTag: target.tag,
    otaVersion: target.version,
    otaSha256: binary.otaSha256,
    otaSignature: binary.otaSignature,
    otaKeyId: binary.otaKeyId ?? null,
    // Only a pin to a strictly-older version is a sanctioned downgrade; the auto
    // path already refuses target <= current, so it is never a downgrade.
    allowDowngrade: pinned && compareSemver(target.version, currentVersion) < 0,
  };
}

/* ── Semver comparison ────────────────────────────────────────── */

/** Compare two semver strings. Returns >0 if a>b, <0 if a<b, 0 if equal. Exported for dashboard fleet stats. */
export function compareSemver(a: string, b: string): number {
  // Strip build metadata (+sha)
  const cleanA = a.replace(/^v/, "").split("+")[0];
  const cleanB = b.replace(/^v/, "").split("+")[0];

  // Split into version and pre-release
  const [verA, preA] = cleanA.split("-", 2);
  const [verB, preB] = cleanB.split("-", 2);

  // Compare major.minor.patch
  const pa = verA.split(".").map(Number);
  const pb = verB.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }

  // No pre-release > pre-release (1.1.0 > 1.1.0-beta.3)
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  if (!preA && !preB) return 0;

  // Compare pre-release: beta.3 vs beta.5
  const partsA = (preA ?? "").split(".");
  const partsB = (preB ?? "").split(".");
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const segA = partsA[i] ?? "";
    const segB = partsB[i] ?? "";
    const numA = parseInt(segA);
    const numB = parseInt(segB);
    if (!isNaN(numA) && !isNaN(numB)) {
      if (numA !== numB) return numA - numB;
    } else {
      if (segA < segB) return -1;
      if (segA > segB) return 1;
    }
  }
  return 0;
}

/* ── Optional background polling ──────────────────────────────── */

let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start or stop background polling based on DB settings.
 * Called from server startup or when settings change.
 */
export async function syncAutoPoll(): Promise<void> {
  const enabled = await getSetting("firmware.autoPoll");
  const intervalMs = await getPollIntervalMs();

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (enabled) {
    pollTimer = setInterval(() => {
      getAllManifests().catch(() => {});
    }, intervalMs);
    log.info("Firmware auto-poll enabled", { intervalS: intervalMs / 1000 });
  }
}
