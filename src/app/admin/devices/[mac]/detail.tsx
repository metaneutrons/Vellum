// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { updateDevice } from "../../actions";
import { useToast } from "@/components/toast";
import { deviceConnectivity } from "@/lib/connectivity";

interface Device {
  mac: string;
  status: string;
  displayCaps: unknown;
  contentInstanceId: string | null;
  themeId: string | null;
  refreshProfileId: string | null;
  approvedAt: Date | null;
  lastSeen: Date | null;
  expectedIntervalS: number | null;
  createdAt: Date;
}

interface TelemetryEntry {
  id: number;
  batteryVoltage: number | null;
  batteryLevel: number | null;
  powerSource: "usb" | "battery" | null;
  batteryStatus: "charging" | "full" | "discharging" | "unknown" | null;
  wifiRssi: number | null;
  firmwareVersion: string | null;
  timestamp: Date;
}

interface Report {
  id: number;
  issue: string | null;
  timestamp: Date;
}

interface Props {
  device: Device;
  telemetryHistory: TelemetryEntry[];
  recentReports: Report[];
  themes: { id: string; name: string }[];
  contentInstances: { id: string; name: string }[];
  refreshProfiles: { id: string; name: string }[];
}

function Badge({ label, color }: { label: string; color: string }) {
  return <span className={`px-2 py-1 rounded text-xs font-medium ${color}`}>{label}</span>;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg shadow p-5">
      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-semibold ${warn ? "text-red-600" : ""}`}>{value}</div>
    </div>
  );
}

export function DeviceDetail({
  device,
  telemetryHistory,
  recentReports,
  themes,
  contentInstances,
  refreshProfiles,
}: Props) {
  const t = useTranslations("devices");
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const caps = device.displayCaps as {
    model?: string;
    width?: number;
    height?: number;
    quantize?: string;
  } | null;
  const latest = telemetryHistory[0];

  // Connectivity (liveness) is separate from authorization status, and judged
  // against the device's own expected cadence — see src/lib/connectivity.ts.
  const connState = deviceConnectivity(
    device.lastSeen ? new Date(device.lastSeen).getTime() : null,
    device.expectedIntervalS,
    Date.now()
  );
  const conn = {
    online: { label: "Online", color: "bg-green-100 text-green-800" },
    late: { label: "Late", color: "bg-yellow-100 text-yellow-800" },
    offline: { label: "Offline", color: "bg-red-100 text-red-800" },
    never: { label: "Never seen", color: "bg-gray-100 text-gray-700" },
  }[connState];

  function handleUpdate(data: {
    contentInstanceId?: string | null;
    themeId?: string | null;
    refreshProfileId?: string | null;
  }) {
    startTransition(async () => {
      try {
        await updateDevice(device.mac, data);
        toast("success", "Device updated");
      } catch {
        toast("error", "Update failed");
      }
    });
  }

  return (
    <div className={pending ? "opacity-60 pointer-events-none" : ""}>
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <h1 className="text-2xl font-bold font-mono">{device.mac}</h1>
        <Badge
          label={device.status}
          color={
            device.status === "approved"
              ? "bg-blue-100 text-blue-800"
              : device.status === "pending"
                ? "bg-yellow-100 text-yellow-800"
                : "bg-red-100 text-red-800"
          }
        />
        <Badge label={conn.label} color={conn.color} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Telemetry */}
        <Card title={t("telemetry")}>
          {latest ? (
            <div className="grid grid-cols-2 gap-4">
              <Stat
                label={t("battery")}
                value={`${latest.batteryLevel ?? "—"}%`}
                warn={(latest.batteryLevel ?? 100) < 20}
              />
              <Stat label={t("voltage")} value={`${latest.batteryVoltage?.toFixed(2) ?? "—"}V`} />
              <Stat
                label={t("power.source")}
                value={
                  latest.batteryStatus && latest.batteryStatus !== "unknown"
                    ? t(`power.${latest.batteryStatus}`)
                    : latest.powerSource
                      ? t(`power.${latest.powerSource}`)
                      : "—"
                }
              />
              <Stat
                label={t("wifiRssi")}
                value={`${latest.wifiRssi ?? "—"} dBm`}
                warn={(latest.wifiRssi ?? 0) < -70}
              />
              <Stat label={t("firmware")} value={latest.firmwareVersion ?? "—"} />
            </div>
          ) : (
            <p className="text-sm text-gray-400">{t("noTelemetry")}</p>
          )}
        </Card>

        {/* Display */}
        <Card title={t("display")}>
          {caps ? (
            <div className="grid grid-cols-2 gap-4">
              <Stat label={t("model")} value={caps.model ?? "—"} />
              <Stat
                label={t("resolution")}
                value={caps.width && caps.height ? `${caps.width}×${caps.height}` : "—"}
              />
              <Stat label={t("quantize")} value={caps.quantize ?? "—"} />
            </div>
          ) : (
            <p className="text-sm text-gray-400">{t("noDisplayCaps")}</p>
          )}
        </Card>

        {/* Timestamps */}
        <Card title={t("timeline")}>
          <div className="space-y-2 text-sm">
            <div>
              <span className="text-gray-500">{t("registered")}:</span>{" "}
              {new Date(device.createdAt).toLocaleString("de-DE")}
            </div>
            {device.approvedAt && (
              <div>
                <span className="text-gray-500">{t("approvedAt")}:</span>{" "}
                {new Date(device.approvedAt).toLocaleString("de-DE")}
              </div>
            )}
            <div>
              <span className="text-gray-500">{t("lastSeen")}:</span>{" "}
              {device.lastSeen ? new Date(device.lastSeen).toLocaleString("de-DE") : "—"}
            </div>
          </div>
        </Card>
      </div>

      {/* Assignments */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Card title={t("contentAssignment")}>
          <select
            className="w-full border rounded px-3 py-2 text-sm"
            aria-label={t("contentAssignment")}
            value={device.contentInstanceId ?? ""}
            onChange={(e) => handleUpdate({ contentInstanceId: e.target.value || null })}
          >
            <option value="">— none —</option>
            {contentInstances.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Card>
        <Card title={t("themeAssignment")}>
          <select
            className="w-full border rounded px-3 py-2 text-sm"
            aria-label={t("themeAssignment")}
            value={device.themeId ?? ""}
            onChange={(e) => handleUpdate({ themeId: e.target.value || null })}
          >
            <option value="">— default —</option>
            {themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Card>
        <Card title={t("refreshProfile")}>
          <select
            className="w-full border rounded px-3 py-2 text-sm"
            aria-label={t("refreshProfile")}
            value={device.refreshProfileId ?? ""}
            onChange={(e) => handleUpdate({ refreshProfileId: e.target.value || null })}
          >
            <option value="">— default —</option>
            {refreshProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Card>
      </div>

      {/* Telemetry History */}
      <Card title={`${t("telemetryHistory")} (${telemetryHistory.length})`}>
        {telemetryHistory.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="pr-4 py-1">{t("time")}</th>
                  <th className="pr-4 py-1">{t("battery")}</th>
                  <th className="pr-4 py-1">{t("voltage")}</th>
                  <th className="pr-4 py-1">{t("power.source")}</th>
                  <th className="pr-4 py-1">{t("rssi")}</th>
                  <th className="pr-4 py-1">{t("firmware")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {telemetryHistory.map((entry) => (
                  <tr key={entry.id}>
                    <td className="pr-4 py-1 text-gray-500">
                      {new Date(entry.timestamp).toLocaleString("de-DE")}
                    </td>
                    <td
                      className={`pr-4 py-1 ${(entry.batteryLevel ?? 100) < 20 ? "text-red-600 font-medium" : ""}`}
                    >
                      {entry.batteryLevel ?? "—"}%
                    </td>
                    <td className="pr-4 py-1">{entry.batteryVoltage?.toFixed(2) ?? "—"}V</td>
                    <td className="pr-4 py-1">
                      {entry.batteryStatus && entry.batteryStatus !== "unknown"
                        ? t(`power.${entry.batteryStatus}`)
                        : entry.powerSource
                          ? t(`power.${entry.powerSource}`)
                          : "—"}
                    </td>
                    <td
                      className={`pr-4 py-1 ${(entry.wifiRssi ?? 0) < -70 ? "text-red-600 font-medium" : ""}`}
                    >
                      {entry.wifiRssi ?? "—"} dBm
                    </td>
                    <td className="pr-4 py-1 text-gray-500">{entry.firmwareVersion ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-gray-400">{t("noTelemetry")}</p>
        )}
      </Card>

      {/* Reports */}
      {recentReports.length > 0 && (
        <div className="mt-4">
          <Card title={t("recentReports")}>
            <div className="space-y-2">
              {recentReports.map((r) => (
                <div key={r.id} className="flex justify-between text-sm border-b pb-2">
                  <span>{r.issue ?? "—"}</span>
                  <span className="text-xs text-gray-400">
                    {new Date(r.timestamp).toLocaleString("de-DE")}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
