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
  subscribeUpdateWindow,
} from "../update-window";

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
});
