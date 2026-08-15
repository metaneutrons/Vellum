// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The update window is what stops a deliberate restart from being rendered as a
 * database outage. Its failure modes matter more than its happy path: a window
 * that never closes would hide a genuine outage behind a friendly spinner.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  beginUpdateWindow,
  endUpdateWindow,
  readUpdateWindow,
  resolveUpdateWindow,
  serverUpdatePollInterval,
  subscribeUpdateWindow,
  type UpdateStatusSnapshot,
} from "../update-window";

const status = (overrides: Partial<UpdateStatusSnapshot> = {}): UpdateStatusSnapshot => ({
  supported: true,
  state: "updating",
  currentVersion: "v1.10.3",
  updateAvailable: true,
  lastError: null,
  progress: { phase: "deploying" },
  ...overrides,
});

/** Minimal sessionStorage + event target, since this runs in the node environment. */
function installBrowserGlobals() {
  const store = new Map<string, string>();
  const listeners = new Map<string, Set<EventListener>>();
  const win = {
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    addEventListener: (type: string, fn: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: EventListener) => void listeners.get(type)?.delete(fn),
    dispatchEvent: (event: Event) => {
      listeners.get(event.type)?.forEach((fn) => fn(event));
      return true;
    },
  };
  vi.stubGlobal("window", win);
  return { store };
}

describe("update window", () => {
  beforeEach(() => { installBrowserGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("is closed by default, so a plain outage stays an outage", () => {
    expect(readUpdateWindow()).toBeNull();
  });

  it("records the versions being moved between", () => {
    beginUpdateWindow("v1.9.5", "v1.9.6");
    expect(readUpdateWindow()).toMatchObject({ fromVersion: "v1.9.5", toVersion: "v1.9.6" });
  });

  it("survives a reload during the downtime", () => {
    beginUpdateWindow("v1.9.5", "v1.9.6");
    // A reload re-imports the module but keeps sessionStorage; reading again is
    // exactly what the fresh page does.
    expect(readUpdateWindow()).not.toBeNull();
  });

  it("closes on request", () => {
    beginUpdateWindow("v1.9.5", "v1.9.6");
    endUpdateWindow();
    expect(readUpdateWindow()).toBeNull();
  });

  it("expires on its own so it can never hide a real outage forever", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00Z"));
    beginUpdateWindow("v1.9.5", "v1.9.6");
    expect(readUpdateWindow()).not.toBeNull();

    vi.setSystemTime(new Date("2026-08-13T00:14:00Z")); // inside the ceiling
    expect(readUpdateWindow()).not.toBeNull();

    vi.setSystemTime(new Date("2026-08-13T00:16:00Z")); // past it
    expect(readUpdateWindow()).toBeNull();
  });

  it("discards a corrupted marker instead of trusting it", () => {
    const { store } = installBrowserGlobals();
    store.set("vellum.updateWindow", "{not json");
    expect(readUpdateWindow()).toBeNull();
    store.set("vellum.updateWindow", JSON.stringify({ startedAt: "yesterday" }));
    expect(readUpdateWindow()).toBeNull();
  });

  it("notifies subscribers on open and close", () => {
    const seen: (string | null)[] = [];
    const unsubscribe = subscribeUpdateWindow(() => {
      seen.push(readUpdateWindow()?.toVersion ?? null);
    });
    beginUpdateWindow("v1.9.5", "v1.9.6");
    endUpdateWindow();
    unsubscribe();
    beginUpdateWindow("v1.9.6", "v1.9.7"); // after unsubscribe: must not be seen
    expect(seen).toEqual(["v1.9.6", null]);
  });

  it("does not throw when storage is unavailable", () => {
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: () => { throw new Error("denied"); },
        setItem: () => { throw new Error("denied"); },
        removeItem: () => { throw new Error("denied"); },
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    });
    // Private mode must not break the update itself — it only loses the nicer
    // overlay copy.
    expect(() => beginUpdateWindow("v1.9.5", "v1.9.6")).not.toThrow();
    expect(readUpdateWindow()).toBeNull();
  });

  it("does not mistake the old server returning for a successful update", () => {
    const window = { startedAt: Date.now(), fromVersion: "v1.10.3", toVersion: "v1.10.4" };
    expect(resolveUpdateWindow(window, status())).toEqual({ outcome: "pending" });
    expect(resolveUpdateWindow(window, status({ state: "available", progress: { phase: "failed" },
      lastError: "health check failed" }))).toEqual({
      outcome: "failed",
      fromVersion: "v1.10.3",
      toVersion: "v1.10.4",
      currentVersion: "v1.10.3",
      detail: "health check failed",
    });
  });

  it("only reports success after the requested version is actually running", () => {
    const window = { startedAt: Date.now(), fromVersion: "v1.10.3", toVersion: "v1.10.4" };
    expect(resolveUpdateWindow(window, status({ state: "current", currentVersion: "v1.10.4",
      updateAvailable: false, progress: { phase: "done" } }))).toEqual({
      outcome: "succeeded", fromVersion: "v1.10.3", toVersion: "v1.10.4",
    });
    // A newer release winning the race is also a successful outcome.
    expect(resolveUpdateWindow(window, status({ state: "current", currentVersion: "v1.11.0",
      updateAvailable: false, progress: null }))).toMatchObject({ outcome: "succeeded", toVersion: "v1.11.0" });
  });

  it("polls checks responsively without making idle pages noisy", () => {
    expect(serverUpdatePollInterval("checking", false)).toBe(750);
    expect(serverUpdatePollInterval("preparing", false)).toBe(3_000);
    expect(serverUpdatePollInterval("updating", false)).toBe(1_500);
    expect(serverUpdatePollInterval("current", true)).toBe(1_500);
    expect(serverUpdatePollInterval("current", false)).toBe(30_000);
  });
});
