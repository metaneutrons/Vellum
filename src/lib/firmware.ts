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
 * - PostgreSQL holds the last-known-good catalog and ETag across restarts
 * - request paths return that snapshot immediately (stale-while-revalidate)
 * - a leased background refresh coordinates multiple server replicas
 * - failures preserve good data and persist bounded/rate-limit-aware backoff
 * - only newly discovered immutable releases trigger manifest downloads
 */

import { log } from "./logger";
import { getSetting } from "./settings";
import { deviceFailedTarget, isDeviceInRollout } from "./rollout";
import { db, withDbRead, withDbWrite } from "@/db";
import { firmwareCatalogState } from "@/db/schema";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  FIRMWARE_REFRESH_DEADLINE_MS,
  FIRMWARE_REFRESH_LEASE_MS,
  firmwareNextRetryAt,
  firmwareRefreshDue,
  firmwareRequestTimeoutMs,
  githubRetryAtMs,
} from "./firmware-catalog-policy";
import { isOtaCompatible, type SecurityEvidence } from "./security-posture";

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
  /** Runtime compatibility contract. Optional only for legacy manifests; the
   * server then derives a reversible development layout from the model. */
  partitionLayout?: "e-series-v1" | "e-series-secure-v1" | "d1001-v1";
  securityProfile?: "development" | "testsecure" | "secureboot" | "production";
  requiresSecureBoot?: boolean;
  requiresFlashEncryption?: boolean;
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

const firmwareBinarySchema = z.object({
  url: z.url(),
  size: z.number().int().nonnegative(),
  otaUrl: z.url(),
  otaSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  // Beta builds may intentionally be unsigned for fail-open development
  // devices; stable-release CI separately enforces a non-empty signature.
  otaSignature: z.string(),
  otaSize: z.number().int().nonnegative(),
  otaKeyId: z.string().optional(),
  partitionLayout: z.enum(["e-series-v1", "e-series-secure-v1", "d1001-v1"]).optional(),
  securityProfile: z.enum(["development", "testsecure", "secureboot", "production"]).optional(),
  requiresSecureBoot: z.boolean().optional(),
  requiresFlashEncryption: z.boolean().optional(),
});

const firmwareManifestPayloadSchema = z.object({
  version: z.string().min(1),
  channel: z.string().min(1),
  date: z.string().min(1),
  binaries: z.record(z.string(), firmwareBinarySchema),
});

const persistedManifestsSchema: z.ZodType<FirmwareManifest[]> = z.array(
  firmwareManifestPayloadSchema.extend({ tag: z.string().min(1) })
);

/** Validate an untrusted release asset and bind server-owned release metadata. */
export function parseFirmwareManifest(
  value: unknown,
  tag: string,
  prerelease: boolean
): FirmwareManifest {
  const payload = firmwareManifestPayloadSchema.parse(value);
  return {
    ...payload,
    tag,
    channel: prerelease ? "beta" : "stable",
  };
}

/* ── Cache ────────────────────────────────────────────────────── */

/** Process-local read-through copy of the durable last-known-good snapshot. */
const manifestCache = new Map<string, FirmwareManifest>();

/** ETag from the last successful first-page fetch, persisted across restarts. */
let releasesEtag = "";
let nextRefreshAt: Date | null = null;
let catalogHydration: Promise<void> | null = null;
let refreshInFlight: Promise<void> | null = null;

const CATALOG_SOURCE = "github-releases";
const refreshOwner = `${process.pid}-${randomUUID()}`;

async function getPollIntervalMs(): Promise<number> {
  const s = await getSetting("firmware.pollIntervalS");
  return Math.max(60_000, s * 1000);
}

/** Sorted result cache (rebuilt when new releases are found) */
let sortedManifests: FirmwareManifest[] = [];

class FirmwareCatalogUpstreamError extends Error {
  constructor(
    message: string,
    readonly retryAtMs: number | null = null
  ) {
    super(message);
    this.name = "FirmwareCatalogUpstreamError";
  }
}

function setMemorySnapshot(manifests: FirmwareManifest[], etag: string | null): void {
  manifestCache.clear();
  for (const manifest of manifests) manifestCache.set(manifest.tag, manifest);
  sortedManifests = [...manifestCache.values()].sort((a, b) => compareSemver(b.version, a.version));
  releasesEtag = etag ?? "";
}

