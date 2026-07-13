// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, withDb } from "@/db";
import { safeFetch } from "@/lib/safe-fetch";
import {
  devices,
  themes,
  dataProviders,
  contentInstances,
  telemetry,
  reports,
  refreshProfiles,
  firmwareRollouts,
  otaEvents,
  provisioningVouchers,
} from "@/db/schema";
import type { RolloutState } from "@/lib/rollout";
import { encryptCredentials, decryptCredentials } from "@/lib/encryption";
import { approveDevice as approveDeviceAuth } from "@/lib/auth";
import { log } from "@/lib/logger";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";
import { randomBytes } from "node:crypto";

/** Throw unless the caller holds a valid admin session cookie. */
async function requireAdmin(): Promise<void> {
  const c = await cookies();
  if (!(await verifySessionToken(c.get(SESSION_COOKIE)?.value))) {
    throw new Error("Unauthorized");
  }
}

/* ── Devices ──────────────────────────────────────────────────── */

export async function approveDevice(mac: string) {
  try {
    await approveDeviceAuth(mac);
    revalidatePath("/admin/devices");
  } catch (err) {
    log.error("Failed to approve device", { mac, error: String(err) });
    throw err;
  }
}

/**
 * Mint a single-use pre-provisioning voucher (a device token) for zero-touch
 * USB enrolment. The returned token is embedded in the device profile over USB;
 * the first device to present it is auto-approved. Admin-session guarded.
 */
export async function createProvisioningVoucher(label: string): Promise<string> {
  await requireAdmin();
  const token = randomBytes(32).toString("hex");
  await withDb(
    () => db.insert(provisioningVouchers).values({ token, label: label.trim() || null }),
    "create-voucher",
  );
  revalidatePath("/admin/devices");
  return token;
}

export async function updateDevice(
  mac: string,
  data: { contentInstanceId?: string | null; themeId?: string | null; refreshProfileId?: string | null; firmwareChannel?: string | null; firmwarePinVersion?: string | null; orientationOverride?: string | null }
) {
  try {
    await withDb(() => db.update(devices).set(data).where(eq(devices.mac, mac)), "update-device");
    revalidatePath("/admin/devices");
  } catch (err) {
    log.error("Failed to update device", { mac, error: String(err) });
    throw err;
  }
}

export async function deleteDevice(mac: string) {
  try {
    await withDb(() => db.delete(telemetry).where(eq(telemetry.mac, mac)), "delete-device-telemetry");
    await withDb(() => db.delete(reports).where(eq(reports.mac, mac)), "delete-device-reports");
    await withDb(() => db.delete(devices).where(eq(devices.mac, mac)), "delete-device");
    revalidatePath("/admin/devices");
  } catch (err) {
    log.error("Failed to delete device", { mac, error: String(err) });
    throw err;
  }
}

/* ── Themes ───────────────────────────────────────────────────── */

export async function createTheme(name: string, config: Record<string, string>) {
  await withDb(() => db.insert(themes).values({ name, config }), "create-theme");
  revalidatePath("/admin/themes");
}

export async function updateTheme(id: string, name: string, config: Record<string, string>) {
  await withDb(() => db.update(themes).set({ name, config, updatedAt: new Date() }).where(eq(themes.id, id)), "update-theme");
  revalidatePath("/admin/themes");
}

export async function deleteTheme(id: string) {
  await withDb(() => db.delete(themes).where(eq(themes.id, id)), "delete-theme");
  revalidatePath("/admin/themes");
}

/* ── Calendar Providers ───────────────────────────────────────── */

export async function createProvider(
  type: string,
  name: string,
  credentials: Record<string, string>
) {
  try {
    const encrypted = encryptCredentials(credentials);
    await withDb(() => db.insert(dataProviders).values({ type, name, encryptedCredentials: encrypted }), "create-provider");
    revalidatePath("/admin/providers");
  } catch (err) {
    log.error("Failed to create provider", { error: String(err) });
    throw err;
  }
}

export async function updateProvider(
  id: string,
  name: string,
  credentials?: Record<string, string>
) {
  try {
    const data: Record<string, unknown> = { name, updatedAt: new Date() };
    if (credentials && Object.keys(credentials).length > 0) {
      data.encryptedCredentials = encryptCredentials(credentials);
    }
    await withDb(() => db.update(dataProviders).set(data).where(eq(dataProviders.id, id)), "update-provider");
    revalidatePath("/admin/providers");
  } catch (err) {
    log.error("Failed to update provider", { id, error: String(err) });
    throw err;
  }
}

