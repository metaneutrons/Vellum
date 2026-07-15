// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getAllThemes, getAllContentInstances, getAllRefreshProfiles, getAvailableVersions, getAllProviders, getKnownDisplaySizes } from "../actions";
import { DeviceTable } from "./device-table";

export default async function DevicesPage() {
  const [themeList, contentList, profileList, versions, providers, knownDisplays] = await Promise.all([
    getAllThemes(),
    getAllContentInstances(),
    getAllRefreshProfiles(),
    getAvailableVersions(),
    getAllProviders(),
    getKnownDisplaySizes(),
  ]);

  // Devices + latest telemetry. The primary query includes expected_interval_s
  // (the connectivity cadence). If that column isn't migrated yet, fall back to
  // a query without it so the page degrades gracefully instead of 500ing —
  // connectivity then uses the default cadence until `npm run db:migrate` runs.
  let deviceRows: Record<string, unknown>[];
  try {
    deviceRows = (await db.execute(sql`
      SELECT
        d.mac, d.status, d.content_instance_id, d.theme_id,
        d.refresh_profile_id, d.firmware_channel, d.firmware_pin_version,
        d.display_caps, d.orientation_override, d.last_seen, d.expected_interval_s, d.approved_at, d.created_at,
        t.battery_level, t.battery_voltage, t.wifi_rssi, t.firmware_version
      FROM devices d
      LEFT JOIN LATERAL (
        SELECT battery_level, battery_voltage, wifi_rssi, firmware_version
        FROM telemetry WHERE mac = d.mac ORDER BY timestamp DESC LIMIT 1
      ) t ON true
      ORDER BY d.last_seen DESC NULLS LAST
    `)).rows as Record<string, unknown>[];
  } catch {
    deviceRows = (await db.execute(sql`
      SELECT
        d.mac, d.status, d.content_instance_id, d.theme_id,
        d.refresh_profile_id, d.firmware_channel, d.firmware_pin_version,
        d.display_caps, d.orientation_override, d.last_seen, d.approved_at, d.created_at,
        t.battery_level, t.battery_voltage, t.wifi_rssi, t.firmware_version
      FROM devices d
      LEFT JOIN LATERAL (
        SELECT battery_level, battery_voltage, wifi_rssi, firmware_version
        FROM telemetry WHERE mac = d.mac ORDER BY timestamp DESC LIMIT 1
      ) t ON true
      ORDER BY d.last_seen DESC NULLS LAST
    `)).rows as Record<string, unknown>[];
  }

  return (
    <DeviceTable
      devices={deviceRows}
      themes={themeList}
      contentInstances={contentList}
      refreshProfiles={profileList}
      firmwareVersions={versions}
      providers={providers}
      knownDisplays={knownDisplays}
    />
  );
}