async function reloadFirmwareCatalogState(): Promise<void> {
  const [row] = await withDbRead(
    () =>
      db
        .select()
        .from(firmwareCatalogState)
        .where(eq(firmwareCatalogState.source, CATALOG_SOURCE))
        .limit(1),
    "firmware-catalog-hydrate"
  );
  if (!row) return;

  const parsed = persistedManifestsSchema.safeParse(row.manifests);
  if (parsed.success) {
    setMemorySnapshot(parsed.data, row.etag);
  } else {
    // Fail closed: a malformed operational cache may never become an OTA
    // offer. The next background refresh replaces it atomically.
    log.error("Persistent firmware catalog is invalid", {
      error: parsed.error.issues[0]?.message ?? "invalid snapshot",
    });
    // Discard the ETag too: sending it with an empty/invalid snapshot could
    // yield 304 forever and make the corrupt cache self-perpetuating.
    setMemorySnapshot([], null);
  }
  // A peer may currently own the refresh. Avoid a write attempt on every
  // request while its lease is live, then re-read when it can have completed.
  const boundaries = [row.nextRefreshAt, row.leaseUntil].filter(
    (value): value is Date => value instanceof Date
  );
  nextRefreshAt = boundaries.length
    ? new Date(Math.max(...boundaries.map((value) => value.getTime())))
    : null;
}

async function hydrateFirmwareCatalog(): Promise<void> {
  if (catalogHydration) return catalogHydration;
  catalogHydration = (async () => {
    await withDbWrite(
      () =>
        db.insert(firmwareCatalogState).values({ source: CATALOG_SOURCE }).onConflictDoNothing(),
      "firmware-catalog-initialize"
    );
    await reloadFirmwareCatalogState();
  })().catch((err: unknown) => {
    // Permit a later request to retry hydration after a transient DB outage.
    catalogHydration = null;
    throw err;
  });
  return catalogHydration;
}

async function claimRefreshLease(now: Date) {
  const leaseUntil = new Date(now.getTime() + FIRMWARE_REFRESH_LEASE_MS);
  const [claimed] = await withDbWrite(
    () =>
      db
        .update(firmwareCatalogState)
        .set({
          leaseOwner: refreshOwner,
          leaseUntil,
          lastAttemptAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(firmwareCatalogState.source, CATALOG_SOURCE),
            or(isNull(firmwareCatalogState.leaseUntil), lte(firmwareCatalogState.leaseUntil, now)),
            or(
              isNull(firmwareCatalogState.nextRefreshAt),
              lte(firmwareCatalogState.nextRefreshAt, now)
            )
          )
        )
        .returning({ failureCount: firmwareCatalogState.failureCount }),
    "firmware-catalog-claim-refresh"
  );
  return claimed ?? null;
}

function requestSignal(deadlineMs: number): AbortSignal {
  const timeout = firmwareRequestTimeoutMs(deadlineMs, Date.now());
  if (timeout <= 0) throw new FirmwareCatalogUpstreamError("firmware refresh deadline exceeded");
  return AbortSignal.timeout(timeout);
}

async function fetchGithub(url: string, deadlineMs: number, conditionalEtag?: string) {
  const headers = githubHeaders();
  if (conditionalEtag) headers["If-None-Match"] = conditionalEtag;
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: requestSignal(deadlineMs) });
  } catch (err) {
    throw new FirmwareCatalogUpstreamError(`GitHub request failed: ${String(err)}`);
  }
  if (response.ok || response.status === 304) return response;

  const limited =
    response.status === 429 ||
    (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
  const retryAt = limited ? githubRetryAtMs(response.headers, Date.now()) : null;
  throw new FirmwareCatalogUpstreamError(
    `GitHub Releases returned HTTP ${response.status}`,
    retryAt
  );
}

async function discoverFirmwareCatalog(deadlineMs: number): Promise<{
  manifests: FirmwareManifest[];
  etag: string;
  unchanged: boolean;
}> {
  const discovered = new Map(manifestCache);
  const visibleManifestTags = new Set<string>();
  let firstPageEtag = releasesEtag;
  let snapshotComplete = false;

  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const response = await fetchGithub(
      `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`,
      deadlineMs,
      page === 1 ? releasesEtag : undefined
    );
    if (page === 1 && response.status === 304) {
      return { manifests: sortedManifests, etag: releasesEtag, unchanged: true };
    }
    if (page === 1) firstPageEtag = response.headers.get("etag") ?? releasesEtag;

    const releases = z
      .array(
        z.object({
          tag_name: z.string(),
          prerelease: z.boolean(),
          published_at: z.string(),
          assets: z.array(z.object({ name: z.string(), browser_download_url: z.url() })),
        })
      )
      .parse(await response.json()) as GitHubRelease[];

    for (const release of releases) {
      const manifestAsset = release.assets.find((asset) => asset.name === "firmware-manifest.json");
      if (!manifestAsset) continue;
      visibleManifestTags.add(release.tag_name);
      if (discovered.has(release.tag_name)) continue;

      const manifestResponse = await fetchGithub(manifestAsset.browser_download_url, deadlineMs);
      const manifest = parseFirmwareManifest(
        await manifestResponse.json(),
        release.tag_name,
        release.prerelease
      );
      discovered.set(release.tag_name, manifest);
    }

    if (releases.length < RELEASES_PER_PAGE) {
      snapshotComplete = true;
      break;
    }
  }

  if (!snapshotComplete) {
    throw new FirmwareCatalogUpstreamError(
      `GitHub release discovery exceeded ${MAX_RELEASE_PAGES} pages`
    );
  }

  reconcileFirmwareManifestCache(discovered, visibleManifestTags);
  return {
    manifests: [...discovered.values()].sort((a, b) => compareSemver(b.version, a.version)),
    etag: firstPageEtag,
    unchanged: false,
  };
}

