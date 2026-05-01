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

  // Single query: devices + latest telemetry
  const rows = await db.execute(sql`
    SELECT
      d.mac, d.status, d.content_instance_id, d.theme_id,
      d.refresh_profile_id, d.firmware_channel, d.firmware_pin_version,
      d.display_caps, d.last_seen, d.approved_at, d.created_at,
      t.battery_level, t.battery_voltage, t.wifi_rssi, t.firmware_version
    FROM devices d
    LEFT JOIN LATERAL (
      SELECT battery_level, battery_voltage, wifi_rssi, firmware_version
      FROM telemetry WHERE mac = d.mac ORDER BY timestamp DESC LIMIT 1
    ) t ON true
    ORDER BY d.last_seen DESC NULLS LAST
  `);

  return (
    <DeviceTable
      devices={rows.rows as Record<string, unknown>[]}
      themes={themeList}
      contentInstances={contentList}
      refreshProfiles={profileList}
      firmwareVersions={versions}
      providers={providers}
      knownDisplays={knownDisplays}
    />
  );
}
