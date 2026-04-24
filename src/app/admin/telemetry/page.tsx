import { sql } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";

export default async function TelemetryPage() {
  // Get latest telemetry per device via a subquery
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (d.mac)
      d.mac,
      d.status,
      d.display_caps->>'model' as display_model,
      t.battery_level,
      t.battery_voltage,
      t.wifi_rssi,
      t.firmware_version,
      t.timestamp as last_report,
      d.last_seen
    FROM devices d
    LEFT JOIN telemetry t ON t.mac = d.mac
    ORDER BY d.mac, t.timestamp DESC
  `);

  const deviceRows = (rows.rows ?? []) as Array<{
    mac: string; status: string; display_model: string | null;
    battery_level: number | null; battery_voltage: number | null;
    wifi_rssi: number | null; firmware_version: string | null;
    last_report: Date | null; last_seen: Date | null;
  }>;

  const warnings = deviceRows.filter((d) =>
    (d.battery_level !== null && d.battery_level < 20) ||
    (d.wifi_rssi !== null && d.wifi_rssi < -70) ||
    (d.last_seen && Date.now() - new Date(d.last_seen).getTime() > 3600_000)
  );

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Telemetry Overview</h1>

      {warnings.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <h2 className="text-sm font-semibold text-red-800 mb-2">⚠ Warnings ({warnings.length})</h2>
          <div className="space-y-1">
            {warnings.map((d) => (
              <div key={d.mac} className="text-sm text-red-700 flex gap-3">
                <Link href={`/admin/devices/${d.mac}`} className="font-mono text-xs hover:underline">{d.mac}</Link>
                {d.battery_level !== null && d.battery_level < 20 && <span>🔋 Battery {d.battery_level}%</span>}
                {d.wifi_rssi !== null && d.wifi_rssi < -70 && <span>📶 RSSI {d.wifi_rssi} dBm</span>}
                {d.last_seen && Date.now() - new Date(d.last_seen).getTime() > 3600_000 && <span>⏱ Offline &gt;1h</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Device</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Display</th>
              <th className="px-4 py-3 font-medium">Battery</th>
              <th className="px-4 py-3 font-medium">Voltage</th>
              <th className="px-4 py-3 font-medium">RSSI</th>
              <th className="px-4 py-3 font-medium">Firmware</th>
              <th className="px-4 py-3 font-medium">Last Seen</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {deviceRows.map((d) => {
              const batteryWarn = d.battery_level !== null && d.battery_level < 20;
              const rssiWarn = d.wifi_rssi !== null && d.wifi_rssi < -70;
              const offlineWarn = d.last_seen && Date.now() - new Date(d.last_seen).getTime() > 3600_000;
              return (
                <tr key={d.mac} className={`hover:bg-gray-50 ${batteryWarn || rssiWarn || offlineWarn ? "bg-red-50/50" : ""}`}>
                  <td className="px-4 py-3 font-mono text-xs">
                    <Link href={`/admin/devices/${d.mac}`} className="text-blue-600 hover:underline">{d.mac}</Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      d.status === "approved" ? "bg-green-100 text-green-800" :
                      d.status === "pending" ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"
                    }`}>{d.status}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{d.display_model ?? "—"}</td>
                  <td className={`px-4 py-3 ${batteryWarn ? "text-red-600 font-semibold" : ""}`}>
                    {d.battery_level !== null ? `${d.battery_level}%` : "—"}
                  </td>
                  <td className="px-4 py-3">{d.battery_voltage !== null ? `${Number(d.battery_voltage).toFixed(2)}V` : "—"}</td>
                  <td className={`px-4 py-3 ${rssiWarn ? "text-red-600 font-semibold" : ""}`}>
                    {d.wifi_rssi !== null ? `${d.wifi_rssi} dBm` : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{d.firmware_version ?? "—"}</td>
                  <td className={`px-4 py-3 text-xs ${offlineWarn ? "text-red-600 font-semibold" : "text-gray-500"}`}>
                    {d.last_seen ? new Date(d.last_seen).toLocaleString("de-DE") : "—"}
                  </td>
                </tr>
              );
            })}
            {deviceRows.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-12 text-center text-gray-400">No devices with telemetry data.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
