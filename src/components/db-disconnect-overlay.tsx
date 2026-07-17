"use client";
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Full-screen overlay shown when the database is unreachable.
 * Blurs the UI and shows reconnection status.
 * Polls /api/v1/health every 5s and auto-dismisses on recovery.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

const POLL_INTERVAL_MS = 5_000;

interface DbHealth {
  connected: boolean;
  circuit: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

export function DbDisconnectOverlay() {
  const t = useTranslations("common");
  const [health, setHealth] = useState<DbHealth | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const res = await fetch("/api/v1/health", { cache: "no-store" });
        const data = await res.json();
        if (!mounted) return;
        const db = data.database as DbHealth;
        setHealth(db);
        setVisible(db.circuit === "open" || (!db.connected && db.consecutiveFailures >= 3));
      } catch {
        if (!mounted) return;
        setVisible(true);
        setHealth(null);
      }
    }

    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => { mounted = false; clearInterval(timer); };
  }, []);

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
                <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
            </div>
          </div>
        </div>

        <h2 className="text-xl font-semibold text-white mb-2">
          {t("databaseUnavailable")}
        </h2>

        <p className="text-gray-400 text-sm mb-4">
          {circuit === "open"
            ? t("databaseHalted")
            : t("databaseRetrying")}
        </p>

        {/* Status details */}
        <div className="bg-gray-800/50 rounded-lg p-4 text-left text-xs font-mono text-gray-500 space-y-1 mb-4">
          <div>{t("status")}: <span className="text-red-400">{circuit}</span></div>
          <div>{t("failures")}: <span className="text-yellow-400">{failures}</span></div>
          {lastError && (
            <div className="truncate">{t("errorLabel")}: <span className="text-gray-400">{lastError.split(":").slice(-1)[0].trim()}</span></div>
          )}
        </div>

        {/* Reconnecting spinner */}
        <div className="flex items-center justify-center gap-2 text-sm text-gray-400">
          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          Attempting to reconnect...
        </div>
      </div>
    </div>
  );
}