export async function deleteProvider(id: string) {
  await withDb(() => db.delete(dataProviders).where(eq(dataProviders.id, id)), "delete-provider");
  revalidatePath("/admin/providers");
}

/* ── Content Instances ────────────────────────────────────────── */

export async function createContentInstance(
  typeSlug: string,
  name: string,
  config: Record<string, unknown>
) {
  await withDb(() => db.insert(contentInstances).values({ typeSlug, name, config }), "create-content-instance");
  revalidatePath("/admin/content");
}

export async function updateContentInstance(
  id: string,
  name: string,
  config: Record<string, unknown>
) {
  await withDb(() => db.update(contentInstances).set({ name, config, updatedAt: new Date() }).where(eq(contentInstances.id, id)), "update-content-instance");
  revalidatePath("/admin/content");
}

export async function deleteContentInstance(id: string) {
  await withDb(() => db.delete(contentInstances).where(eq(contentInstances.id, id)), "delete-content-instance");
  revalidatePath("/admin/content");
}

/* ── Lookups ──────────────────────────────────────────────────── */

export async function getAllDevices() {
  return withDb(() => db.select().from(devices).orderBy(devices.createdAt), "get-all-devices");
}

export async function getAllThemes() {
  return withDb(() => db.select().from(themes).orderBy(themes.name), "get-all-themes");
}

export async function getAllProviders() {
  return withDb(() => db.select({
    id: dataProviders.id,
    type: dataProviders.type,
    name: dataProviders.name,
    createdAt: dataProviders.createdAt,
  }).from(dataProviders).orderBy(dataProviders.name), "get-all-providers");
}

