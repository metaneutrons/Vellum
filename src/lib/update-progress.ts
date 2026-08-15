// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

export const UPDATE_MAIN_PHASES = [
  "verifying",
  "backing-up",
  "deploying",
  "waiting-for-health",
] as const;

export type UpdateMainPhase = typeof UPDATE_MAIN_PHASES[number];
export type UpdateProgressPhase = UpdateMainPhase | "done" | "rolling-back" | "failed";
export type UpdateStepState = "pending" | "active" | "done" | "failed";

export type UpdateProgress = {
  phase: UpdateProgressPhase;
  detail: string | null;
  at: string | null;
  startedAt: string | null;
  /** The step that originally failed. It remains stable while rollback runs. */
  failedPhase?: UpdateProgressPhase | null;
  rollbackAttempted?: boolean;
};

export type UpdateProgressRow = {
  phase: UpdateMainPhase | "rolling-back";
  state: UpdateStepState;
};

/** Convert the updater journal into stable UI rows. Terminal states deliberately
 * remain visible: the operator must be able to see which step failed and whether
 * rollback completed after the server starts answering again. */
export function updateProgressRows(progress: UpdateProgress): UpdateProgressRow[] {
  const terminalFailure = progress.phase === "failed" || progress.phase === "rolling-back";
  const failedPhase = progress.failedPhase && UPDATE_MAIN_PHASES.includes(progress.failedPhase as UpdateMainPhase)
    ? progress.failedPhase as UpdateMainPhase
    : terminalFailure ? "deploying" : null;
  const failedIndex = failedPhase ? UPDATE_MAIN_PHASES.indexOf(failedPhase) : -1;
  const activeIndex = UPDATE_MAIN_PHASES.indexOf(progress.phase as UpdateMainPhase);

  const rows: UpdateProgressRow[] = UPDATE_MAIN_PHASES.map((phase, index) => {
    if (progress.phase === "done") return { phase, state: "done" };
    if (terminalFailure) {
      if (index < failedIndex) return { phase, state: "done" };
      if (index === failedIndex) return { phase, state: "failed" };
      return { phase, state: "pending" };
    }
    if (index < activeIndex) return { phase, state: "done" };
    if (index === activeIndex) return { phase, state: "active" };
    return { phase, state: "pending" };
  });

  if (progress.rollbackAttempted || progress.phase === "rolling-back") {
    rows.push({
      phase: "rolling-back",
      state: progress.phase === "rolling-back"
        ? "active"
        : progress.failedPhase === "rolling-back" ? "failed" : "done",
    });
  }
  return rows;
}
