"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  devices,
  themes,
  dataProviders,
  contentInstances,
  contentTypes,
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
  type: "microsoft365" | "google" | "ical",
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
  return db.select().from(contentTypes);
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

export { getAvailableVersions } from "@/lib/firmware";

/* ── Settings ─────────────────────────────────────────────────── */

export async function updateSetting(key: string, value: unknown) {
  const { setSetting } = await import("@/lib/settings");
  const { syncAutoPoll } = await import("@/lib/firmware");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await setSetting(key as any, value as any);
  if (key.startsWith("firmware.")) await syncAutoPoll();
  revalidatePath("/admin/firmware");
}
