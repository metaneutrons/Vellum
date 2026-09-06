"use client";
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Full-screen overlay shown when the database is unreachable.
 * Blurs the UI and shows reconnection status.
 * Polls /api/v1/health every 5s and auto-dismisses on recovery.
 */

import { useEffect, useState } from "react";
import { z } from "zod";
import { AlertTriangle, CheckCircle2, LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { ServerUpdateProgress } from "@/components/server-update-progress";
import type { ServerUpdateStatus } from "@/lib/server-updater";
import type { UpdateProgress } from "@/lib/update-progress";
import {
  endUpdateWindow,
  progressForUpdateWindow,
  readUpdateWindow,
  recordUpdateWindowProgress,
  resolveUpdateOverlay,
  subscribeUpdateWindow,
  type UpdateResolution,
  type UpdateWindow,
} from "@/lib/update-window";

const POLL_INTERVAL_MS = 5_000;

interface DbHealth {
  connected: boolean;
  circuit: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

/**
 * The database-unavailable overlay.
 *
 * DELIBERATELY dark in both themes, which is why this file is listed as an
 * exception in `scripts/check-theme-tokens.mjs` rather than converted. It is a
 * blocking, full-viewport alert over a blurred backdrop, and a system alert that
 * looks the same whatever the page behind it is doing is a choice, not an
 * oversight. The colours that carry MEANING — the fault icon, the circuit state,
 * the failure count — use the tokens, because those have to stay recognisable
 * against the rest of the admin.
 */
/* Only the branch this overlay reacts to. A health endpoint that answers
 * something else leaves the overlay as it is rather than throwing inside a
 * poll loop. */
const healthAnswer = z.object({
  database: z.object({
    connected: z.boolean(),
    circuit: z.enum(["closed", "open", "half-open"]),
    consecutiveFailures: z.number(),
    lastError: z.string().nullable(),
    lastErrorAt: z.string().nullable(),
  }),
});

export function DbDisconnectOverlay() {
  const t = useTranslations("common");
  const [health, setHealth] = useState<DbHealth | null>(null);
  const [visible, setVisible] = useState(false);
  /* A server update replaces this very container, so its own health probe is
   * expected to fail. Without this the operator saw a red database error in the
   * middle of a deliberate, healthy update. */
  const [updating, setUpdating] = useState<UpdateWindow | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [outcome, setOutcome] = useState<Exclude<UpdateResolution, { outcome: "pending" }> | null>(
    null
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const res = await fetch("/api/v1/health", { cache: "no-store" });
        const parsed = healthAnswer.safeParse(await res.json());
        if (!mounted || !parsed.success) return;
        const db = parsed.data.database;
        setHealth(db);
        setVisible(db.circuit === "open" || (!db.connected && db.consecutiveFailures >= 3));
      } catch {
        if (!mounted) return;
        setVisible(true);
        setHealth(null);
      }
    }

    void poll();
    /* Poll faster while an update is running: the sooner the server answers, the
     * sooner this overlay gets out of the way. */
    const timer = setInterval(() => void poll(), updating ? 2_000 : POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [updating]);

  useEffect(() => {
    const sync = () => {
      const next = readUpdateWindow();
      setUpdating(next);
      if (next) {
        setProgress(
          next.progress ?? {
            phase: "verifying",
            detail: null,
            at: null,
            startedAt: new Date(next.startedAt).toISOString(),
          }
        );
        setOutcome(null);
        setReconnecting(false);
      }
    };
    sync();
    return subscribeUpdateWindow(sync);
  }, []);

  useEffect(() => {
    if (!updating || outcome) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const response = await fetch("/api/v1/admin/server-update", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const status = (await response.json()) as ServerUpdateStatus;
        if (cancelled) return;
        setReconnecting(!status.supported);
        const currentProgress = progressForUpdateWindow(updating, status.progress);
        if (status.supported && currentProgress) {
          setProgress(currentProgress);
          recordUpdateWindowProgress(currentProgress);
        }
        /* Rolling back is an active recovery operation, not yet a terminal
         * failure. Keep polling so the operator sees whether recovery itself
         * completes or fails. */
        const resolution = resolveUpdateOverlay(updating, {
          ...status,
          progress: currentProgress,
        });
        if (resolution.outcome !== "pending") {
          if (resolution.outcome === "succeeded" && !currentProgress) {
            setProgress({
              phase: "done",
              detail: null,
              at: new Date().toISOString(),
              startedAt: new Date(updating.startedAt).toISOString(),
            });
          }
          setOutcome(resolution);
          setReconnecting(false);
          return;
        }
      } catch {
        if (!cancelled) setReconnecting(true);
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1_500);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [outcome, updating]);

  useEffect(() => {
    if (outcome?.outcome !== "succeeded") return;
    const timer = setTimeout(endUpdateWindow, 2_200);
    return () => clearTimeout(timer);
  }, [outcome]);

  useEffect(() => {
    if (!updating) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [updating]);

  if (updating) {
    const elapsed = Math.max(0, Math.round((now - updating.startedAt) / 1000));
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    return (
      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-update-overlay-title"
      >
        <div className="absolute inset-0 backdrop-blur-md bg-black/45" />
        <div
          className="relative z-10 max-w-lg w-full rounded-3xl bg-surface/95 border border-separator p-6 sm:p-8 shadow-2xl"
          aria-live={outcome?.outcome === "failed" ? "assertive" : "polite"}
        >
          <div className="flex justify-center mb-5" aria-hidden="true">
            <div
              className={`grid size-14 place-items-center rounded-full ${
                outcome?.outcome === "succeeded"
                  ? "bg-green/15 text-green"
                  : outcome?.outcome === "failed"
                    ? "bg-red/15 text-red"
                    : "bg-accent/15 text-accent"
              }`}
            >
              {outcome?.outcome === "succeeded" ? (
                <CheckCircle2 size={29} />
              ) : outcome?.outcome === "failed" ? (
                <AlertTriangle size={28} />
              ) : (
                <LoaderCircle size={29} className="animate-spin" />
              )}
            </div>
          </div>
          <div className="text-center">
            <h2 id="server-update-overlay-title" className="text-xl font-semibold text-label">
              {outcome?.outcome === "succeeded"
                ? t("updateCompleteTitle")
                : outcome?.outcome === "failed"
                  ? t("updateFailedTitle")
                  : t("updateRestartTitle")}
            </h2>
            <p className="mt-1.5 text-sm text-label-secondary">
              {updating.fromVersion && updating.toVersion
                ? t("updateVersionTransition", {
                    from: updating.fromVersion,
                    to: updating.toVersion,
                  })
                : updating.toVersion
                  ? t("updateRestartToVersion", { version: updating.toVersion })
                  : t("updateRestartBody")}
            </p>
          </div>

          {progress && (
            <div className="mt-6">
              <ServerUpdateProgress progress={progress} elevated />
            </div>
          )}

          <div className="mt-5 text-center">
            <p
              className={`text-sm ${outcome?.outcome === "failed" ? "text-red" : "text-label-secondary"}`}
            >
              {outcome?.outcome === "succeeded"
                ? t("updateCompleteBody")
                : outcome?.outcome === "failed"
                  ? (outcome.detail ?? t("updateFailedBody"))
                  : reconnecting
                    ? t("updateConnectionRestoring")
                    : t("updateInProgressBody")}
            </p>
            {!outcome && (
              <p aria-hidden="true" className="mt-2 text-xs font-mono text-label-tertiary">
                {t("updateRestartElapsed", {
                  elapsed: minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`,
                })}
              </p>
            )}
            {outcome?.outcome === "failed" && (
              <button
                autoFocus
                onClick={endUpdateWindow}
                className="mt-5 min-h-10 rounded-lg bg-fill-tertiary px-4 text-sm font-semibold text-label focus-ring"
              >
                {t("close")}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!visible) return null;

  const failures = health?.consecutiveFailures ?? 0;
  const lastError = health?.lastError ?? "Connection lost";
  const circuit = health?.circuit ?? "open";

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      role="alert"
      aria-live="assertive"
    >
      {/* Blur backdrop */}
      <div className="absolute inset-0 backdrop-blur-md bg-black/40" />

      {/* Content */}
      <div className="relative z-10 max-w-md w-full mx-4 rounded-2xl bg-gray-900/95 border border-gray-700 p-8 shadow-2xl text-center">
        {/* Animated pulse indicator */}
        <div className="flex justify-center mb-6">
          <div className="relative">
            <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center">
              <div className="w-10 h-10 rounded-full bg-red-500/40 flex items-center justify-center animate-pulse">
                <svg
                  className="h-6 w-6 text-red"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
              </div>
            </div>
          </div>
        </div>

        <h2 className="text-xl font-semibold text-white mb-2">{t("databaseUnavailable")}</h2>

        <p className="text-gray-400 text-sm mb-4">
          {circuit === "open" ? t("databaseHalted") : t("databaseRetrying")}
        </p>

        {/* Status details */}
        <div className="bg-gray-800/50 rounded-lg p-4 text-left text-xs font-mono text-gray-500 space-y-1 mb-4">
          <div>
            {t("status")}: <span className="text-red">{circuit}</span>
          </div>
          <div>
            {t("failures")}: <span className="text-orange">{failures}</span>
          </div>
          {lastError && (
            <div className="truncate">
              {t("errorLabel")}:{" "}
              <span className="text-gray-400">{lastError.split(":").slice(-1)[0].trim()}</span>
            </div>
          )}
        </div>

        {/* Reconnecting spinner */}
        <div className="flex items-center justify-center gap-2 text-sm text-gray-400">
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          {t("databaseReconnecting")}
        </div>
      </div>
    </div>
  );
}
