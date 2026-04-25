"use client";

import { useTransition } from "react";
import { updateDevice } from "../actions";
import { useToast } from "@/components/toast";
import { PageHeader } from "@/components/page-header";

interface FirmwareVersion {
  version: string;
  channel: "stable" | "beta";
  date: string;
}

interface Device {
  mac: string;
  firmwareChannel: string | null;
  firmwarePinVersion: string | null;
  displayCaps: unknown;
}

interface Props {
  devices: Device[];
  versions: FirmwareVersion[];
}

export function FirmwarePage({ devices, versions }: Props) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();

  function setChannel(mac: string, channel: string) {
    startTransition(async () => {
      try { await updateDevice(mac, { firmwareChannel: channel }); toast("success", "Updated"); }
      catch { toast("error", "Failed to update"); }
    });
  }

  function pinVersion(mac: string, version: string | null) {
    startTransition(async () => {
      try { await updateDevice(mac, { firmwarePinVersion: version }); toast("success", "Updated"); }
      catch { toast("error", "Failed to update"); }
    });
  }

  const stableVersions = versions.filter((v) => v.channel === "stable");
  const betaVersions = versions.filter((v) => v.channel === "beta");

  return (
    <div className={pending ? "opacity-60 pointer-events-none" : ""}>
      <PageHeader title="Firmware" description="OTA firmware updates via GitHub Releases" actions={<a href="/admin/firmware/flash" className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">Flash Device</a>} />

      {/* Available versions */}
      <h2 className="text-lg font-semibold mb-3">Available Versions</h2>
      <div className="bg-white rounded-lg shadow divide-y mb-8">
        {versions.length === 0 && (
          <div className="px-4 py-8 text-center text-gray-500">No firmware releases found on GitHub</div>
        )}
        {versions.map((v) => (
          <div key={v.version + v.channel} className="px-4 py-3 flex items-center gap-3">
            <span className="font-mono text-sm font-semibold">v{v.version}</span>
            <span className={`text-xs px-2 py-0.5 rounded ${v.channel === "stable" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
              {v.channel}
            </span>
            <span className="text-xs text-gray-500">{new Date(v.date).toLocaleDateString("de-DE")}</span>
          </div>
        ))}
      </div>

      {/* Device assignments */}
      <h2 className="text-lg font-semibold mb-3">Device Firmware</h2>
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Device</th>
              <th className="px-4 py-3 font-medium">Model</th>
              <th className="px-4 py-3 font-medium">Channel</th>
              <th className="px-4 py-3 font-medium">Pin Version</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {devices.map((d) => {
              const caps = d.displayCaps as { model?: string } | null;
              const channel = d.firmwareChannel ?? "stable";
              const channelVersions = channel === "beta" ? [...stableVersions, ...betaVersions] : stableVersions;
              return (
                <tr key={d.mac} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs"><a href={`/admin/devices/${d.mac}`} className="text-blue-600 hover:underline">{d.mac}</a></td>
                  <td className="px-4 py-3 text-xs text-gray-500">{caps?.model ?? "—"}</td>
                  <td className="px-4 py-3">
                    <select className="text-xs border rounded px-2 py-1" aria-label="Firmware channel"
                      value={channel}
                      onChange={(e) => setChannel(d.mac, e.target.value)}>
                      <option value="stable">stable</option>
                      <option value="beta">beta</option>
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <select className="text-xs border rounded px-2 py-1" aria-label="Pin version"
                      value={d.firmwarePinVersion ?? ""}
                      onChange={(e) => pinVersion(d.mac, e.target.value || null)}>
                      <option value="">— latest —</option>
                      {channelVersions.map((v) => (
                        <option key={v.version} value={v.version}>
                          v{v.version} ({v.channel})
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
