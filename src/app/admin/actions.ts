// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  devices,
  themes,
  dataProviders,
  contentInstances,
  telemetry,
  reports,
  refreshProfiles,
} from "@/db/schema";
import { encryptCredentials, decryptCredentials } from "@/lib/encryption";
import { approveDevice as approveDeviceAuth } from "@/lib/auth";
import { log } from "@/lib/logger";

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

export async function updateDevice(
  mac: string,
  data: { contentInstanceId?: string | null; themeId?: string | null; refreshProfileId?: string | null; firmwareChannel?: string | null; firmwarePinVersion?: string | null }
) {
  try {
    await db.update(devices).set(data).where(eq(devices.mac, mac));
    revalidatePath("/admin/devices");
  } catch (err) {
    log.error("Failed to update device", { mac, error: String(err) });
    throw err;
  }
}

export async function deleteDevice(mac: string) {
  try {
    await db.delete(telemetry).where(eq(telemetry.mac, mac));
    await db.delete(reports).where(eq(reports.mac, mac));
    await db.delete(devices).where(eq(devices.mac, mac));
    revalidatePath("/admin/devices");
  } catch (err) {
    log.error("Failed to delete device", { mac, error: String(err) });
    throw err;
  }
}

/* ── Themes ───────────────────────────────────────────────────── */

export async function createTheme(name: string, config: Record<string, string>) {
  await db.insert(themes).values({ name, config });
  revalidatePath("/admin/themes");
}

export async function updateTheme(id: string, name: string, config: Record<string, string>) {
  await db.update(themes).set({ name, config, updatedAt: new Date() }).where(eq(themes.id, id));
  revalidatePath("/admin/themes");
}

export async function deleteTheme(id: string) {
  await db.delete(themes).where(eq(themes.id, id));
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
    await db.insert(dataProviders).values({ type, name, encryptedCredentials: encrypted });
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
    await db.update(dataProviders).set(data).where(eq(dataProviders.id, id));
    revalidatePath("/admin/providers");
  } catch (err) {
    log.error("Failed to update provider", { id, error: String(err) });
    throw err;
  }
}

export async function deleteProvider(id: string) {
  await db.delete(dataProviders).where(eq(dataProviders.id, id));
  revalidatePath("/admin/providers");
}

/* ── Content Instances ────────────────────────────────────────── */

export async function createContentInstance(
  typeSlug: string,
  name: string,
  config: Record<string, unknown>
) {
  await db.insert(contentInstances).values({ typeSlug, name, config });
  revalidatePath("/admin/content");
}

export async function updateContentInstance(
  id: string,
  name: string,
  config: Record<string, unknown>
) {
  await db
    .update(contentInstances)
    .set({ name, config, updatedAt: new Date() })
    .where(eq(contentInstances.id, id));
  revalidatePath("/admin/content");
}

export async function deleteContentInstance(id: string) {
  await db.delete(contentInstances).where(eq(contentInstances.id, id));
  revalidatePath("/admin/content");
}

/* ── Lookups ──────────────────────────────────────────────────── */

export async function getAllDevices() {
  return db.select().from(devices).orderBy(devices.createdAt);
}

export async function getAllThemes() {
  return db.select().from(themes).orderBy(themes.name);
}

export async function getAllProviders() {
  return db
    .select({
      id: dataProviders.id,
      type: dataProviders.type,
      name: dataProviders.name,
      createdAt: dataProviders.createdAt,
    })
    .from(dataProviders)
    .orderBy(dataProviders.name);
}

export async function getProviderCredentials(id: string): Promise<Record<string, string>> {
  const [provider] = await db
    .select({ encrypted: dataProviders.encryptedCredentials })
    .from(dataProviders)
    .where(eq(dataProviders.id, id))
    .limit(1);
  if (!provider) return {};
  try {
    return decryptCredentials(provider.encrypted) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function getAllContentInstances() {
  return db.select().from(contentInstances).orderBy(contentInstances.name);
}

export async function getAllContentTypes() {
  const { getAllContentRenderers } = await import("@/lib/content/registry");
  return getAllContentRenderers().map((r) => ({ slug: r.slug, name: r.name }));
}


export async function testDataProvider(id: string): Promise<{ ok: boolean; message: string }> {
  const [provider] = await db.select().from(dataProviders).where(eq(dataProviders.id, id)).limit(1);
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
      const res = await fetch(credentials.url, { signal: AbortSignal.timeout(10_000) });
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
  const [instance] = await db.select().from(contentInstances).where(eq(contentInstances.id, id)).limit(1);
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
  return db.select().from(refreshProfiles).orderBy(refreshProfiles.name);
}

export async function createRefreshProfile(name: string, config: Record<string, unknown>) {
  try {
    await db.insert(refreshProfiles).values({ name, config });
    revalidatePath("/admin/profiles");
  } catch (err) {
    log.error("Failed to create refresh profile", { error: String(err) });
    throw err;
  }
}

export async function updateRefreshProfile(id: string, name: string, config: Record<string, unknown>) {
  try {
    await db.update(refreshProfiles).set({ name, config, updatedAt: new Date() }).where(eq(refreshProfiles.id, id));
    revalidatePath("/admin/profiles");
  } catch (err) {
    log.error("Failed to update refresh profile", { id, error: String(err) });
    throw err;
  }
}

export async function deleteRefreshProfile(id: string) {
  try {
    await db.delete(refreshProfiles).where(eq(refreshProfiles.id, id));
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
  const { DEFAULT_DISPLAY } = await import("@/lib/content/renderers/door-sign-types");
  const rows = await db.selectDistinct({ displayCaps: devices.displayCaps }).from(devices)
    .where(sql`${devices.displayCaps} IS NOT NULL`);
  const seen = new Set<string>();
  const sizes: { label: string; width: number; height: number }[] = [];

  for (const row of rows) {
    if (!row.displayCaps || typeof row.displayCaps !== "object") continue;
    const caps = row.displayCaps as { model?: string; width?: number; height?: number };
    if (!caps.width || !caps.height) continue;
    const key = `${caps.width}x${caps.height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sizes.push({ label: `${caps.model ?? "Unknown"} (${key})`, width: caps.width, height: caps.height });
  }

  if (sizes.length === 0) sizes.push(DEFAULT_DISPLAY);
  return sizes;
}
