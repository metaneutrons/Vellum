// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { Check, Circle, LoaderCircle, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { updateProgressRows, type UpdateProgress } from "@/lib/update-progress";

const PHASE_KEYS = {
  verifying: "phaseVerifying",
  "backing-up": "phaseBackingUp",
  deploying: "phaseDeploying",
  "waiting-for-health": "phaseWaitingForHealth",
  "rolling-back": "phaseRollingBack",
} as const;

export function ServerUpdateProgress({
  progress,
  elevated = false,
}: {
  progress: UpdateProgress;
  elevated?: boolean;
}) {
  const t = useTranslations("system");

  return (
    <ol
      aria-label={t("serverUpdateProgress")}
      className={`space-y-2.5 rounded-xl border p-4 ${
        elevated
          ? "bg-fill-tertiary/50 border-separator/70"
          : "bg-fill-tertiary/40 border-separator/50"
      }`}
    >
      {updateProgressRows(progress).map(({ phase, state }) => (
        <li key={phase} className="flex items-center gap-3 text-sm">
          <span
            aria-hidden="true"
            className={`grid size-5 shrink-0 place-items-center rounded-full ${
              state === "done"
                ? "bg-green/15 text-green"
                : state === "failed"
                  ? "bg-red/15 text-red"
                  : state === "active"
                    ? "bg-accent/15 text-accent"
                    : "text-label-tertiary"
            }`}
          >
            {state === "done" ? (
              <Check size={14} strokeWidth={2.5} />
            ) : state === "failed" ? (
              <X size={14} strokeWidth={2.5} />
            ) : state === "active" ? (
              <LoaderCircle size={15} className="animate-spin" />
            ) : (
              <Circle size={11} />
            )}
          </span>
          <span
            className={
              state === "pending"
                ? "text-label-tertiary"
                : state === "failed"
                  ? "text-red font-medium"
                  : "text-label"
            }
          >
            {t(PHASE_KEYS[phase])}
          </span>
        </li>
      ))}
    </ol>
  );
}