async function refreshFirmwareCatalog(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const now = new Date();
    const claimed = await claimRefreshLease(now);
    if (!claimed) {
      await reloadFirmwareCatalogState();
      return;
    }

    try {
      const result = await discoverFirmwareCatalog(Date.now() + FIRMWARE_REFRESH_DEADLINE_MS);
      const intervalMs = await getPollIntervalMs();
      const completedAt = new Date();
      const next = new Date(completedAt.getTime() + intervalMs);
      await withDbWrite(
        () =>
          db
            .update(firmwareCatalogState)
            .set({
              manifests: result.manifests,
              etag: result.etag || null,
              lastSuccessAt: completedAt,
              nextRefreshAt: next,
              failureCount: 0,
              lastError: null,
              leaseOwner: null,
              leaseUntil: null,
              updatedAt: completedAt,
            })
            .where(
              and(
                eq(firmwareCatalogState.source, CATALOG_SOURCE),
                eq(firmwareCatalogState.leaseOwner, refreshOwner)
              )
            ),
        "firmware-catalog-persist-success"
      );
      setMemorySnapshot(result.manifests, result.etag);
      nextRefreshAt = next;
      log.info("Firmware catalog refresh complete", {
        manifests: result.manifests.length,
        unchanged: result.unchanged,
      });
    } catch (err) {
      const failureCount = claimed.failureCount + 1;
      const retryAt = firmwareNextRetryAt(
        Date.now(),
        failureCount,
        err instanceof FirmwareCatalogUpstreamError ? err.retryAtMs : null
      );
      const message = String(err instanceof Error ? err.message : err).slice(0, 500);
      await withDbWrite(
        () =>
          db
            .update(firmwareCatalogState)
            .set({
              nextRefreshAt: retryAt,
              failureCount,
              lastError: message,
              leaseOwner: null,
              leaseUntil: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(firmwareCatalogState.source, CATALOG_SOURCE),
                eq(firmwareCatalogState.leaseOwner, refreshOwner)
              )
            ),
        "firmware-catalog-persist-failure"
      );
      nextRefreshAt = retryAt;
      log.warn("Firmware catalog refresh deferred", {
        error: message,
        retryAt: retryAt.toISOString(),
        cachedManifests: sortedManifests.length,
      });
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function scheduleFirmwareRefresh(): void {
  if (refreshInFlight || !firmwareRefreshDue(nextRefreshAt, Date.now())) return;
  void refreshFirmwareCatalog().catch((err: unknown) =>
    log.warn("Firmware catalog background refresh failed", { error: String(err) })
  );
}

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

/** Read the durable firmware catalog and schedule a refresh if it is due. */
export async function getAllManifests(): Promise<FirmwareManifest[]> {
  await hydrateFirmwareCatalog();
  scheduleFirmwareRefresh();
  // Critical invariant: no caller waits for GitHub. Admin SSR and device polls
  // always receive the durable last-known-good snapshot immediately.
  return sortedManifests;
}

/** Hydrate the durable snapshot during server boot and refresh asynchronously. */
export async function initializeFirmwareCatalog(): Promise<void> {
  await hydrateFirmwareCatalog();
  scheduleFirmwareRefresh();
}

/**
 * Get manifests filtered by channel.
 */
export async function getManifestsByChannel(channel: FirmwareChannel): Promise<FirmwareManifest[]> {
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
  mac: string,
  securityEvidence: SecurityEvidence | null = null
): Promise<OtaInfo> {
  // Channel semantics: 'beta' is a SUPERSET of 'stable'. A device tracking the
  // beta channel — typically sitting at a pre-release — must still roll forward
  // onto a superseding STABLE release, so its candidate set is stable ∪ beta
  // (newest by compareSemver wins). 'stable' devices only ever see stable.
  const all = await getAllManifests();
  const manifests = channel === "beta" ? all : all.filter((m) => m.channel === "stable");
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

  const compatibility = isOtaCompatible(binary, displayModel, securityEvidence);
  if (!compatibility.compatible) {
    log.warn("Blocked incompatible OTA offer", {
      mac,
      model: displayModel,
      version: target.version,
      reason: compatibility.reason,
    });
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
  /* split() always yields at least one element, so the fallbacks never apply. */
  const cleanA = a.replace(/^v/, "").split("+")[0] ?? "";
  const cleanB = b.replace(/^v/, "").split("+")[0] ?? "";

  // Split into version and pre-release
  const [verA = "", preA] = cleanA.split("-", 2);
  const [verB = "", preB] = cleanB.split("-", 2);

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
      getAllManifests().catch(() => {
        /* warm-up only; a failure here is retried on the next real request */
      });
    }, intervalMs);
    log.info("Firmware auto-poll enabled", { intervalS: intervalMs / 1000 });
  }
}
