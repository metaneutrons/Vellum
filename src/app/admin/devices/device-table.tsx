// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useTransition } from "react";
import { approveDevice, updateDevice, deleteDevice, queueDeviceOrientation } from "../actions";
import { useToast } from "@/components/toast";
import { ConfirmDialog } from "@/components/confirm";
import { useTranslations } from "next-intl";
import { ContentEditModal } from "./content-edit-modal";
import { BatteryChartModal } from "./battery-chart-modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { deviceConnectivity, connectivityTone } from "@/lib/connectivity";
import { parseDeviceTs } from "../dashboard/ts";
import {
  AlertTriangle,
  Battery,
  BatteryLow,
  Wifi,
  Trash2,
  Search,
  ImageOff,
  MonitorSmartphone,
  PlugZap,
} from "lucide-react";
import { useDeviceLiveUpdates, type LiveDeviceRow } from "./use-device-live-updates";

interface Device {
  mac: string;
  status: string;
  content_instance_id: string | null;
  theme_id: string | null;
  refresh_profile_id: string | null;
  firmware_channel: string | null;
  firmware_pin_version: string | null;
  display_caps: unknown;
  orientation_override: string | null;
  last_seen: string | null;
  expected_interval_s: number | null;
  battery_level: number | null;
  battery_voltage: number | null;
  power_source: "usb" | "battery" | "unknown" | null;
  battery_status: "charging" | "full" | "discharging" | "unknown" | null;
  wifi_rssi: number | null;
  wifi_ssid: string | null;
  wifi_security: string | null;
  security_profile: string | null;
  nvs_integrity: string | null;
  chip_model: string | null;
  flash_size_bytes: number | null;
  partition_layout: string | null;
  layout_verified: boolean | null;
  secure_boot_enabled: boolean | null;
  flash_encryption_enabled: boolean | null;
  firmware_version: string | null;
}

interface FirmwareVersion {
  version: string;
  channel: string;
  tag: string;
}

interface Props {
  devices: Record<string, unknown>[];
  themes: { id: string; name: string; isDefault?: boolean }[];
  contentInstances: { id: string; name: string; typeSlug: string; config: unknown }[];
  refreshProfiles: { id: string; name: string; isDefault?: boolean }[];
  firmwareVersions: FirmwareVersion[];
  providers: { id: string; type: string; name: string }[];
  knownDisplays: { label: string; width: number; height: number }[];
}

const selectCls =
  "min-h-8 px-2.5 rounded-md bg-surface-secondary border border-separator text-[13px] text-label focus-ring";

