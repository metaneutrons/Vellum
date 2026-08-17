// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ConfirmDialog } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { StatusPill } from "@/components/ui/badge";
import { REPO_URL } from "@/lib/app-meta";
import type { ServerUpdateStatus } from "@/lib/server-updater";
import { beginUpdateWindow, readUpdateWindow, serverUpdatePollInterval } from "@/lib/update-window";

const selectCls =
  "min-h-8 px-2.5 rounded-md bg-surface-secondary border border-separator text-[13px] text-label focus-ring";

const stateKeys = {
  unavailable: "serverStateUnavailable",
  starting: "serverStateStarting",
  checking: "serverStateChecking",
  preparing: "serverStatePreparing",
  available: "serverStateAvailable",
  updating: "serverStateUpdating",
  current: "serverStateCurrent",
  failed: "serverStateFailed",
} as const;

const COMPOSE_UPGRADE_URL = `${REPO_URL}/blob/main/README.md#upgrade-an-existing-compose-installation`;

export function ServerUpdatePanel({
  initialStatus,
  canUpdate,
}: {
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
  const transientFailureCount = useRef(
    initialStatus.supported || initialStatus.availabilityReason === "not-configured" ? 0 : 1
  );
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const refresh = async () => {
      /* The global overlay owns the live journal while an update is active.
       * Avoid issuing the same status request from two mounted components; this
       * timer resumes the panel automatically after the overlay closes. */
      if (readUpdateWindow() !== null) {
        timer = window.setTimeout(refresh, 1_500);
        return;
      }
      let nextState = status.state;
      try {
        const response = await fetch("/api/v1/admin/server-update", { cache: "no-store" });
        const value: ServerUpdateStatus | null = response.ok ? await response.json() : null;
        if (cancelled || !value) return;
        nextState = value.state;
        transientFailureCount.current =
          value.supported || value.availabilityReason === "not-configured"
            ? 0
            : transientFailureCount.current + 1;
        setStatus(value);
      } catch {
        /* A deliberate restart is expected; keep polling until the window expires. */
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(
            refresh,
            serverUpdatePollInterval(nextState, false, transientFailureCount.current)
          );
        }
      }
    };
    const openWindow = readUpdateWindow() !== null;
    timer = window.setTimeout(
      refresh,
      serverUpdatePollInterval(status.state, openWindow, transientFailureCount.current)
    );
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
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
        toast(
          "error",
          response.status === 403
            ? t("serverActionForbidden")
            : response.status === 503
              ? t("serverUpdaterUnavailable")
              : t("serverActionFailed")
        );
        return;
      }
      const next: ServerUpdateStatus = await response.json();
      setStatus(next);
      if (action === "apply") {
        /* Open immediately after the updater accepts the request. The global
         * overlay owns the complete experience, including the restart where
         * this page cannot narrate its own status. */
        beginUpdateWindow(
          next.currentVersion ?? status.currentVersion,
          next.availableVersion ?? status.availableVersion,
          next.progress
        );
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
        toast(
          "error",
          response.status === 403
            ? t("serverActionForbidden")
            : response.status === 503
              ? t("serverUpdaterUnavailable")
              : t("serverScheduleFailed")
        );
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

  const releaseCheckDegraded =
    status.supported && status.releaseCheckStatus === "degraded" && status.state !== "failed";
  const releaseCheckMessage =
    status.releaseCheckError === "rate-limited"
      ? t("serverReleaseCheckRateLimited")
      : status.releaseCheckError === "invalid-response"
        ? t("serverReleaseCheckInvalid")
        : t("serverReleaseCheckUnavailable");

  return (
    <>
      <h2 className="text-lg font-semibold text-label mb-3">{t("serverUpdateTitle")}</h2>
      <div className="bg-surface rounded-2xl border border-separator/60 shadow-e1 p-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex-1 min-w-[240px]">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-label">
                {status.currentVersion ?? t("serverVersionUnknown")}
              </span>
              <StatusPill
                tone={
                  !status.supported
                    ? "neutral"
                    : status.state === "failed"
                      ? "red"
                      : releaseCheckDegraded ||
                          status.state === "preparing" ||
                          status.updateAvailable
                        ? "orange"
                        : status.state === "current"
                          ? "green"
                          : "neutral"
                }
              >
                {releaseCheckDegraded ? t("serverStateCheckDelayed") : t(stateKeys[status.state])}
              </StatusPill>
            </div>
            <p className="text-sm text-label-secondary mt-1">
              {!status.supported
                ? status.availabilityReason === "not-configured"
                  ? t("serverUpdaterNotConfigured")
                  : status.availabilityReason === "invalid-response"
                    ? t("serverUpdaterInvalidResponse")
                    : t("serverUpdaterReconnecting")
                : status.state === "failed"
                  ? t("serverUpdateFailedGeneric")
                  : releaseCheckDegraded
                    ? t("serverReleaseCheckPreserved")
                    : status.state === "preparing"
                      ? t("serverReleasePreparing", { version: status.availableVersion ?? "" })
                      : status.updateAvailable
                        ? t("serverUpdateAvailable", { version: status.availableVersion ?? "" })
                        : status.updateMode === "automatic"
                          ? t("serverAutomaticSchedule", {
                              time: status.maintenanceTime,
                              timezone: status.timezone,
                            })
                          : t("serverManualSchedule")}
            </p>
          </div>
          {status.supported && status.state === "failed" && (
            <div
              role="alert"
              className="w-full order-last rounded-lg bg-red/10 border border-red/30 p-3"
            >
              <p className="text-sm font-semibold text-red">{t("serverUpdateFailedGeneric")}</p>
              {status.lastError && (
                <p className="text-sm text-label-secondary mt-1">{status.lastError}</p>
              )}
            </div>
          )}
          {releaseCheckDegraded && (
            <div
              role="status"
              className="w-full order-last rounded-lg bg-orange/10 border border-orange/30 p-3"
            >
              <p className="text-sm font-semibold text-label">
                {t("serverReleaseCheckDelayedTitle")}
              </p>
              <p className="text-sm text-label-secondary mt-1">{releaseCheckMessage}</p>
            </div>
          )}
          {!status.supported && status.availabilityReason === "not-configured" && (
            <div
              role="status"
              className="w-full order-last rounded-lg bg-orange/10 border border-orange/30 p-3"
            >
              <p className="text-sm font-semibold text-label">{t("serverUpdaterSetupTitle")}</p>
              <p className="text-sm text-label-secondary mt-1">{t("serverUpdaterSetupHint")}</p>
              <a
                href={COMPOSE_UPGRADE_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex mt-2 text-sm font-medium text-accent underline underline-offset-2 focus-ring"
              >
                {t("serverUpdaterSetupLink")}
              </a>
            </div>
          )}
          {!status.supported && status.availabilityReason !== "not-configured" && (
            <div
              role="status"
              className="w-full order-last rounded-lg bg-fill-tertiary/60 border border-separator/60 p-3"
            >
              <p className="text-sm font-semibold text-label">
                {status.availabilityReason === "invalid-response"
                  ? t("serverUpdaterInvalidTitle")
                  : t("serverUpdaterReconnectingTitle")}
              </p>
              <p className="text-sm text-label-secondary mt-1">
                {status.availabilityReason === "invalid-response"
                  ? t("serverUpdaterInvalidHint")
                  : t("serverUpdaterReconnectingHint")}
              </p>
              {status.availabilityReason === "invalid-response" && (
                <a
                  href={COMPOSE_UPGRADE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex mt-2 text-sm font-medium text-accent underline underline-offset-2 focus-ring"
                >
                  {t("serverUpdaterSetupLink")}
                </a>
              )}
            </div>
          )}
          {status.supported && status.updaterSwap && status.updaterSwap.outcome !== "succeeded" && (
            /* A failed or rolled-back self-update is reported by the updater that
             * replaced the one which attempted it — the attempting container is
             * gone, so without this the only trace would be container logs. */
            <div className="w-full order-last rounded-lg bg-red/10 border border-red/30 p-3">
              <p className="text-sm font-semibold text-red">
                {status.updaterSwap.outcome === "rolled-back"
                  ? t("updaterSwapRolledBack")
                  : t("updaterSwapFailed")}
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
                  ? t("updaterOutdated", {
                      current: status.updaterVersion,
                      available: status.availableVersion ?? "",
                    })
                  : t("updaterVersionUnknown")}
              </p>
              {!status.updaterSelfUpdateCapable ? (
                <>
                  <p className="text-sm text-label-secondary mt-1">{t("updaterBootstrapHint")}</p>
                  <pre className="mt-2 text-xs font-mono text-label-secondary whitespace-pre-wrap select-all">
                    docker compose pull updater{"\n"}docker compose up -d --no-deps updater
                  </pre>
                  <a
                    href={COMPOSE_UPGRADE_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex mt-2 text-sm font-medium text-accent underline underline-offset-2 focus-ring"
                  >
                    {t("serverUpdaterSetupLink")}
                  </a>
                </>
              ) : (
                <p className="text-sm text-label-secondary mt-1">
                  {status.updaterSelfUpdateEnabled
                    ? t("updaterAutomaticHint")
                    : t("updaterAutomaticDisabledHint")}
                </p>
              )}
            </div>
          )}
          {canUpdate && status.supported && (
            <div className="flex gap-2">
              <button
                disabled={
                  actionPending || status.state === "updating" || status.state === "checking"
                }
                onClick={() => runAction("check")}
                className="min-h-10 px-3 rounded-md bg-fill-tertiary text-sm font-semibold disabled:opacity-50 focus-ring"
              >
                {status.state === "checking" ? t("serverChecking") : t("serverCheck")}
              </button>
              {status.updateAvailable && (
                <button
                  disabled={
                    actionPending || status.state === "updating" || status.state === "checking"
                  }
                  onClick={() => setConfirmUpdate(true)}
                  className="min-h-10 px-4 rounded-md bg-accent text-on-accent text-sm font-semibold disabled:opacity-50 focus-ring"
                >
                  {status.state === "failed" ? t("serverRetryUpdate") : t("serverInstall")}
                </button>
              )}
            </div>
          )}
        </div>

        {canUpdate && status.supported && (
          <div className="mt-4 pt-4 border-t border-separator flex items-end gap-3 flex-wrap">
            <label className="flex flex-col gap-1 text-xs text-label-secondary">
              {t("serverUpdateMode")}
              <select
                className={selectCls}
                value={updateMode}
                onChange={(event) => {
                  setUpdateMode(event.target.value as "manual" | "automatic");
                  setScheduleDirty(true);
                }}
              >
                <option value="manual">{t("serverModeManual")}</option>
                <option value="automatic">{t("serverModeAutomatic")}</option>
              </select>
            </label>
            {updateMode === "automatic" && (
              <>
                <label className="flex flex-col gap-1 text-xs text-label-secondary">
                  {t("serverMaintenanceTime")}
                  <input
                    className={selectCls}
                    type="time"
                    required
                    value={maintenanceTime}
                    onChange={(event) => {
                      setMaintenanceTime(event.target.value);
                      setScheduleDirty(true);
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-label-secondary flex-1 min-w-[190px]">
                  {t("serverTimezone")}
                  <input
                    className={selectCls}
                    required
                    maxLength={100}
                    value={timezone}
                    placeholder="Europe/Berlin"
                    onChange={(event) => {
                      setTimezone(event.target.value);
                      setScheduleDirty(true);
                    }}
                  />
                </label>
              </>
            )}
            <button
              disabled={actionPending || !scheduleDirty || !maintenanceTime || !timezone}
              onClick={saveSchedule}
              className="min-h-8 px-3 rounded-md bg-accent text-on-accent text-sm font-semibold disabled:opacity-50 focus-ring"
            >
              {t("serverSaveSchedule")}
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmUpdate}
        onClose={() => setConfirmUpdate(false)}
        onConfirm={() => runAction("apply")}
        pending={actionPending}
        title={t("serverConfirmTitle")}
        message={`${t("serverConfirmMessage", { version: status.availableVersion ?? "" })}\n\n${t("serverConfirmSteps")}\n\n${t("serverConfirmDowntime")}`}
        confirmLabel={status.state === "failed" ? t("serverRetryUpdate") : t("serverInstall")}
      />
    </>
  );
}
