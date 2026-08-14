// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { sql } from "drizzle-orm";
import { db, withDbRead } from "@/db";
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

  // The container completes schema migrations before serving requests, so a
  // schema error must remain visible instead of being mistaken for an older DB.
  const deviceRows = (await withDbRead(() => db.execute(sql`
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
    `), "devices-with-latest-telemetry")).rows as Record<string, unknown>[];

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
