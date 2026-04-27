// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useTransition } from "react";
import { updateDevice } from "../../actions";
import { useToast } from "@/components/toast";

interface Device {
  mac: string;
  status: string;
  displayCaps: unknown;
  contentInstanceId: string | null;
  themeId: string | null;
  refreshProfileId: string | null;
  approvedAt: Date | null;
  lastSeen: Date | null;
  createdAt: Date;
}

interface TelemetryEntry {
  id: number;
  batteryVoltage: number | null;
  batteryLevel: number | null;
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

export function DeviceDetail({ device, telemetryHistory, recentReports, themes, contentInstances, refreshProfiles }: Props) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const caps = device.displayCaps as { model?: string; width?: number; height?: number; quantize?: string } | null;
  const latest = telemetryHistory[0];

  function handleUpdate(data: { contentInstanceId?: string | null; themeId?: string | null; refreshProfileId?: string | null }) {
    startTransition(async () => {
      try { await updateDevice(device.mac, data); toast("success", "Device updated"); }
      catch { toast("error", "Update failed"); }
    });
  }

  return (
    <div className={pending ? "opacity-60 pointer-events-none" : ""}>
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <h1 className="text-2xl font-bold font-mono">{device.mac}</h1>
        <Badge label={device.status}
          color={device.status === "approved" ? "bg-green-100 text-green-800" :
                 device.status === "pending" ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Telemetry */}
        <Card title="Telemetry">
          {latest ? (
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Battery" value={`${latest.batteryLevel ?? "—"}%`} warn={(latest.batteryLevel ?? 100) < 20} />
              <Stat label="Voltage" value={`${latest.batteryVoltage?.toFixed(2) ?? "—"}V`} />
              <Stat label="WiFi RSSI" value={`${latest.wifiRssi ?? "—"} dBm`} warn={(latest.wifiRssi ?? 0) < -70} />
              <Stat label="Firmware" value={latest.firmwareVersion ?? "—"} />
            </div>
          ) : <p className="text-sm text-gray-400">No telemetry data yet.</p>}
        </Card>

        {/* Display */}
        <Card title="Display">
          {caps ? (
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Model" value={caps.model ?? "—"} />
              <Stat label="Resolution" value={caps.width && caps.height ? `${caps.width}×${caps.height}` : "—"} />
              <Stat label="Quantize" value={caps.quantize ?? "—"} />
            </div>
          ) : <p className="text-sm text-gray-400">Display capabilities not reported yet.</p>}
        </Card>

        {/* Timestamps */}
        <Card title="Timeline">
          <div className="space-y-2 text-sm">
            <div><span className="text-gray-500">Registered:</span> {new Date(device.createdAt).toLocaleString("de-DE")}</div>
            {device.approvedAt && <div><span className="text-gray-500">Approved:</span> {new Date(device.approvedAt).toLocaleString("de-DE")}</div>}
            <div><span className="text-gray-500">Last Seen:</span> {device.lastSeen ? new Date(device.lastSeen).toLocaleString("de-DE") : "—"}</div>
          </div>
        </Card>
      </div>

      {/* Assignments */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Card title="Content Assignment">
          <select className="w-full border rounded px-3 py-2 text-sm" aria-label="Content assignment" value={device.contentInstanceId ?? ""}
            onChange={(e) => handleUpdate({ contentInstanceId: e.target.value || null })}>
            <option value="">— none —</option>
            {contentInstances.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Card>
        <Card title="Theme Assignment">
          <select className="w-full border rounded px-3 py-2 text-sm" aria-label="Theme assignment" value={device.themeId ?? ""}
            onChange={(e) => handleUpdate({ themeId: e.target.value || null })}>
            <option value="">— default —</option>
            {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Card>
        <Card title="Refresh Profile">
          <select className="w-full border rounded px-3 py-2 text-sm" aria-label="Refresh profile" value={device.refreshProfileId ?? ""}
            onChange={(e) => handleUpdate({ refreshProfileId: e.target.value || null })}>
            <option value="">— default —</option>
            {refreshProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Card>
      </div>

      {/* Telemetry History */}
      <Card title={`Telemetry History (last ${telemetryHistory.length})`}>
        {telemetryHistory.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-gray-500">
                <tr>
                  <th className="pr-4 py-1">Time</th>
                  <th className="pr-4 py-1">Battery</th>
                  <th className="pr-4 py-1">Voltage</th>
                  <th className="pr-4 py-1">RSSI</th>
                  <th className="pr-4 py-1">Firmware</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {telemetryHistory.map((t) => (
                  <tr key={t.id}>
                    <td className="pr-4 py-1 text-gray-500">{new Date(t.timestamp).toLocaleString("de-DE")}</td>
                    <td className={`pr-4 py-1 ${(t.batteryLevel ?? 100) < 20 ? "text-red-600 font-medium" : ""}`}>{t.batteryLevel ?? "—"}%</td>
                    <td className="pr-4 py-1">{t.batteryVoltage?.toFixed(2) ?? "—"}V</td>
                    <td className={`pr-4 py-1 ${(t.wifiRssi ?? 0) < -70 ? "text-red-600 font-medium" : ""}`}>{t.wifiRssi ?? "—"} dBm</td>
                    <td className="pr-4 py-1 text-gray-500">{t.firmwareVersion ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-gray-400">No telemetry data.</p>}
      </Card>

      {/* Reports */}
      {recentReports.length > 0 && (
        <div className="mt-4">
          <Card title="Recent Reports">
            <div className="space-y-2">
              {recentReports.map((r) => (
                <div key={r.id} className="flex justify-between text-sm border-b pb-2">
                  <span>{r.issue ?? "—"}</span>
                  <span className="text-xs text-gray-400">{new Date(r.timestamp).toLocaleString("de-DE")}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
