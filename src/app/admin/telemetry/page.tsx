// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { TelemetryView } from "./telemetry-view";

export default async function TelemetryPage() {
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (d.mac)
      d.mac, d.status,
      d.display_caps->>'model' as display_model,
      t.battery_level, t.battery_voltage, t.wifi_rssi,
      t.firmware_version, t.timestamp as last_report, d.last_seen
    FROM devices d
    LEFT JOIN telemetry t ON t.mac = d.mac
    ORDER BY d.mac, t.timestamp DESC
  `);
  return <TelemetryView rows={rows.rows as Record<string, unknown>[]} />;
}
