// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useTransition } from "react";
import { approveDevice, updateDevice, deleteDevice, updateContentInstance } from "../actions";
import { useToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm";
import { Modal } from "@/components/modal";
import { Button } from "@/components/button";
import { SearchInput } from "@/components/search-input";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { useTranslations } from "next-intl";
import { ContentEditModal } from "./content-edit-modal";
import { BatteryChartModal } from "./battery-chart-modal";

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
  contentInstances: { id: string; name: string; typeSlug: string; config: unknown }[];
  refreshProfiles: { id: string; name: string }[];
  firmwareVersions: FirmwareVersion[];
  providers: { id: string; type: string; name: string }[];
  knownDisplays: { label: string; width: number; height: number }[];
}

export function DeviceTable({ devices: rawDevices, themes, contentInstances, refreshProfiles, firmwareVersions, providers, knownDisplays }: Props) {
  const devices = rawDevices as unknown as Device[];
  const { toast } = useToast();
  const t = useTranslations("devices");
  const [pending, startTransition] = useTransition();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState<string | null>(null);
  const [batteryMac, setBatteryMac] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);

  function act(fn: () => Promise<unknown>, ok: string, fail: string) {
    startTransition(async () => {
      try { await fn(); toast("success", ok); } catch { toast("error", fail); }
    });
  }

  function update(mac: string, data: Record<string, unknown>) {
    act(() => updateDevice(mac, data), t("updated"), t("failed"));
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
      <PageHeader title={t("title")} description={t("description")}
        actions={<SearchInput value={search} onChange={setSearch} placeholder={t("search")} />} />

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
                      className="block w-24 h-14 rounded border border-gray-200 hover:border-blue-400 overflow-hidden cursor-pointer transition-colors"
                      title={t("preview")}>
                      <img src={`/api/v1/admin/preview?instanceId=${d.content_instance_id}&mac=${d.mac}&w=192&h=112`}
                        alt="" className="w-full h-full object-cover" loading="lazy" />
                    </button>
                  ) : (
                    <div className="w-24 h-14 rounded border border-dashed border-gray-300 flex items-center justify-center text-gray-300 text-xs">
                      No content
                    </div>
                  )}
                </div>

                {/* Device info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {hasWarning && <span className="text-sm" title={[bWarn && t("warnings.lowBattery"), rWarn && t("warnings.weakSignal"), oWarn && t("warnings.offline")].filter(Boolean).join(", ")}>⚠️</span>}
                    <span className="font-mono text-sm font-semibold tracking-tight">{d.mac}</span>
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${d.status === "approved" ? "bg-green-100 text-green-700" : d.status === "pending" ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700"}`}>{d.status}</span>
                    <span className="text-xs text-gray-500">{model}</span>
                    {caps?.width && <span className="text-xs text-gray-400">{caps.width}×{caps.height}</span>}
                    {contentName && <button onClick={() => setEditingContent(d.content_instance_id)} className="text-xs text-blue-600 hover:text-blue-800 hover:underline">→ {contentName}</button>}
                  </div>

                  {/* Telemetry row */}
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-500">
                    {d.battery_level !== null && (
                      <button onClick={() => setBatteryMac(d.mac)} className={`hover:underline ${bWarn ? "text-amber-600 font-medium" : ""}`}>
                        🔋 {d.battery_level}%
                        <span className="text-gray-400 ml-0.5">({Number(d.battery_voltage ?? 0).toFixed(2)}V)</span>
                      </button>
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
                  {d.status === "pending" && <Button size="sm" onClick={() => act(() => approveDevice(d.mac), t("approved"), t("failed"))}>{t("approve")}</Button>}
                  <Button size="sm" variant="danger" onClick={() => setDeleting(d.mac)}>×</Button>
                </div>
              </div>

              {/* Assignments row — only for approved devices */}
              {d.status === "approved" && (
                <div className="flex items-center gap-3 px-4 py-2 border-t border-gray-100 bg-gray-50 dark:bg-zinc-800/50 text-xs flex-wrap">
                  <label className="flex items-center gap-1 text-gray-600 dark:text-gray-400">
                    Content
                    <select className="border rounded px-1 py-0.5 text-xs" value={d.content_instance_id ?? ""}
                      aria-label="Content" onChange={(e) => update(d.mac, { contentInstanceId: e.target.value || null })}>
                      <option value="">—</option>
                      {contentInstances.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center gap-1 text-gray-600 dark:text-gray-400">
                    Theme
                    <select className="border rounded px-1 py-0.5 text-xs" value={d.theme_id ?? ""}
                      aria-label="Theme" onChange={(e) => update(d.mac, { themeId: e.target.value || null })}>
                      <option value="">{t("default")}</option>
                      {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center gap-1 text-gray-600 dark:text-gray-400">
                    Profile
                    <select className="border rounded px-1 py-0.5 text-xs" value={d.refresh_profile_id ?? ""}
                      aria-label="Refresh profile" onChange={(e) => update(d.mac, { refreshProfileId: e.target.value || null })}>
                      <option value="">{t("default")}</option>
                      {refreshProfiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>
                  <span className="text-gray-400">|</span>
                  <label className="flex items-center gap-1 text-gray-600 dark:text-gray-400">
                    FW
                    <select className="border rounded px-1 py-0.5 text-xs" value={channel}
                      aria-label="Firmware channel" onChange={(e) => update(d.mac, { firmwareChannel: e.target.value })}>
                      <option value="stable">stable</option>
                      <option value="beta">beta</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1 text-gray-600 dark:text-gray-400">
                    Pin
                    <select className="border rounded px-1 py-0.5 text-xs" value={d.firmware_pin_version ?? ""}
                      aria-label="Pin version" onChange={(e) => update(d.mac, { firmwarePinVersion: e.target.value || null })}>
                      <option value="">{t("latest")}</option>
                      {channelVersions.map((v) => <option key={v.tag} value={v.version}>v{v.version}</option>)}
                    </select>
                  </label>
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <EmptyState icon="◻" title={devices.length === 0 ? t("noDevices") : t("noMatch")} description={t("noDevicesHint")} />
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
          title={t("deleteConfirm")}
          message={t("deleteMessage", { mac: deleting ?? "" })}
          confirmLabel="Delete"
          destructive
          onConfirm={() => { act(() => deleteDevice(deleting!), t("deleted"), t("failed")); setDeleting(null); }}
          onClose={() => setDeleting(null)}
        />
      )}

      {editingContent && (
        <ContentEditModal
          instanceId={editingContent}
          contentInstances={contentInstances}
          providers={providers}
          knownDisplays={knownDisplays}
          onClose={() => setEditingContent(null)}
        />
      )}

      <BatteryChartModal mac={batteryMac ?? ""} open={!!batteryMac} onClose={() => setBatteryMac(null)} />
    </div>
  );
}
