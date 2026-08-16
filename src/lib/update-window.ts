// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Client-side marker for "this browser started a server update".
 *
 * During an update the server container is replaced, so every request from this
 * page fails — including the health probe behind the database overlay. That made
 * a deliberate, healthy restart look like a database outage. The panel opens a
 * window before the restart and closes it once the server answers again; the
 * overlay reads it and shows "restarting" instead of an error.
 *
 * `sessionStorage`, not React state: the tab may be reloaded (or the user may
 * navigate) while the server is down, and the window has to survive that. It is
 * per-tab by design — another tab that did not start the update should still see
 * a genuine outage as an outage.
 */

import type { UpdateProgress, UpdateProgressPhase } from "@/lib/update-progress";

const KEY = "vellum.updateWindow";
const EVENT = "vellum:update-window";

/** Hard ceiling. A forgotten window must never hide a real outage forever, so it
 * expires even if the page never sees the server come back. */
const MAX_AGE_MS = 15 * 60 * 1000;

export type UpdateWindow = {
  /** epoch ms, for elapsed-time display */
  startedAt: number;
  fromVersion: string | null;
  toVersion: string | null;
  /** Last updater-journal entry observed before a restart made the API
   * temporarily unreachable. Persisting it prevents the progress UI from
   * collapsing into an information-poor spinner during the critical phase. */
  progress?: UpdateProgress | null;
};

export type UpdateStatusSnapshot = {
  supported: boolean;
  state:
    | "unavailable"
    | "starting"
    | "checking"
    | "preparing"
    | "available"
    | "updating"
    | "current"
    | "failed";
  currentVersion: string | null;
  updateAvailable: boolean;
  lastError: string | null;
  progress: {
    phase:
      | "verifying"
      | "backing-up"
      | "deploying"
      | "waiting-for-health"
      | "done"
      | "rolling-back"
      | "failed";
  } | null;
};

export type UpdateResolution =
  | { outcome: "pending" }
  | { outcome: "succeeded"; fromVersion: string | null; toVersion: string }
  | {
      outcome: "failed";
      fromVersion: string | null;
      toVersion: string | null;
      currentVersion: string | null;
      detail: string | null;
    };

function versionParts(value: string | null): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `current` has reached (or passed) the version this tab requested.
 * Passing the target is valid when another automatic update won the race. */
function reachedVersion(current: string | null, target: string | null): boolean {
  const a = versionParts(current);
  const b = versionParts(target);
  if (!a || !b) return current !== null && target !== null && current === target;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return true;
}

/** Resolve an update only from authoritative evidence. A server answering again
 * is not success: it may be the old container after a failed deployment or
 * rollback. This distinction prevents claims such as "v1.10.3 → v1.10.3". */
export function resolveUpdateWindow(
  window: UpdateWindow,
  status: UpdateStatusSnapshot
): UpdateResolution {
  const terminalFailure =
    status.state === "failed" ||
    status.progress?.phase === "failed" ||
    status.progress?.phase === "rolling-back";
  const oldVersionSettled = Boolean(
    window.toVersion &&
    status.currentVersion &&
    ["available", "current"].includes(status.state) &&
    status.updateAvailable
  );
  if (terminalFailure || oldVersionSettled) {
    return {
      outcome: "failed",
      fromVersion: window.fromVersion,
      toVersion: window.toVersion,
      currentVersion: status.currentVersion,
      detail: status.lastError,
    };
  }

  const reached = status.currentVersion;
  if (reached && reachedVersion(reached, window.toVersion)) {
    return { outcome: "succeeded", fromVersion: window.fromVersion, toVersion: reached };
  }

  return { outcome: "pending" };
}

/** A rollback is still making progress. Keep the overlay open until the updater
 * reports whether restoration itself succeeded or failed. */
export function resolveUpdateOverlay(
  window: UpdateWindow,
  status: UpdateStatusSnapshot
): UpdateResolution {
  if (status.progress?.phase === "rolling-back") return { outcome: "pending" };
  return resolveUpdateWindow(window, status);
}