export function DeviceTable({
  devices: rawDevices,
  themes,
  contentInstances,
  refreshProfiles,
  firmwareVersions,
  providers,
  knownDisplays,
}: Props) {
  const live = useDeviceLiveUpdates(rawDevices as LiveDeviceRow[]);
  const devices = live.devices as unknown as Device[];
  const { toast } = useToast();
  const t = useTranslations("devices");
  /* Name what "default" actually resolves to. Leaving it bare meant an operator
   * could not tell which profile (or theme) an unassigned display would use — the
   * answer used to be constants in the source. */
  const inheritedLabel = (items: { name: string; isDefault?: boolean }[]) => {
    const designated = items.find((i) => i.isDefault);
    return designated ? `${t("default")} · ${designated.name}` : t("default");
  };
  const [pending, startTransition] = useTransition();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState<string | null>(null);
  const [batteryMac, setBatteryMac] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewMac, setPreviewMac] = useState<string | null>(null);

  function act(fn: () => Promise<unknown>, ok: string, fail: string) {
    startTransition(async () => {
      try {
        await fn();
        toast("success", ok);
      } catch {
        toast("error", fail);
      }
    });
  }

  function update(mac: string, data: Record<string, unknown>) {
    act(() => updateDevice(mac, data), t("updated"), t("failed"));
  }

  /* A mounting is a property of the physical installation, so it has to reach the
   * device: the server can swap the rendered geometry, but the panel's own surface
   * only changes across a restart. Clearing the choice is a server-side matter
   * alone -- there is nothing to tell a device about "no preference". */
  function setOrientation(mac: string, value: string) {
    if (!value) {
      update(mac, { orientationOverride: null });
      return;
    }
    act(() => queueDeviceOrientation(mac, value), t("orientationQueued"), t("failed"));
  }

  const filtered = devices.filter((d) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      d.mac.toLowerCase().includes(q) ||
      (d.firmware_version ?? "").toLowerCase().includes(q) ||
      ((d.display_caps as { model?: string })?.model ?? "").includes(q)
    );
  });

  const stableVersions = firmwareVersions.filter((v) => v.channel === "stable");
  const betaVersions = firmwareVersions.filter((v) => v.channel === "beta");

  return (
    <div className={`mx-auto max-w-5xl ${pending ? "opacity-60 pointer-events-none" : ""}`}>
      {/* Header */}
      <div className="flex flex-wrap items-end gap-4 mb-6">
        <div className="flex-1 min-w-0">
          <h1 className="text-[28px] font-bold tracking-tight text-label leading-none">
            {t("title")}
          </h1>
          <p className="text-[15px] text-label-secondary mt-1.5">{t("description")}</p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("search")}
            className="pl-9"
            aria-label={t("search")}
          />
        </div>
        <div
          className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-fill-secondary px-2.5 text-xs text-label-secondary"
          role="status"
          aria-live="polite"
        >
          <span
            className={`size-1.5 rounded-full ${
              live.state === "live" ? "bg-green" : "bg-orange animate-pulse"
            }`}
            aria-hidden="true"
          />
          {live.state === "live" ? t("liveStatus.live") : t("liveStatus.reconnecting")}
        </div>
      </div>

      <div className="space-y-3">
        {filtered.map((d) => {
          const caps = d.display_caps as { model?: string; width?: number; height?: number } | null;
          const model = caps?.model?.toUpperCase() ?? "—";
          const bWarn = d.battery_level !== null && d.battery_level < 20;
          const rWarn = d.wifi_rssi !== null && d.wifi_rssi < -70;
          const lastSeen = d.last_seen ? new Date(d.last_seen + "Z") : null;
          // Connectivity is judged against the device's own expected cadence
          // (shared helper), not a fixed window — see src/lib/connectivity.ts.
          const connState = deviceConnectivity(
            parseDeviceTs(d.last_seen),
            d.expected_interval_s,
            live.now
          );
          const oWarn = connState === "offline";
          const connLabel =
            connState === "online"
              ? t("connectivity.online")
              : connState === "late"
                ? t("connectivity.late")
                : connState === "offline"
                  ? t("connectivity.offline")
                  : t("connectivity.never");
          const hasWarning = bWarn || rWarn || oWarn;
          const channel = d.firmware_channel ?? "stable";
          const channelVersions =
            channel === "beta" ? [...stableVersions, ...betaVersions] : stableVersions;
          const hasContent = d.content_instance_id && d.status === "approved";
          const contentName = contentInstances.find((c) => c.id === d.content_instance_id)?.name;
          // Authorization tone — green is reserved for connectivity, so an
          // approved device is a neutral accent chip, not green.
          const statusTone =
            d.status === "approved" ? "accent" : d.status === "pending" ? "orange" : "red";

          return (
            <div
              key={d.mac}
              className="bg-surface rounded-2xl border border-separator/60 shadow-e1 overflow-hidden"
            >
              <div className="flex gap-4 p-4">
                {/* Preview thumbnail */}
                <div className="shrink-0">
                  {hasContent ? (
                    <button
                      onClick={() => {
                        setPreviewId(d.content_instance_id);
                        setPreviewMac(d.mac);
                      }}
                      className="block w-24 h-14 rounded-lg border border-separator hover:border-accent overflow-hidden cursor-pointer transition-colors focus-ring"
                      title={t("preview")}
                    >
                      <img
                        src={`/api/v1/admin/preview?instanceId=${d.content_instance_id}&mac=${d.mac}&w=192&h=112`}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    </button>
                  ) : (
                    <div className="w-24 h-14 rounded-lg border border-dashed border-separator grid place-items-center text-label-tertiary">
                      <ImageOff size={18} aria-hidden="true" />
                    </div>
                  )}
                </div>

                {/* Device info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {hasWarning && (
                      <AlertTriangle
                        size={15}
                        className="text-orange"
                        aria-label={[
                          bWarn && t("warnings.lowBattery"),
                          rWarn && t("warnings.weakSignal"),
                          oWarn && t("warnings.offline"),
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      />
                    )}
                    <span className="font-mono text-sm font-semibold tracking-tight text-label">
                      {d.mac}
                    </span>
                    <StatusPill tone={statusTone} dot>
                      {d.status}
                    </StatusPill>
                    <StatusPill tone={connectivityTone(connState)} dot>
                      {connLabel}
                    </StatusPill>
                    <span className="text-xs text-label-secondary">{model}</span>
                    {caps?.width && (
                      <span className="text-xs text-label-tertiary">
                        {caps.width}×{caps.height}
                      </span>
                    )}
                    {contentName && (
                      <button
                        onClick={() => setEditingContent(d.content_instance_id)}
                        className="text-xs text-accent hover:underline focus-ring rounded"
                      >
                        → {contentName}
                      </button>
                    )}
                  </div>

                  {/* Telemetry row */}
                  <div className="flex items-center gap-3 mt-2 text-xs text-label-secondary tabular-nums">
                    {d.battery_level !== null && (
                      <button
                        onClick={() => setBatteryMac(d.mac)}
                        className={`inline-flex items-center gap-1 hover:underline focus-ring rounded ${bWarn ? "text-orange font-medium" : ""}`}
                      >
                        {bWarn ? (
                          <BatteryLow size={15} aria-hidden="true" />
                        ) : (
                          <Battery size={15} aria-hidden="true" />
                        )}
                        {d.battery_level}%
                        <span className="text-label-tertiary">
                          ({Number(d.battery_voltage ?? 0).toFixed(2)}V)
                        </span>
                      </button>
                    )}
                    {d.power_source && (
                      <span className="inline-flex items-center gap-1">
                        {d.power_source === "usb" ? (
                          <PlugZap size={15} aria-hidden="true" />
                        ) : d.power_source === "unknown" ? (
                          <AlertTriangle size={15} aria-hidden="true" />
                        ) : (
                          <Battery size={15} aria-hidden="true" />
                        )}
                        {d.battery_status && d.battery_status !== "unknown"
                          ? t(`power.${d.battery_status}`)
                          : t(`power.${d.power_source}`)}
                      </span>
                    )}
                    {d.wifi_rssi !== null && (
                      <span
                        className={`inline-flex items-center gap-1 ${rWarn ? "text-orange font-medium" : ""}`}
                      >
                        <Wifi size={15} aria-hidden="true" />
                        {d.wifi_rssi}dBm
                      </span>
                    )}
                    {d.wifi_ssid && (
                      <span className="inline-flex items-center gap-1" title={t("wifiSecurity")}>
                        <Wifi size={15} aria-hidden="true" />
                        {d.wifi_ssid}
                        {d.wifi_security && (
                          <span className="text-label-tertiary">· {d.wifi_security}</span>
                        )}
                      </span>
                    )}
                    {d.firmware_version && <span>v{d.firmware_version}</span>}
                    {d.security_profile && (
                      <span title={t("security.nvsIntegrity")}>
                        {d.security_profile}
                        {d.nvs_integrity ? ` · NVS ${d.nvs_integrity}` : ""}
                      </span>
                    )}
                    {d.partition_layout && (
                      <span
                        className={d.layout_verified ? "" : "text-orange font-medium"}
                        title={t("security.partitionLayout")}
                      >
                        {d.partition_layout}
                      </span>
                    )}
                    {lastSeen && (
                      <span className={oWarn ? "text-orange" : ""}>
                        {lastSeen.toLocaleString(undefined, {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-start gap-1.5 shrink-0">
                  {d.status === "pending" && (
                    <Button
                      size="sm"
                      onClick={() => act(() => approveDevice(d.mac), t("approved"), t("failed"))}
                    >
                      {t("approve")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="plain"
                    aria-label={t("delete")}
                    onClick={() => setDeleting(d.mac)}
                    className="text-red px-2"
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                </div>
              </div>

              {/* Assignments row — only for approved devices */}
              {d.status === "approved" && (
                <div className="flex items-center gap-3 px-4 py-2.5 border-t border-separator bg-surface-secondary text-[13px] text-label-secondary flex-wrap">
                  <label className="flex items-center gap-1.5">
                    {t("content")}
                    <select
                      className={selectCls}
                      value={d.content_instance_id ?? ""}
                      aria-label={t("content")}
                      onChange={(e) => update(d.mac, { contentInstanceId: e.target.value || null })}
                    >
                      <option value="">—</option>
                      {contentInstances.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5">
                    {t("theme")}
                    <select
                      className={selectCls}
                      value={d.theme_id ?? ""}
                      aria-label={t("theme")}
                      onChange={(e) => update(d.mac, { themeId: e.target.value || null })}
                    >
                      <option value="">{inheritedLabel(themes)}</option>
                      {themes.map((th) => (
                        <option key={th.id} value={th.id}>
                          {th.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5">
                    {t("profile")}
                    <select
                      className={selectCls}
                      value={d.refresh_profile_id ?? ""}
                      aria-label={t("profile")}
                      onChange={(e) => update(d.mac, { refreshProfileId: e.target.value || null })}
                    >
                      <option value="">{inheritedLabel(refreshProfiles)}</option>
                      {refreshProfiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className="text-separator">|</span>
                  <label className="flex items-center gap-1.5">
                    {t("orientation")}
                    <select
                      className={selectCls}
                      value={d.orientation_override ?? ""}
                      aria-label={t("orientation")}
                      onChange={(e) => setOrientation(d.mac, e.target.value)}
                    >
                      {/* Only what the display reports it can do. All three used
                          to be listed unconditionally, so an operator could pick
                          portrait on a panel whose driver cannot rotate: the
                          server then rendered the swapped geometry and the image
                          ran off the bottom edge. */}
                      <option value="">{t("auto")}</option>
                      {(() => {
                        const caps = d.display_caps as { orientations?: string[] } | null;
                        const supported = caps?.orientations?.length
                          ? caps.orientations
                          : ["landscape", "portrait"];
                        return supported.map((o) => (
                          <option key={o} value={o}>
                            {o === "portrait" ? t("portrait") : t("landscape")}
                          </option>
                        ));
                      })()}
                    </select>
                  </label>
                  <span className="text-separator">|</span>
                  <label className="flex items-center gap-1.5">
                    {t("firmware")}
                    <select
                      className={selectCls}
                      value={channel}
                      aria-label={t("channel")}
                      onChange={(e) => update(d.mac, { firmwareChannel: e.target.value })}
                    >
                      <option value="stable">{t("stable")}</option>
                      <option value="beta">{t("beta")}</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5">
                    {t("pin")}
                    <select
                      className={selectCls}
                      value={d.firmware_pin_version ?? ""}
                      aria-label={t("pin")}
                      onChange={(e) =>
                        update(d.mac, { firmwarePinVersion: e.target.value || null })
                      }
                    >
                      <option value="">{t("latest")}</option>
                      {channelVersions.map((v) => (
                        <option key={v.tag} value={v.version}>
                          v{v.version}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <EmptyState
            icon={<MonitorSmartphone size={24} aria-hidden="true" />}
            title={devices.length === 0 ? t("noDevices") : t("noMatch")}
            description={t("noDevicesHint")}
          />
        )}
      </div>

      {/* Full-size preview overlay (Aurora) */}
      {previewId && (
        <div
          className="fixed inset-0 z-50 material-overlay flex items-center justify-center p-8 cursor-pointer"
          onClick={() => setPreviewId(null)}
          onKeyDown={(e) => e.key === "Escape" && setPreviewId(null)}
          tabIndex={0}
          role="button"
          aria-label={t("preview")}
        >
          <img
            src={`/api/v1/admin/preview?instanceId=${previewId}&mac=${previewMac}`}
            alt="Preview"
            className="max-w-full max-h-full object-contain rounded-2xl shadow-e3"
          />
        </div>
      )}

      {/* Modals — now self-styled in Aurora. */}
      {deleting && (
        <ConfirmDialog
          open={!!deleting}
          title={t("deleteConfirm")}
          message={t("deleteMessage", { mac: deleting ?? "" })}
          confirmLabel="Delete"
          destructive
          onConfirm={() => {
            const mac = deleting;
            if (mac) act(() => deleteDevice(mac), t("deleted"), t("failed"));
            setDeleting(null);
          }}
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
      <BatteryChartModal
        mac={batteryMac ?? ""}
        open={!!batteryMac}
        onClose={() => setBatteryMac(null)}
      />
    </div>
  );
}
