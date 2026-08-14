// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ConfirmDialog } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { StatusPill } from "@/components/ui/badge";
import type { ServerUpdateStatus } from "@/lib/server-updater";
import { beginUpdateWindow, endUpdateWindow, readUpdateWindow } from "@/lib/update-window";

const selectCls =
  "min-h-8 px-2.5 rounded-md bg-surface-secondary border border-separator text-[13px] text-label focus-ring";

const stateKeys = {
  unavailable: "serverStateUnavailable",
  starting: "serverStateStarting",
  checking: "serverStateChecking",
  available: "serverStateAvailable",
  updating: "serverStateUpdating",
  current: "serverStateCurrent",
  failed: "serverStateFailed",
} as const;

/* Ordered so the UI can mark earlier steps done; the terminal phases are handled
 * separately because they end the sequence rather than advance it. */
const PHASE_SEQUENCE = ["verifying", "backing-up", "deploying", "waiting-for-health"] as const;
const PHASE_KEYS = {
  verifying: "phaseVerifying",
  "backing-up": "phaseBackingUp",
  deploying: "phaseDeploying",
  "waiting-for-health": "phaseWaitingForHealth",
} as const;

export function ServerUpdatePanel({ initialStatus, canUpdate }: {
  initialStatus: ServerUpdateStatus;
  canUpdate: boolean;
}) {
  const t = useTranslations("system");
  const { toast } = useToast();
  const [status, setStatus] = useState(initialStatus);
  const [actionPending, setActionPending] = useState(false);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [updateMode, setUpdateMode] = useState(status.updateMode);
  const [maintenanceTime, setMaintenanceTime] = useState(status.maintenanceTime);
  const [timezone, setTimezone] = useState(status.timezone);
  const [scheduleDirty, setScheduleDirty] = useState(false);
  /* Set when THIS browser started the update, so the database overlay can show a
   * restart instead of an outage. Survives a reload during the downtime. */
  const [completed, setCompleted] = useState<{ from: string | null; to: string | null } | null>(null);

  useEffect(() => {
    const refresh = () => fetch("/api/v1/admin/server-update", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((value: ServerUpdateStatus | null) => {
        if (!value) return;
        setStatus(value);
        /* The server answering again is the only reliable signal that the restart
         * is over — the container that started the update is gone. */
        const openWindow = readUpdateWindow();
        if (openWindow && value.state !== "updating") {
          endUpdateWindow();
          setCompleted({ from: openWindow.fromVersion, to: value.currentVersion ?? openWindow.toVersion });
        }
      })
      .catch(() => undefined);
    const updating = status.state === "updating" || readUpdateWindow() !== null;
    const timer = window.setInterval(refresh, updating ? 1_500 : 30_000);
    return () => window.clearInterval(timer);
  }, [status.state]);

  useEffect(() => {
    if (!scheduleDirty && status.supported) {
      setUpdateMode(status.updateMode);
      setMaintenanceTime(status.maintenanceTime);
      setTimezone(status.timezone);
    }
  }, [scheduleDirty, status.maintenanceTime, status.supported, status.timezone, status.updateMode]);

  async function runAction(action: "check" | "apply") {
    setConfirmUpdate(false);
    setActionPending(true);
    try {
      const response = await fetch("/api/v1/admin/server-update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        toast("error", response.status === 403 ? t("serverActionForbidden")
          : response.status === 503 ? t("serverUpdaterUnavailable") : t("serverActionFailed"));
        return;
      }
      const next: ServerUpdateStatus = await response.json();
      setStatus(next);
      if (action === "apply") {
        /* Opened BEFORE the container goes away: once it is gone, this page can no
         * longer be told anything. */
        setCompleted(null);
        beginUpdateWindow(status.currentVersion, status.availableVersion);
      }
      toast("success", action === "apply" ? t("serverUpdateStarted") : t("serverCheckStarted"));
    } catch {
      toast("error", t("serverActionFailed"));
    } finally {
      setActionPending(false);
    }
  }

  async function saveSchedule() {
    setActionPending(true);
    try {
      const response = await fetch("/api/v1/admin/server-update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "configure", mode: updateMode, maintenanceTime, timezone }),
      });
      if (!response.ok) {
        toast("error", response.status === 403 ? t("serverActionForbidden")
          : response.status === 503 ? t("serverUpdaterUnavailable") : t("serverScheduleFailed"));
        return;
      }
      setStatus(await response.json());
      setScheduleDirty(false);
      toast("success", t("serverScheduleSaved"));
    } catch {
      toast("error", t("serverScheduleFailed"));
    } finally {
      setActionPending(false);
    }
  }

  return (
    <>
      <h2 className="text-lg font-semibold text-label mb-3">{t("serverUpdateTitle")}</h2>
      <div className="bg-surface rounded-2xl border border-separator/60 shadow-e1 p-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex-1 min-w-[240px]">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-label">{status.currentVersion ?? t("serverVersionUnknown")}</span>
              <StatusPill tone={!status.supported ? "neutral" : status.state === "failed" ? "red" : status.updateAvailable ? "orange" : "green"}>
                {t(stateKeys[status.state])}
              </StatusPill>
            </div>
            <p className="text-sm text-label-secondary mt-1">
              {!status.supported ? t("serverUpdaterUnavailable") : status.updateAvailable
                ? t("serverUpdateAvailable", { version: status.availableVersion ?? "" })
                : status.lastError ?? (status.updateMode === "automatic"
                  ? t("serverAutomaticSchedule", { time: status.maintenanceTime, timezone: status.timezone })
                  : t("serverManualSchedule"))}
            </p>
          </div>
          {status.supported && status.progress && status.state === "updating" && (
            /* Real step-level progress. update.sh writes each phase to the state
             * volume because the server cannot narrate its own restart. */
            <ol className="w-full order-last space-y-1.5">
              {PHASE_SEQUENCE.map((phase, index, sequence) => {
                const active = status.progress?.phase;
                const currentIndex = sequence.indexOf(active as typeof PHASE_SEQUENCE[number]);
                const terminal = active === "done";
                const state = terminal || (currentIndex >= 0 && index < currentIndex)
                  ? "done" : currentIndex === index ? "active" : "pending";
                return (
                  <li key={phase} className="flex items-center gap-2 text-sm">
                    <span aria-hidden="true" className={state === "done" ? "text-green" : state === "active" ? "text-accent" : "text-label-tertiary"}>
                      {state === "done" ? "✓" : state === "active" ? "◐" : "○"}
                    </span>
                    <span className={state === "pending" ? "text-label-tertiary" : "text-label"}>{t(PHASE_KEYS[phase])}</span>
                  </li>
                );
              })}
            </ol>
          )}
          {completed && (
            /* The old "tada, new version" moment: say what happened instead. */
            <div className="w-full order-last rounded-lg bg-green/10 border border-green/30 p-3">
              <p className="text-sm font-semibold text-green">
                {completed.from && completed.to
                  ? t("serverUpdateDone", { from: completed.from, to: completed.to })
                  : t("serverUpdateDoneShort", { version: completed.to ?? "" })}
              </p>
              <button onClick={() => setCompleted(null)}
                className="mt-2 text-sm text-label-secondary underline focus-ring">
                {t("serverUpdateDoneDismiss")}
              </button>
            </div>
          )}
          {status.supported && status.updaterSwap && status.updaterSwap.outcome !== "succeeded" && (
            /* A failed or rolled-back self-update is reported by the updater that
             * replaced the one which attempted it — the attempting container is
             * gone, so without this the only trace would be container logs. */
            <div className="w-full order-last rounded-lg bg-red/10 border border-red/30 p-3">
              <p className="text-sm font-semibold text-red">
                {status.updaterSwap.outcome === "rolled-back" ? t("updaterSwapRolledBack") : t("updaterSwapFailed")}
              </p>
              {status.updaterSwap.detail && (
                <p className="text-sm text-label-secondary mt-1">{status.updaterSwap.detail}</p>
              )}
            </div>
          )}
          {status.supported && (status.updaterUpdateAvailable || !status.updaterVersion) && (
            /* A missing version means the running updater predates version
             * reporting and safe self-update — outdated by definition. */
            <div className="w-full order-last rounded-lg bg-fill-tertiary/60 border border-separator/60 p-3">
              <p className="text-sm text-label">
                {status.updaterVersion
                  ? t("updaterOutdated", { current: status.updaterVersion, available: status.availableVersion ?? "" })
                  : t("updaterVersionUnknown")}
              </p>
              {!status.updaterSelfUpdateCapable ? <>
                <p className="text-sm text-label-secondary mt-1">{t("updaterBootstrapHint")}</p>
                <pre className="mt-2 text-xs font-mono text-label-secondary whitespace-pre-wrap select-all">
                  docker compose pull updater{"\n"}docker compose up -d --no-deps updater
                </pre>
              </> : <p className="text-sm text-label-secondary mt-1">
                {status.updaterSelfUpdateEnabled ? t("updaterAutomaticHint") : t("updaterAutomaticDisabledHint")}
              </p>}
            </div>
          )}
          {canUpdate && status.supported && (
            <div className="flex gap-2">
              <button disabled={actionPending || status.state === "updating"} onClick={() => runAction("check")}
                className="min-h-10 px-3 rounded-md bg-fill-tertiary text-sm font-semibold disabled:opacity-50 focus-ring">
                {t("serverCheck")}
              </button>
              {status.updateAvailable && (
                <button disabled={actionPending || status.state === "updating"} onClick={() => setConfirmUpdate(true)}
                  className="min-h-10 px-4 rounded-md bg-accent text-on-accent text-sm font-semibold disabled:opacity-50 focus-ring">
                  {t("serverInstall")}
                </button>
              )}
            </div>
          )}
        </div>

        {canUpdate && status.supported && (
          <div className="mt-4 pt-4 border-t border-separator flex items-end gap-3 flex-wrap">
            <label className="flex flex-col gap-1 text-xs text-label-secondary">
              {t("serverUpdateMode")}
              <select className={selectCls} value={updateMode}
                onChange={(event) => { setUpdateMode(event.target.value as "manual" | "automatic"); setScheduleDirty(true); }}>
                <option value="manual">{t("serverModeManual")}</option>
                <option value="automatic">{t("serverModeAutomatic")}</option>
              </select>
            </label>
            {updateMode === "automatic" && (
              <>
                <label className="flex flex-col gap-1 text-xs text-label-secondary">
                  {t("serverMaintenanceTime")}
                  <input className={selectCls} type="time" required value={maintenanceTime}
                    onChange={(event) => { setMaintenanceTime(event.target.value); setScheduleDirty(true); }} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-label-secondary flex-1 min-w-[190px]">
                  {t("serverTimezone")}
                  <input className={selectCls} required maxLength={100} value={timezone}
                    placeholder="Europe/Berlin" onChange={(event) => { setTimezone(event.target.value); setScheduleDirty(true); }} />
                </label>
              </>
            )}
            <button disabled={actionPending || !scheduleDirty || !maintenanceTime || !timezone} onClick={saveSchedule}
              className="min-h-8 px-3 rounded-md bg-accent text-on-accent text-sm font-semibold disabled:opacity-50 focus-ring">
              {t("serverSaveSchedule")}
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog open={confirmUpdate} onClose={() => setConfirmUpdate(false)}
        onConfirm={() => runAction("apply")} pending={actionPending}
        title={t("serverConfirmTitle")}
        message={`${t("serverConfirmMessage", { version: status.availableVersion ?? "" })}\n\n${t("serverConfirmSteps")}\n\n${t("serverConfirmDowntime")}`}
        confirmLabel={t("serverInstall")} />
    </>
  );
}
