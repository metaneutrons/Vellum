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
  const [previewId, setPreviewId] = useState<string | null>(null);

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

      <div className="space-y-3">
        {filtered.map((d) => {
          const caps = d.display_caps as { model?: string; width?: number; height?: number } | null;
          const model = caps?.model?.toUpperCase() ?? "—";
          const bWarn = d.battery_level !== null && d.battery_level < 20;
          const rWarn = d.wifi_rssi !== null && d.wifi_rssi < -70;
          const lastSeen = d.last_seen ? new Date(d.last_seen + "Z") : null;
          const oWarn = lastSeen ? Date.now() - lastSeen.getTime() > 3600_000 : false;
          const hasWarning = bWarn || rWarn || oWarn;
          const channel = d.firmware_channel ?? "stable";
          const channelVersions = channel === "beta" ? [...stableVersions, ...betaVersions] : stableVersions;
          const hasContent = d.content_instance_id && d.status === "approved";
          const contentName = contentInstances.find((c) => c.id === d.content_instance_id)?.name;

          return (
            <div key={d.mac} className="bg-white rounded-lg shadow">
              <div className="flex gap-4 p-4">
                {/* Preview thumbnail */}
                <div className="shrink-0">
                  {hasContent ? (
                    <button onClick={() => setPreviewId(d.content_instance_id)}
                      className="block w-20 h-12 rounded border border-gray-200 hover:border-blue-400 overflow-hidden cursor-pointer transition-colors"
                      title="Click to preview">
                      <img src={`/api/v1/admin/preview?instanceId=${d.content_instance_id}&w=160&h=96`}
                        alt="" className="w-full h-full object-cover" loading="lazy" />
                    </button>
                  ) : (
                    <div className="w-20 h-12 rounded border border-dashed border-gray-300 flex items-center justify-center text-gray-300 text-xs">
                      No content
                    </div>
                  )}
                </div>

                {/* Device info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {hasWarning && <span className="text-sm" title={[bWarn && "Low battery", rWarn && "Weak signal", oWarn && "Offline >1h"].filter(Boolean).join(", ")}>⚠️</span>}
                    <span className="font-mono text-sm font-semibold tracking-tight">{d.mac}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${d.status === "approved" ? "bg-green-100 text-green-700" : d.status === "pending" ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700"}`}>{d.status}</span>
                    <span className="text-xs text-gray-500">{model}</span>
                    {caps?.width && <span className="text-[11px] text-gray-400">{caps.width}×{caps.height}</span>}
                    {contentName && <span className="text-xs text-blue-600">→ {contentName}</span>}
                  </div>

                  {/* Telemetry row */}
                  <div className="flex items-center gap-3 mt-1.5 text-[11px] text-gray-500">
                    {d.battery_level !== null && (
                      <span className={bWarn ? "text-amber-600 font-medium" : ""}>
                        🔋 {d.battery_level}%
                        <span className="text-gray-400 ml-0.5">({Number(d.battery_voltage ?? 0).toFixed(2)}V)</span>
                      </span>
                    )}
                    {d.wifi_rssi !== null && (
                      <span className={rWarn ? "text-amber-600 font-medium" : ""}>📶 {d.wifi_rssi}dBm</span>
                    )}
                    {d.firmware_version && <span>v{d.firmware_version}</span>}
                    {lastSeen && (
                      <span className={oWarn ? "text-amber-600" : ""}>
                        {lastSeen.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-start gap-1 shrink-0">
                  {d.status === "pending" && <Button size="sm" onClick={() => act(() => approveDevice(d.mac), "Approved", "Failed")}>Approve</Button>}
                  <Button size="sm" variant="danger" onClick={() => setDeleting(d.mac)}>×</Button>
                </div>
              </div>

              {/* Assignments row — only for approved devices */}
              {d.status === "approved" && (
                <div className="flex items-center gap-3 px-4 py-2 border-t border-gray-100 bg-gray-50/50 text-[11px] flex-wrap">
                  <label className="flex items-center gap-1 text-gray-600">
                    Content
                    <select className="border rounded px-1 py-0.5 text-[11px]" value={d.content_instance_id ?? ""}
                      aria-label="Content" onChange={(e) => update(d.mac, { contentInstanceId: e.target.value || null })}>
                      <option value="">—</option>
                      {contentInstances.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center gap-1 text-gray-600">
                    Theme
                    <select className="border rounded px-1 py-0.5 text-[11px]" value={d.theme_id ?? ""}
                      aria-label="Theme" onChange={(e) => update(d.mac, { themeId: e.target.value || null })}>
                      <option value="">default</option>
                      {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center gap-1 text-gray-600">
                    Profile
                    <select className="border rounded px-1 py-0.5 text-[11px]" value={d.refresh_profile_id ?? ""}
                      aria-label="Refresh profile" onChange={(e) => update(d.mac, { refreshProfileId: e.target.value || null })}>
                      <option value="">default</option>
                      {refreshProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>
                  <span className="text-gray-400">|</span>
                  <label className="flex items-center gap-1 text-gray-600">
                    FW
                    <select className="border rounded px-1 py-0.5 text-[11px]" value={channel}
                      aria-label="Firmware channel" onChange={(e) => update(d.mac, { firmwareChannel: e.target.value })}>
                      <option value="stable">stable</option>
                      <option value="beta">beta</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1 text-gray-600">
                    Pin
                    <select className="border rounded px-1 py-0.5 text-[11px]" value={d.firmware_pin_version ?? ""}
                      aria-label="Pin version" onChange={(e) => update(d.mac, { firmwarePinVersion: e.target.value || null })}>
                      <option value="">latest</option>
                      {channelVersions.map((v) => <option key={v.tag} value={v.version}>v{v.version}</option>)}
                    </select>
                  </label>
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <EmptyState icon="◻" title={devices.length === 0 ? "No devices" : "No match"} description="Devices appear when they connect." />
        )}
      </div>

      {/* Full-size preview modal */}
      {previewId && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-8 cursor-pointer"
          onClick={() => setPreviewId(null)}
          onKeyDown={(e) => e.key === "Escape" && setPreviewId(null)}
          tabIndex={0}
          role="button"
          aria-label="Close preview">
          <img src={`/api/v1/admin/preview?instanceId=${previewId}`} alt="Preview"
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" />
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          open={!!deleting}
          title="Delete device?"
          message={`Remove ${deleting} and all telemetry?`}
          confirmLabel="Delete"
          destructive
          onConfirm={() => { act(() => deleteDevice(deleting!), "Deleted", "Failed"); setDeleting(null); }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
