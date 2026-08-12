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
};

function notify() {
  window.dispatchEvent(new Event(EVENT));
}

export function beginUpdateWindow(fromVersion: string | null, toVersion: string | null): void {
  if (typeof window === "undefined") return;
  const value: UpdateWindow = { startedAt: Date.now(), fromVersion, toVersion };
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* Private mode or a full quota: the update still proceeds, the UI just falls
     * back to the plain outage overlay. */
  }
  notify();
}

export function endUpdateWindow(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch { /* see above */ }
  notify();
}

export function readUpdateWindow(): UpdateWindow | null {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(KEY);
  } catch { return null; }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<UpdateWindow>;
    if (typeof value.startedAt !== "number") return null;
    if (Date.now() - value.startedAt > MAX_AGE_MS) {
      endUpdateWindow();
      return null;
    }
    return {
      startedAt: value.startedAt,
      fromVersion: typeof value.fromVersion === "string" ? value.fromVersion : null,
      toVersion: typeof value.toVersion === "string" ? value.toVersion : null,
    };
  } catch {
    endUpdateWindow();
    return null;
  }
}

/** Subscribe to open/close within this tab. Returns an unsubscribe function. */
export function subscribeUpdateWindow(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