/** Active operations need responsive polling; idle pages deliberately stay
 * quiet. Kept pure so the timing contract is regression-tested. */
export function serverUpdatePollInterval(
  state: UpdateStatusSnapshot["state"],
  updateWindowOpen: boolean
): number {
  if (state === "checking") return 750;
  if (state === "preparing") return 3_000;
  if (state === "updating" || updateWindowOpen) return 1_500;
  return 30_000;
}

function notify() {
  window.dispatchEvent(new Event(EVENT));
}

export function beginUpdateWindow(
  fromVersion: string | null,
  toVersion: string | null,
  progress: UpdateProgress | null = null
): boolean {
  if (typeof window === "undefined") return false;
  /* Never create a success marker for a no-op or stale snapshot. The updater may
   * have completed a concurrent check between rendering and clicking; recording
   * 1.10.4 -> 1.10.4 would later become a false green success banner. */
  if (!toVersion || (fromVersion !== null && reachedVersion(fromVersion, toVersion))) return false;
  const value: UpdateWindow = { startedAt: Date.now(), fromVersion, toVersion, progress };
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* Private mode or a full quota: the update still proceeds, the UI just falls
     * back to the plain outage overlay. */
  }
  notify();
  return true;
}

/** Persist progress without broadcasting an open/close event. The overlay owns
 * the live state already; this copy exists so a reload or container restart can
 * restore the same rows without a visual jump. */
export function recordUpdateWindowProgress(progress: UpdateProgress): void {
  if (typeof window === "undefined") return;
  const current = readUpdateWindow();
  if (!current) return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ ...current, progress }));
  } catch {
    /* The update continues even when storage is unavailable. */
  }
}

export function endUpdateWindow(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* see above */
  }
  notify();
}

export function readUpdateWindow(): UpdateWindow | null {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<UpdateWindow>;
    if (typeof value.startedAt !== "number") return null;
    if (Date.now() - value.startedAt > MAX_AGE_MS) {
      endUpdateWindow();
      return null;
    }
    const progress = parseStoredProgress(value.progress);
    return {
      startedAt: value.startedAt,
      fromVersion: typeof value.fromVersion === "string" ? value.fromVersion : null,
      toVersion: typeof value.toVersion === "string" ? value.toVersion : null,
      progress,
    };
  } catch {
    endUpdateWindow();
    return null;
  }
}

const UPDATE_PHASES: readonly UpdateProgressPhase[] = [
  "verifying",
  "backing-up",
  "deploying",
  "waiting-for-health",
  "done",
  "rolling-back",
  "failed",
];

function parseStoredProgress(value: unknown): UpdateProgress | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<UpdateProgress>;
  if (!UPDATE_PHASES.includes(candidate.phase as UpdateProgressPhase)) return null;
  const nullableString = (item: unknown, max: number): string | null | undefined =>
    item === null ? null : typeof item === "string" && item.length <= max ? item : undefined;
  const detail = nullableString(candidate.detail, 200);
  const at = nullableString(candidate.at, 64);
  const startedAt = nullableString(candidate.startedAt, 64);
  if (detail === undefined || at === undefined || startedAt === undefined) return null;
  const failedPhase =
    candidate.failedPhase == null
      ? null
      : UPDATE_PHASES.includes(candidate.failedPhase as UpdateProgressPhase)
        ? (candidate.failedPhase as UpdateProgressPhase)
        : undefined;
  if (
    failedPhase === undefined ||
    (candidate.rollbackAttempted !== undefined && typeof candidate.rollbackAttempted !== "boolean")
  )
    return null;
  return {
    phase: candidate.phase as UpdateProgressPhase,
    detail,
    at,
    startedAt,
    failedPhase,
    rollbackAttempted: candidate.rollbackAttempted,
  };
}

/** Subscribe to open/close within this tab. Returns an unsubscribe function. */
export function subscribeUpdateWindow(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
