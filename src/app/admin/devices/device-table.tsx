"use client";

import { useState, useTransition } from "react";
import { approveDevice, updateDevice, deleteDevice } from "../actions";
import { useToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm";
import { Button } from "@/components/button";
import { SearchInput } from "@/components/search-input";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";

interface Device {
  mac: string;
  status: string;
  content_instance_id: string | null;
  theme_id: string | null;
  refresh_profile_id: string | null;
  firmware_channel: string | null;
  firmware_pin_version: string | null;
  display_caps: unknown;
  last_seen: string | null;
  battery_level: number | null;
  battery_voltage: number | null;
  wifi_rssi: number | null;
  firmware_version: string | null;
}

interface FirmwareVersion {
  version: string;
  channel: string;
  tag: string;
}

interface Props {
  devices: Record<string, unknown>[];
  themes: { id: string; name: string }[];
  contentInstances: { id: string; name: string }[];
  refreshProfiles: { id: string; name: string }[];
  firmwareVersions: FirmwareVersion[];
}

export function DeviceTable({ devices: rawDevices, themes, contentInstances, refreshProfiles, firmwareVersions }: Props) {
  const devices = rawDevices as unknown as Device[];
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [previewMac, setPreviewMac] = useState<string | null>(null);

  function act(fn: () => Promise<unknown>, ok: string, fail: string) {
    startTransition(async () => {
      try { await fn(); toast("success", ok); } catch { toast("error", fail); }
    });
  }

  function update(mac: string, data: Record<string, unknown>) {
    act(() => updateDevice(mac, data), "Updated", "Failed");
  }

  const filtered = devices.filter((d) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return d.mac.toLowerCase().includes(q) ||
      (d.firmware_version ?? "").toLowerCase().includes(q) ||
      ((d.display_caps as { model?: string })?.model ?? "").includes(q);
  });

  const stableVersions = firmwareVersions.filter((v) => v.channel === "stable");
  const betaVersions = firmwareVersions.filter((v) => v.channel === "beta");

  return (
    <div className={pending ? "opacity-60 pointer-events-none" : ""}>
      <PageHeader title="Devices" description="Manage displays, content, and firmware"
        actions={<SearchInput value={search} onChange={setSearch} placeholder="Search MAC, model, firmware..." />} />

      <div className="space-y-4">
        {filtered.map((d) => {
          const caps = d.display_caps as { model?: string; width?: number; height?: number } | null;
          const model = caps?.model ?? "—";
          const bWarn = d.battery_level !== null && d.battery_level < 20;
          const rWarn = d.wifi_rssi !== null && d.wifi_rssi < -70;
          const lastSeen = d.last_seen ? new Date(d.last_seen + "Z") : null;
          const oWarn = lastSeen ? Date.now() - lastSeen.getTime() > 3600_000 : false;
          const hasWarning = bWarn || rWarn || oWarn;
          const channel = d.firmware_channel ?? "stable";
          const channelVersions = channel === "beta" ? [...stableVersions, ...betaVersions] : stableVersions;

          return (
            <div key={d.mac} className="bg-white rounded-lg shadow overflow-hidden">
              {/* Row 1: MAC, status, model, telemetry */}
              <div className="flex items-center gap-4 px-4 py-3 border-b">
                {/* Preview thumbnail */}
                <button onClick={() => setPreviewMac(d.mac)} className="shrink-0 w-16 h-10 bg-gray-100 rounded border hover:border-blue-400 overflow-hidden cursor-pointer" title="Click to preview">
                  {d.content_instance_id && d.status === "approved" ? (
                    <img src={`/api/v1/admin/preview?mac=${d.mac}&w=160&h=100`} alt="preview" className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <span className="flex items-center justify-center h-full text-gray-400 text-xs">—</span>
                  )}
                </button>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {hasWarning && <span title={[bWarn && "Low battery", rWarn && "Weak signal", oWarn && "Offline >1h"].filter(Boolean).join(", ")}>⚠️</span>}
                    <span className="font-mono text-sm font-semibold">{d.mac}</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${d.status === "approved" ? "bg-green-100 text-green-800" : d.status === "pending" ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800"}`}>{d.status}</span>
                    <span className="text-xs text-gray-500">{model}</span>
                    {caps?.width && <span className="text-xs text-gray-400">{caps.width}×{caps.height}</span>}
                  </div>
                  <div className="flex items-center gap-4 mt-1 text-xs text-gray-500">
                    {d.battery_level !== null && <span className={bWarn ? "text-amber-600 font-semibold" : ""}>🔋 {d.battery_level}% ({Number(d.battery_voltage ?? 0).toFixed(2)}V)</span>}
                    {d.wifi_rssi !== null && <span className={rWarn ? "text-amber-600 font-semibold" : ""}>📶 {d.wifi_rssi} dBm</span>}
                    {d.firmware_version && <span>FW {d.firmware_version}</span>}
                    {lastSeen && <span className={oWarn ? "text-amber-600" : ""}>Seen: {lastSeen.toLocaleString("de-DE")}</span>}
                  </div>
                </div>

                <div className="flex gap-1 shrink-0">
                  {d.status === "pending" && <Button size="sm" onClick={() => act(() => approveDevice(d.mac), "Approved", "Failed")}>Approve</Button>}
                </div>
              </div>

              {/* Row 2: Assignments */}
              {d.status === "approved" && (
                <div className="flex items-center gap-4 px-4 py-2 text-xs bg-gray-50">
                  <label className="flex items-center gap-1">
                    Content:
                    <select className="border rounded px-1 py-0.5" value={d.content_instance_id ?? ""}
                      aria-label="Content" onChange={(e) => update(d.mac, { contentInstanceId: e.target.value || null })}>
                      <option value="">— none —</option>
                      {contentInstances.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center gap-1">
                    Theme:
                    <select className="border rounded px-1 py-0.5" value={d.theme_id ?? ""}
                      aria-label="Theme" onChange={(e) => update(d.mac, { themeId: e.target.value || null })}>
                      <option value="">— default —</option>
                      {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center gap-1">
                    Profile:
                    <select className="border rounded px-1 py-0.5" value={d.refresh_profile_id ?? ""}
                      aria-label="Refresh profile" onChange={(e) => update(d.mac, { refreshProfileId: e.target.value || null })}>
                      <option value="">— default —</option>
                      {refreshProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center gap-1">
                    FW:
                    <select className="border rounded px-1 py-0.5" value={channel}
                      aria-label="Firmware channel" onChange={(e) => update(d.mac, { firmwareChannel: e.target.value })}>
                      <option value="stable">stable</option>
                      <option value="beta">beta</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1">
                    Pin:
                    <select className="border rounded px-1 py-0.5" value={d.firmware_pin_version ?? ""}
                      aria-label="Pin version" onChange={(e) => update(d.mac, { firmwarePinVersion: e.target.value || null })}>
                      <option value="">— latest —</option>
                      {channelVersions.map((v) => <option key={v.tag} value={v.version}>v{v.version} ({v.channel})</option>)}
                    </select>
                  </label>
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <EmptyState icon="◻" title={devices.length === 0 ? "No devices" : "No devices match"} description="Devices appear when they connect and perform the hello handshake." />
        )}
      </div>

      {/* Preview modal */}
      {previewMac && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setPreviewMac(null)}>
          <div className="bg-white rounded-lg p-2 max-w-4xl max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <img src={`/api/v1/admin/preview?mac=${previewMac}`} alt="Display preview" className="max-w-full max-h-[85vh] object-contain" />
            <div className="text-center mt-2 text-xs text-gray-500">{previewMac}</div>
          </div>
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          open={!!deleting}
          title="Delete device?"
          message={`Remove ${deleting} and all its telemetry data?`}
          confirmLabel="Delete"
          destructive
          onConfirm={() => { act(() => deleteDevice(deleting!), "Deleted", "Failed"); setDeleting(null); }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
