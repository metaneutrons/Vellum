// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useTransition } from "react";
import { updateDevice, updateSetting } from "../actions";
import { useToast } from "@/components/toast";
import { useLocale, useTranslations } from "next-intl";
import { StatusPill } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Cpu, Download, Package, Usb } from "lucide-react";

interface FirmwareVersion {
  version: string;
  channel: "stable" | "beta";
  date: string;
  tag: string;
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
  settings: Record<string, unknown>;
}

const selectCls =
  "min-h-8 px-2.5 rounded-md bg-surface-secondary border border-separator text-[13px] text-label focus-ring";
export function FirmwarePage({ devices, versions, settings }: Props) {
  const { toast } = useToast();
  const t = useTranslations("firmware");
  const locale = useLocale();
  const [pending, startTransition] = useTransition();

  const autoPoll = settings["firmware.autoPoll"] as boolean ?? false;
  const pollIntervalS = settings["firmware.pollIntervalS"] as number ?? 900;

  function toggleAutoPoll() {
    startTransition(async () => {
      try { await updateSetting("firmware.autoPoll", !autoPoll); toast("success", t("updated")); }
      catch { toast("error", t("failedUpdate")); }
    });
  }

  function setPollInterval(s: number) {
    startTransition(async () => {
      try { await updateSetting("firmware.pollIntervalS", s); toast("success", t("updated")); }
      catch { toast("error", t("failedUpdate")); }
    });
  }

  function setChannel(mac: string, channel: string) {
    startTransition(async () => {
      try { await updateDevice(mac, { firmwareChannel: channel }); toast("success", t("updated")); }
      catch { toast("error", t("failedUpdate")); }
    });
  }

  function pinVersion(mac: string, version: string | null) {
    startTransition(async () => {
      try { await updateDevice(mac, { firmwarePinVersion: version }); toast("success", t("updated")); }
      catch { toast("error", t("failedUpdate")); }
    });
  }

  const stableVersions = versions.filter((v) => v.channel === "stable");
  const betaVersions = versions.filter((v) => v.channel === "beta");

  return (
    <div className={`mx-auto max-w-5xl ${pending ? "opacity-60 pointer-events-none" : ""}`}>
      {/* Header */}
      <div className="flex flex-wrap items-end gap-4 mb-6">
        <div className="flex-1 min-w-0">
          <h1 className="text-[28px] font-bold tracking-tight text-label leading-none">{t("title")}</h1>
          <p className="text-[15px] text-label-secondary mt-1.5">{t("description")}</p>
        </div>
        <a href="/admin/firmware/provision"
          className="inline-flex items-center justify-center gap-2 font-semibold rounded-md select-none whitespace-nowrap focus-ring transition active:scale-[0.97] min-h-11 px-4 text-[15px] bg-fill-tertiary text-label hover:bg-fill-secondary">
          <Usb size={16} aria-hidden="true" />
          {t("provision")}
        </a>
        <a href="/admin/firmware/flash"
          className="inline-flex items-center justify-center gap-2 font-semibold rounded-md select-none whitespace-nowrap focus-ring transition active:scale-[0.97] min-h-11 px-4 text-[15px] bg-accent text-on-accent shadow-e1 hover:bg-accent-hover active:bg-accent-pressed">
          <Download size={16} aria-hidden="true" />
          {t("flash")}
        </a>
      </div>

      {/* Auto-poll settings */}
      <h2 className="text-lg font-semibold text-label mb-3">{t("autoUpdate")}</h2>
      <div className="bg-surface rounded-2xl border border-separator/60 shadow-e1 px-4 py-4 mb-8 flex items-center gap-6 flex-wrap">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={autoPoll} onChange={toggleAutoPoll}
            className="size-4 rounded accent-accent focus-ring" aria-label={t("backgroundPolling")} />
          <span className="text-sm text-label">{t("backgroundPolling")}</span>
        </label>
        {autoPoll && (
          <label className="flex items-center gap-2 text-sm text-label-secondary">
            {t("interval")}:
            <select className={selectCls} value={pollIntervalS}
              aria-label={t("interval")}
              onChange={(e) => setPollInterval(Number(e.target.value))}>
              <option value={300}>5 min</option>
              <option value={900}>15 min</option>
              <option value={1800}>30 min</option>
              <option value={3600}>{t("pollHourly")}</option>
            </select>
          </label>
        )}
        <span className="text-xs text-label-tertiary">
          {autoPoll ? t("autoUpdateOn") : t("autoUpdateOff")}
        </span>
      </div>

      {/* Available versions */}
      <h2 className="text-lg font-semibold text-label mb-3">{t("versions")}</h2>
      <div className="bg-surface rounded-2xl border border-separator/60 shadow-e1 overflow-hidden mb-8">
        {versions.length === 0 && (
          <EmptyState
            icon={<Package size={24} aria-hidden="true" />}
            title={t("noVersions")}
          />
        )}
        {versions.map((v, i) => (
          <div key={v.tag} className={`px-4 py-3 flex items-center gap-3 ${i > 0 ? "border-t border-separator" : ""}`}>
            <span className="font-mono text-sm font-semibold text-label">v{v.version}</span>
            <StatusPill tone={v.channel === "stable" ? "green" : "orange"}>
              {v.channel}
            </StatusPill>
            <span className="text-xs text-label-tertiary tabular-nums">{new Date(v.date).toLocaleDateString(locale)}</span>
          </div>
        ))}
      </div>

      {/* Device assignments */}
      <h2 className="text-lg font-semibold text-label mb-3">{t("deviceFirmware")}</h2>
      <div className="space-y-3">
        {devices.length === 0 && (
          <EmptyState
            icon={<Cpu size={24} aria-hidden="true" />}
          title={t("device")}
          />
        )}
        {devices.map((d) => {
          const caps = d.displayCaps as { model?: string } | null;
          const channel = d.firmwareChannel ?? "stable";
          const channelVersions = channel === "beta" ? [...stableVersions, ...betaVersions] : stableVersions;
          return (
            <div key={d.mac} className="bg-surface rounded-2xl border border-separator/60 shadow-e1 p-4 flex items-center gap-4 flex-wrap">
              <div className="flex-1 min-w-0 flex items-center gap-3 flex-wrap">
                <a href={`/admin/devices/${d.mac}`} className="font-mono text-sm font-semibold text-accent hover:underline focus-ring rounded">{d.mac}</a>
                <span className="text-xs text-label-secondary">{caps?.model ?? "—"}</span>
              </div>
              <label className="flex items-center gap-1.5 text-[13px] text-label-secondary">{t("channel")}
                <select className={selectCls} aria-label={t("channel")}
                  value={channel}
                  onChange={(e) => setChannel(d.mac, e.target.value)}>
                  <option value="stable">stable</option>
                  <option value="beta">beta</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-[13px] text-label-secondary">{t("pinVersion")}
                <select className={selectCls} aria-label={t("pinVersion")}
                  value={d.firmwarePinVersion ?? ""}
                  onChange={(e) => pinVersion(d.mac, e.target.value || null)}>
                  <option value="">{t("latestVersion")}</option>
                  {channelVersions.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version} ({v.channel})
                    </option>
                  ))}
                </select>
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