export async function getProviderCredentials(id: string): Promise<Record<string, string>> {
  const [provider] = await withDb(() => db
    .select({ encrypted: dataProviders.encryptedCredentials })
    .from(dataProviders)
    .where(eq(dataProviders.id, id))
    .limit(1), "get-provider-credentials");
  if (!provider) return {};
  try {
    return decryptCredentials(provider.encrypted) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function getAllContentInstances() {
  return withDb(() => db.select().from(contentInstances).orderBy(contentInstances.name), "get-all-content-instances");
}

export async function getAllContentTypes() {
  const { getAllContentRenderers } = await import("@/lib/content/registry");
  return getAllContentRenderers().map((r) => ({ slug: r.slug, name: r.name }));
}


export async function testDataProvider(id: string): Promise<{ ok: boolean; message: string }> {
  const [provider] = await withDb(() => db.select().from(dataProviders).where(eq(dataProviders.id, id)).limit(1), "test-provider-get");
  if (!provider) return { ok: false, message: "Provider not found" };

  try {
    const { decryptCredentials: decrypt } = await import("@/lib/encryption");
    const credentials = decrypt(provider.encryptedCredentials) as Record<string, string>;

    if (provider.type === "microsoft365") {
      // Test: get OAuth token from Microsoft Graph
      const { ConfidentialClientApplication } = await import("@azure/msal-node");
      const cca = new ConfidentialClientApplication({
        auth: { clientId: credentials.clientId, clientSecret: credentials.clientSecret, authority: `https://login.microsoftonline.com/${credentials.tenantId}` },
      });
      const token = await cca.acquireTokenByClientCredential({ scopes: ["https://graph.microsoft.com/.default"] });
      return { ok: !!token?.accessToken, message: token?.accessToken ? "Connected — token acquired" : "No token returned" };
    }

    if (provider.type === "google") {
      // Test: exchange JWT for access token (same as provider does)
      const { createJwt } = await import("@/lib/calendar/providers/google");
      const jwt = createJwt(credentials.clientEmail, credentials.privateKey);
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) { const t = await res.text(); return { ok: false, message: `Google auth failed: ${t.slice(0, 100)}` }; }
      return { ok: true, message: "Connected — token acquired" };
    }

    if (provider.type === "ical") {
      // safeFetch (not raw fetch): the URL comes from stored provider credentials,
      // so it must go through the SSRF guard that blocks private/link-local/loopback
      // targets — otherwise "Test connection" is an authenticated SSRF primitive.
      const res = await safeFetch(credentials.url, { timeoutMs: 10_000 });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status} from iCal URL` };
      const text = await res.text();
      return { ok: text.includes("VCALENDAR"), message: text.includes("VCALENDAR") ? "Connected — valid iCal feed" : "Response is not a valid iCal feed" };
    }

    if (provider.type === "anny") {
      const { fetchAnnyResources, extractOrgFromToken } = await import("@/lib/calendar/providers/anny");
      const orgId = credentials.organizationId || extractOrgFromToken(credentials.apiToken) || "";
      if (!orgId) return { ok: false, message: "Cannot extract organization ID from token" };
      const result = await fetchAnnyResources(credentials.apiToken, orgId);
      return { ok: true, message: `Connected — ${result.total} resources found` };
    }

    return { ok: false, message: `Unknown provider type: ${provider.type}` };
  } catch (err) {
    return { ok: false, message: String(err instanceof Error ? err.message : err) };
  }
}

export async function testContentInstance(id: string): Promise<{ ok: boolean; message: string }> {
  const [instance] = await withDb(() => db.select().from(contentInstances).where(eq(contentInstances.id, id)).limit(1), "test-content-instance-get");
  if (!instance) return { ok: false, message: "Content instance not found" };

  try {
    const { getContentRenderer } = await import("@/lib/content/registry");
    const renderer = getContentRenderer(instance.typeSlug);
    if (!renderer) return { ok: false, message: `Unknown renderer: ${instance.typeSlug}` };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = renderer.configSchema.parse(instance.config) as any;

    if (instance.typeSlug === "room-booking") {
      const { fetchEvents } = await import("@/lib/content/renderers/room-booking");
      const events = await fetchEvents(config);
      return { ok: true, message: `OK — ${events.length} events today` };
    }

    if (instance.typeSlug === "door-sign") {
      const { getProviderWithCredentials } = await import("@/lib/providers");
      const { getCalendarProvider } = await import("@/lib/calendar/registry");
      const provider = await getProviderWithCredentials(config.providerId);
      const impl = getCalendarProvider(provider.type);
      if (!impl) return { ok: false, message: `No provider implementation: ${provider.type}` };
      const now = new Date();
      const events = await impl.fetchEvents({
        credentials: provider.credentials,
        roomConfig: { resourceId: config.resourceId, resourceName: config.resourceName },
        windowStart: new Date(now.getTime() - 3600_000),
        windowEnd: new Date(now.getTime() + 3600_000),
      });
      const current = events.find(e => now >= e.startTime && now < e.endTime);
      return { ok: true, message: current ? `Occupied: ${current.organizer}` : `Free — ${events.length} bookings today` };
    }

    return { ok: true, message: "Config valid" };
  } catch (err) {
    return { ok: false, message: String(err instanceof Error ? err.message : err) };
  }
}
/* ── Refresh Profiles ─────────────────────────────────────────── */

export async function getAllRefreshProfiles() {
  return withDb(() => db.select().from(refreshProfiles).orderBy(refreshProfiles.name), "get-all-refresh-profiles");
}

export async function createRefreshProfile(name: string, config: Record<string, unknown>) {
  try {
    await withDb(() => db.insert(refreshProfiles).values({ name, config }), "create-refresh-profile");
    revalidatePath("/admin/profiles");
  } catch (err) {
    log.error("Failed to create refresh profile", { error: String(err) });
    throw err;
  }
}

export async function updateRefreshProfile(id: string, name: string, config: Record<string, unknown>) {
  try {
    await withDb(() => db.update(refreshProfiles).set({ name, config, updatedAt: new Date() }).where(eq(refreshProfiles.id, id)), "update-refresh-profile");
    revalidatePath("/admin/profiles");
  } catch (err) {
    log.error("Failed to update refresh profile", { id, error: String(err) });
    throw err;
  }
}

export async function deleteRefreshProfile(id: string) {
  try {
    await withDb(() => db.delete(refreshProfiles).where(eq(refreshProfiles.id, id)), "delete-refresh-profile");
    revalidatePath("/admin/profiles");
  } catch (err) {
    log.error("Failed to delete refresh profile", { id, error: String(err) });
    throw err;
  }
}

/* ── Firmware ──────────────────────────────────────────────────── */

export async function getAvailableVersions() {
  const { getAvailableVersions: fn } = await import("@/lib/firmware");
  return fn();
}

/* ── Settings ─────────────────────────────────────────────────── */

export async function updateSetting(key: string, value: unknown) {
  const { setSetting } = await import("@/lib/settings");
  const { syncAutoPoll } = await import("@/lib/firmware");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await setSetting(key as any, value as any);
  if (key.startsWith("firmware.")) await syncAutoPoll();
  revalidatePath("/admin/firmware");
}

export async function getKnownDisplaySizes(): Promise<{ label: string; width: number; height: number }[]> {
  const { KNOWN_DISPLAYS } = await import("@/lib/content/renderers/door-sign-types");
  const rows = await withDb(() => db.selectDistinct({ displayCaps: devices.displayCaps }).from(devices)
    .where(sql`${devices.displayCaps} IS NOT NULL`), "get-known-display-sizes");
  const seen = new Set<string>();
  const sizes: { label: string; width: number; height: number }[] = [];

  // Start with all registry displays
  for (const d of KNOWN_DISPLAYS) {
    const key = `${d.width}x${d.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sizes.push(d);
  }

  // Add any DB-known sizes not in the registry
  for (const row of rows) {
    if (!row.displayCaps || typeof row.displayCaps !== "object") continue;
    const caps = row.displayCaps as { model?: string; width?: number; height?: number };
    if (!caps.width || !caps.height) continue;
    const key = `${caps.width}x${caps.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sizes.push({ label: `${caps.model ?? "Unknown"} (${key})`, width: caps.width, height: caps.height });
  }

  return sizes;
}

/* ── Firmware rollouts ────────────────────────────────────────── */

/** All rollout records (for the rollout dashboard), newest-touched first. */
export async function getRollouts() {
  return withDb(
    () => db.select().from(firmwareRollouts).orderBy(sql`${firmwareRollouts.updatedAt} DESC`),
    "get-rollouts",
  );
}

/**
 * Create or update the rollout for a (version, channel). `percent` is clamped to
 * 0-100 and only meaningful in the "canary"/"percent" states.
 */
export async function setRollout(
  version: string,
  channel: string,
  state: RolloutState,
  percent = 0,
) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  await withDb(
    () =>
      db
        .insert(firmwareRollouts)
        .values({ version, channel, state, percent: pct, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [firmwareRollouts.version, firmwareRollouts.channel],
          set: { state, percent: pct, updatedAt: new Date() },
        }),
    "set-rollout",
  );
  revalidatePath("/admin/firmware");
}

/** One-click kill-switch: stop offering `version` on `channel` fleet-wide. */
export async function haltRollout(version: string, channel: string) {
  await setRollout(version, channel, "halted", 0);
}

/** Recent OTA outcome events (for the rollout dashboard / failure triage). */
export async function getRecentOtaEvents(limit = 100) {
  return withDb(
    () =>
      db.select().from(otaEvents).orderBy(sql`${otaEvents.timestamp} DESC`).limit(limit),
    "get-ota-events",
  );
}

export interface RolloutOverview {
  rollouts: { version: string; channel: string; state: string; percent: number }[];
  adoption: { version: string; count: number }[];
  health: { version: string; phase: string; count: number }[];
  recentEvents: {
    mac: string;
    model: string | null;
    fromVersion: string | null;
    toVersion: string | null;
    phase: string;
    errorCode: string | null;
    timestamp: string;
  }[];
}

/** Everything the rollout dashboard needs in one round-trip. */
export async function getRolloutOverview(): Promise<RolloutOverview> {
  const [rollouts, adoption, health, recentEvents] = await Promise.all([
    getRollouts().catch(() => []),
    // Adoption: how many devices are running each firmware version (latest
    // telemetry row per device).
    withDb(
      () =>
        db.execute(sql`
          SELECT t.firmware_version AS version, count(*)::int AS count
          FROM (
            SELECT DISTINCT ON (mac) mac, firmware_version
            FROM telemetry WHERE firmware_version IS NOT NULL
            ORDER BY mac, timestamp DESC
          ) t
          GROUP BY t.firmware_version ORDER BY count DESC
        `),
      "rollout-adoption",
    )
      .then((r) => r.rows as { version: string; count: number }[])
      .catch(() => []),
    // Health: OTA outcome counts per target version (last 30 days).
    withDb(
      () =>
        db.execute(sql`
          SELECT to_version AS version, phase, count(*)::int AS count
          FROM ota_events
          WHERE timestamp > now() - make_interval(days => 30) AND to_version IS NOT NULL
          GROUP BY to_version, phase
        `),
      "rollout-health",
    )
      .then((r) => r.rows as { version: string; phase: string; count: number }[])
      .catch(() => []),
    withDb(
      () =>
        db.execute(sql`
          SELECT mac, model, from_version AS "fromVersion", to_version AS "toVersion",
                 phase, error_code AS "errorCode",
                 to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp
          FROM ota_events ORDER BY timestamp DESC LIMIT 50
        `),
      "rollout-events",
    )
      .then((r) => r.rows as RolloutOverview["recentEvents"])
      .catch(() => []),
  ]);
  return {
    rollouts: rollouts as RolloutOverview["rollouts"],
    adoption,
    health,
    recentEvents,
  };
}
