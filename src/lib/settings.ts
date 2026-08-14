// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Typed application settings backed by the settings KV table.
 */

import { eq } from "drizzle-orm";
import { db, withDbRead, withDbWrite, type DbTransaction } from "@/db";
import { settings } from "@/db/schema";

/** All known settings with their defaults. */
type SettingsMap = {
  "firmware.autoPoll": boolean;
  "firmware.pollIntervalS": number;
  "access.oidcAutoProvision": boolean;
  "access.oidcDefaultRole": string;
  "access.oidcGroupRoleMap": Record<string, string>;
  "access.passkeyPolicy": "recommended" | "required";
  "access.rememberDeviceDays": number;
  "access.fourEyesRequired": boolean;
};

const DEFAULTS: SettingsMap = {
  "firmware.autoPoll": false,
  "firmware.pollIntervalS": 900,
  "access.oidcAutoProvision": false,
  "access.oidcDefaultRole": "viewer",
  "access.oidcGroupRoleMap": {} as Record<string, string>,
  "access.passkeyPolicy": "recommended",
  "access.rememberDeviceDays": 30,
  "access.fourEyesRequired": false,
};
export type SettingKey = keyof SettingsMap;

/**
 * Short-lived process cache. A bounded TTL keeps horizontally scaled server
 * replicas coherent even when another replica changes a setting.
 */
const CACHE_TTL_MS = 1_000;
const cache = new Map<string, { value: unknown; expiresAt: number }>();

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingsMap[K]> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as SettingsMap[K];
  if (cached) cache.delete(key);

  const [row] = await withDbRead(() => db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1), "get-setting");

  const value = row ? (row.value as SettingsMap[K]) : DEFAULTS[key];
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export async function setSetting<K extends SettingKey>(
  key: K,
  value: SettingsMap[K]
): Promise<void> {
  await withDbWrite(() => db
    .insert(settings)
    .values({ key, value: value as never, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: value as never, updatedAt: new Date() },
    }), "set-setting");
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Write a setting inside a caller-owned transaction; cache only after commit. */
export async function setSettingInTransaction<K extends SettingKey>(
  tx: DbTransaction,
  key: K,
  value: SettingsMap[K],
): Promise<void> {
  await tx.insert(settings)
    .values({ key, value: value as never, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: value as never, updatedAt: new Date() },
    });
}

/** Publish a committed value to the process-local read cache. */
export function cacheCommittedSetting<K extends SettingKey>(key: K, value: SettingsMap[K]): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function getAllSettings(): Promise<Record<SettingKey, unknown>> {
  const rows = await withDbRead(() => db.select().from(settings), "get-all-settings");
  const result = { ...DEFAULTS } as Record<SettingKey, unknown>;
  for (const row of rows) {
    if (row.key in DEFAULTS) {
      result[row.key as SettingKey] = row.value;
      cache.set(row.key, { value: row.value, expiresAt: Date.now() + CACHE_TTL_MS });
    }
  }
  return result;
}
