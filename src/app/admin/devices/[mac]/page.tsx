// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { eq, desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { db, withDbRead } from "@/db";
import { deviceConfigurationCommands, deviceLogs, devices, telemetry, reports } from "@/db/schema";
import { DeviceDetail } from "./detail";
import {
  getAllThemes,
  getAllContentInstances,
  getAllRefreshProfiles,
  getAllSites,
} from "../../actions";
import { getCurrentPrincipal, hasPermission } from "@/lib/access";
import { explainDeviceSettings } from "@/lib/settings/for-device";

export default async function DeviceDetailPage({ params }: { params: Promise<{ mac: string }> }) {
  const { mac } = await params;
  const principal = await getCurrentPrincipal();

  const [device] = await withDbRead(
    () => db.select().from(devices).where(eq(devices.mac, mac)).limit(1),
    "device-detail-get"
  );
  if (!device) notFound();

  const [
    recentTelemetry,
    recentReports,
    themeList,
    contentList,
    profileList,
    siteList,
    configCommands,
    logBatches,
  ] = await Promise.all([
    withDbRead(
      () =>
        db
          .select()
          .from(telemetry)
          .where(eq(telemetry.mac, mac))
          .orderBy(desc(telemetry.timestamp))
          .limit(50),
      "device-detail-telemetry"
    ),
    withDbRead(
      () =>
        db
          .select()
          .from(reports)
          .where(eq(reports.mac, mac))
          .orderBy(desc(reports.timestamp))
          .limit(10),
      "device-detail-reports"
    ),
    getAllThemes(),
    getAllContentInstances(),
    getAllRefreshProfiles(),
    getAllSites(),
    withDbRead(
      () =>
        db
          .select()
          .from(deviceConfigurationCommands)
          .where(eq(deviceConfigurationCommands.mac, mac))
          .orderBy(desc(deviceConfigurationCommands.createdAt))
          .limit(5),
      "device-detail-configuration-commands"
    ),
    /* Newest first, and only a handful: uploads are event-driven, so a device
     * with several batches is a device that had several incidents. */
    withDbRead(
      () =>
        db
          .select()
          .from(deviceLogs)
          .where(eq(deviceLogs.mac, mac))
          .orderBy(desc(deviceLogs.receivedAt))
          .limit(10),
      "device-detail-log-batches"
    ),
  ]);

  /* Resolved with the workspace defaults included, so the page can name where
     each value comes from instead of leaving an operator to infer it. */
  const effective = await explainDeviceSettings(device);

  return (
    <div>
      <Link
        href="/admin/devices"
        className="text-sm text-blue-600 hover:underline mb-4 inline-block"
      >
        ← Back to Devices
      </Link>
      <DeviceDetail
        device={device}
        telemetryHistory={recentTelemetry}
        recentReports={recentReports}
        themes={themeList}
        contentInstances={contentList}
        refreshProfiles={profileList}
        sites={siteList}
        effective={effective}
        logBatches={logBatches}
        configurationCommands={configCommands.map((command) => ({
          ...command,
          payload:
            command.kind === "wifi"
              ? { ssid: (command.payload as { ssid?: string }).ssid }
              : command.payload,
        }))}
        canProvision={hasPermission(principal, "devices.provision")}
      />
    </div>
  );
}
