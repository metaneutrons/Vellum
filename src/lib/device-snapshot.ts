// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { sql } from "drizzle-orm";
import { db, withDbRead } from "@/db";

export type DeviceSnapshot = Record<string, unknown> & { mac: string };

/** One authoritative shape for initial RSC render and live delta refreshes. */
export async function getDeviceSnapshots(macs?: readonly string[]): Promise<DeviceSnapshot[]> {
  if (macs && macs.length === 0) return [];
  const filter = macs
    ? sql`WHERE d.mac IN (${sql.join(
        macs.map((mac) => sql`${mac}`),
        sql`, `
      )})`
    : sql``;
  const result = await withDbRead(
    () =>
      db.execute(sql`
        SELECT
          d.mac, d.status, d.content_instance_id, d.theme_id,
          d.refresh_profile_id, d.firmware_channel, d.firmware_pin_version,
          d.display_caps, d.orientation_override, d.last_seen,
          d.expected_interval_s, d.approved_at, d.created_at,
          t.battery_level, t.battery_voltage, t.power_source, t.battery_status,
          t.wifi_rssi, t.firmware_version
        FROM devices d
        LEFT JOIN LATERAL (
          SELECT battery_level, battery_voltage, power_source, battery_status,
                 wifi_rssi, firmware_version
          FROM telemetry WHERE mac = d.mac ORDER BY timestamp DESC LIMIT 1
        ) t ON true
        ${filter}
        ORDER BY d.last_seen DESC NULLS LAST
      `),
    macs ? "device-live-snapshot" : "devices-with-latest-telemetry"
  );
  return result.rows as DeviceSnapshot[];
}
