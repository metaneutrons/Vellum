/**
 * Typed application settings backed by the settings KV table.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";

/** All known settings with their defaults. */
const DEFAULTS = {
  "firmware.autoPoll": false,
  "firmware.pollIntervalS": 900,
} as const;

type SettingsMap = typeof DEFAULTS;
type SettingKey = keyof SettingsMap;

/** In-memory cache (populated on first read). */
const cache = new Map<string, unknown>();

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingsMap[K]> {
  if (cache.has(key)) return cache.get(key) as SettingsMap[K];

  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);

  const value = row ? (row.value as SettingsMap[K]) : DEFAULTS[key];
  cache.set(key, value);
  return value;
}

export async function setSetting<K extends SettingKey>(
  key: K,
  value: SettingsMap[K]
): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value: value as never, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: value as never, updatedAt: new Date() },
    });
  cache.set(key, value);
}

export async function getAllSettings(): Promise<Record<SettingKey, unknown>> {
  const rows = await db.select().from(settings);
  const result = { ...DEFAULTS } as Record<SettingKey, unknown>;
  for (const row of rows) {
    if (row.key in DEFAULTS) {
      result[row.key as SettingKey] = row.value;
      cache.set(row.key, row.value);
    }
  }
  return result;
}
