"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { SearchInput } from "@/components/search-input";
import { EmptyState } from "@/components/empty-state";

interface Row {
  mac: string; status: string; display_model: string | null;
  battery_level: number | null; battery_voltage: number | null;
  wifi_rssi: number | null; firmware_version: string | null;
  last_report: string | null; last_seen: string | null;
}

export function TelemetryView({ rows: rawRows }: { rows: Record<string, unknown>[] }) {
  const [search, setSearch] = useState("");
  const rows = rawRows as unknown as Row[];

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return rows.filter(d => !q || d.mac.toLowerCase().includes(q) || (d.display_model ?? "").toLowerCase().includes(q) || (d.firmware_version ?? "").toLowerCase().includes(q));
  }, [rows, search]);

  return (
    <div>
      <PageHeader title="Telemetry" description="Monitor device health and connectivity"
        actions={<SearchInput value={search} onChange={setSearch} placeholder="Search MAC, model, firmware..." />} />

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="px-4 py-3 font-medium w-6"></th>
              <th className="px-4 py-3 font-medium">Device</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Model</th>
              <th className="px-4 py-3 font-medium">Battery</th>
              <th className="px-4 py-3 font-medium">Voltage</th>
              <th className="px-4 py-3 font-medium">RSSI</th>
              <th className="px-4 py-3 font-medium">Firmware</th>
              <th className="px-4 py-3 font-medium">Last Seen</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map((d) => {
              const bWarn = d.battery_level !== null && d.battery_level < 20;
              const rWarn = d.wifi_rssi !== null && d.wifi_rssi < -70;
              const oWarn = d.last_seen ? Date.now() - new Date(d.last_seen + "Z").getTime() > 3600_000 : false;
              const hasWarning = bWarn || rWarn || oWarn;
              return (
                <tr key={d.mac} className="hover:bg-gray-50">
                  <td className="px-2 py-3 text-center">{hasWarning ? <span title={[bWarn && "Low battery", rWarn && "Weak signal", oWarn && "Offline >1h"].filter(Boolean).join(", ")}>⚠️</span> : ""}</td>
                  <td className="px-4 py-3 font-mono text-xs"><Link href={`/admin/devices/${d.mac}`} className="text-blue-600 hover:underline">{d.mac}</Link></td>
                  <td className="px-4 py-3"><span className={`px-2 py-1 rounded text-xs font-medium ${d.status === "approved" ? "bg-green-100 text-green-800" : d.status === "pending" ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"}`}>{d.status}</span></td>
                  <td className="px-4 py-3 text-xs text-gray-500">{d.display_model ?? "—"}</td>
                  <td className={`px-4 py-3 ${bWarn ? "text-amber-600 font-semibold" : ""}`}>{d.battery_level !== null ? `${d.battery_level}%` : "—"}</td>
                  <td className="px-4 py-3">{d.battery_voltage !== null ? `${Number(d.battery_voltage).toFixed(2)}V` : "—"}</td>
                  <td className={`px-4 py-3 ${rWarn ? "text-amber-600 font-semibold" : ""}`}>{d.wifi_rssi !== null ? `${d.wifi_rssi} dBm` : "—"}</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{d.firmware_version ?? "—"}</td>
                  <td className={`px-4 py-3 text-xs ${oWarn ? "text-amber-600 font-semibold" : "text-gray-500"}`}>{d.last_seen ? new Date(d.last_seen + "Z").toLocaleString("de-DE") : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <EmptyState icon="📊" title={rows.length === 0 ? "No telemetry data" : "No devices match"} description={rows.length === 0 ? "Telemetry data appears when devices connect and report." : undefined} />
        )}
      </div>
    </div>
  );
}
