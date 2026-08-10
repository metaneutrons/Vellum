// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useEffect, useState, useTransition } from "react";
import { updateDevice, updateSetting } from "../actions";
import { useToast } from "@/components/toast";
import { useTranslations } from "next-intl";
import { StatusPill } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/misc";
import { Cpu, Download, Package, Usb } from "lucide-react";
import type { ServerUpdateStatus } from "@/lib/server-updater";
import { ConfirmDialog } from "@/components/confirm";

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
  serverUpdate: ServerUpdateStatus;
  canUpdateServer: boolean;
}

const selectCls =
  "min-h-8 px-2.5 rounded-md bg-surface-secondary border border-separator text-[13px] text-label focus-ring";
const serverStateKeys = {
  unavailable: "serverStateUnavailable", starting: "serverStateStarting", checking: "serverStateChecking",
  available: "serverStateAvailable", updating: "serverStateUpdating", current: "serverStateCurrent",
  failed: "serverStateFailed",
} as const;

export function FirmwarePage({ devices, versions, settings, serverUpdate: initialServerUpdate, canUpdateServer }: Props) {
  const { toast } = useToast();
  const t = useTranslations("firmware");
  const [pending, startTransition] = useTransition();
  const [serverUpdate, setServerUpdate] = useState(initialServerUpdate);
  const [serverActionPending, setServerActionPending] = useState(false);
  const [confirmServerUpdate, setConfirmServerUpdate] = useState(false);
  const [updateMode, setUpdateMode] = useState(serverUpdate.updateMode);
  const [maintenanceTime, setMaintenanceTime] = useState(serverUpdate.maintenanceTime);
  const [updateTimezone, setUpdateTimezone] = useState(serverUpdate.timezone);
  const [scheduleDirty, setScheduleDirty] = useState(false);

  useEffect(() => {
    const refresh = () => fetch("/api/v1/admin/server-update", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((value) => value && setServerUpdate(value))
      .catch(() => undefined);
    const timer = window.setInterval(refresh, serverUpdate.state === "updating" ? 3_000 : 30_000);
    return () => window.clearInterval(timer);
  }, [serverUpdate.state]);

  useEffect(() => {
    if (!scheduleDirty && serverUpdate.supported) {
      setUpdateMode(serverUpdate.updateMode);
      setMaintenanceTime(serverUpdate.maintenanceTime);
      setUpdateTimezone(serverUpdate.timezone);
    }
  }, [scheduleDirty, serverUpdate.maintenanceTime, serverUpdate.supported, serverUpdate.timezone, serverUpdate.updateMode]);

  async function serverAction(action: "check" | "apply") {
    setConfirmServerUpdate(false);
    setServerActionPending(true);
    try {
      const response = await fetch("/api/v1/admin/server-update", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      if (!response.ok) throw new Error();
      setServerUpdate(await response.json());
      toast("success", action === "apply" ? t("serverUpdateStarted") : t("serverCheckStarted"));
    } catch { toast("error", t("serverActionFailed")); }
    finally { setServerActionPending(false); }
  }

  async function saveServerUpdateConfig() {
    setServerActionPending(true);
    try {
      const response = await fetch("/api/v1/admin/server-update", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "configure", mode: updateMode, maintenanceTime, timezone: updateTimezone }) });
      if (!response.ok) throw new Error();
      setServerUpdate(await response.json());
      setScheduleDirty(false);
      toast("success", t("serverScheduleSaved"));
    } catch { toast("error", t("serverScheduleFailed")); }
    finally { setServerActionPending(false); }
  }

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

      <h2 className="text-lg font-semibold text-label mb-3">{t("serverUpdateTitle")}</h2>
      <div className="bg-surface rounded-2xl border border-separator/60 shadow-e1 p-4 mb-8">
        <div className="flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-label">{serverUpdate.currentVersion ?? t("serverVersionUnknown")}</span>
            <StatusPill tone={!serverUpdate.supported ? "neutral" : serverUpdate.state === "failed" ? "red" : serverUpdate.updateAvailable ? "orange" : "green"}>
              {t(serverStateKeys[serverUpdate.state])}
            </StatusPill>
          </div>
          <p className="text-sm text-label-secondary mt-1">
            {!serverUpdate.supported ? t("serverUpdaterUnavailable") : serverUpdate.updateAvailable
              ? t("serverUpdateAvailable", { version: serverUpdate.availableVersion ?? "" })
              : serverUpdate.lastError ?? (serverUpdate.updateMode === "automatic"
                ? t("serverAutomaticSchedule", { time: serverUpdate.maintenanceTime, timezone: serverUpdate.timezone })
                : t("serverManualSchedule"))}
          </p>
        </div>
        {canUpdateServer && serverUpdate.supported && (
          <div className="flex gap-2">
            <button disabled={serverActionPending || serverUpdate.state === "updating"} onClick={() => serverAction("check")}
              className="min-h-10 px-3 rounded-md bg-fill-tertiary text-sm font-semibold disabled:opacity-50 focus-ring">{t("serverCheck")}</button>
            {serverUpdate.updateAvailable && <button disabled={serverActionPending || serverUpdate.state === "updating"} onClick={() => setConfirmServerUpdate(true)}
              className="min-h-10 px-4 rounded-md bg-accent text-on-accent text-sm font-semibold disabled:opacity-50 focus-ring">{t("serverInstall")}</button>}
          </div>
        )}
        </div>
        {canUpdateServer && serverUpdate.supported && (
          <div className="mt-4 pt-4 border-t border-separator flex items-end gap-3 flex-wrap">
            <label className="flex flex-col gap-1 text-xs text-label-secondary">
              {t("serverUpdateMode")}
              <select className={selectCls} value={updateMode} onChange={(event) => { setUpdateMode(event.target.value as "manual" | "automatic"); setScheduleDirty(true); }}>
                <option value="manual">{t("serverModeManual")}</option>
                <option value="automatic">{t("serverModeAutomatic")}</option>
              </select>
            </label>
            {updateMode === "automatic" && <>
              <label className="flex flex-col gap-1 text-xs text-label-secondary">
                {t("serverMaintenanceTime")}
                <input className={selectCls} type="time" required value={maintenanceTime}
                  onChange={(event) => { setMaintenanceTime(event.target.value); setScheduleDirty(true); }} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-label-secondary flex-1 min-w-[190px]">
                {t("serverTimezone")}
                <input className={selectCls} required maxLength={100} value={updateTimezone}
                  placeholder="Europe/Berlin" onChange={(event) => { setUpdateTimezone(event.target.value); setScheduleDirty(true); }} />
              </label>
            </>}
            <button disabled={serverActionPending || !scheduleDirty || !maintenanceTime || !updateTimezone} onClick={saveServerUpdateConfig}
              className="min-h-8 px-3 rounded-md bg-accent text-on-accent text-sm font-semibold disabled:opacity-50 focus-ring">
              {t("serverSaveSchedule")}
            </button>
          </div>
        )}
      </div>
      <ConfirmDialog open={confirmServerUpdate} onClose={() => setConfirmServerUpdate(false)}
        onConfirm={() => serverAction("apply")} pending={serverActionPending}
        title={t("serverConfirmTitle")} message={t("serverConfirmMessage", { version: serverUpdate.availableVersion ?? "" })}
        confirmLabel={t("serverInstall")} />

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
              <option value={3600}>1 hour</option>
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
            <span className="text-xs text-label-tertiary tabular-nums">{new Date(v.date).toLocaleDateString("de-DE")}</span>
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
                  <option value="">— latest —</option>
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
