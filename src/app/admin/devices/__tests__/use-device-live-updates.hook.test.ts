// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Covers the hook's wiring rather than its merge helper.
 *
 * The reported regression lived entirely in the wiring: reassigning a device's
 * content applied the change, but the dropdown snapped back until the page was
 * reloaded, because `useState(initialDevices)` seeds once and ignores every later
 * prop. `mergeDeviceRows` was correct throughout and its unit tests all passed,
 * so only rendering the hook can catch this class of bug.
 *
 * This is the one suite that needs a DOM. It opts in per file via the docblock
 * above, leaving the project default of `environment: "node"` untouched for
 * every other test.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDeviceLiveUpdates, type LiveDeviceRow } from "../use-device-live-updates";

/* jsdom implements neither EventSource nor a usable fetch for this hook, and the
 * hook opens both from an effect. The stub keeps a reference to the instance so a
 * test can drive onmessage, and fetch rejects: refresh() catches that and only
 * flips the connection state, so a stray poll can never mutate the rows a test is
 * asserting on. */
class StubEventSource {
  static last: StubEventSource | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    StubEventSource.last = this;
  }
  close() {
    this.closed = true;
  }
}

vi.stubGlobal("EventSource", StubEventSource);
vi.stubGlobal(
  "fetch",
  vi.fn(() => Promise.reject(new Error("network disabled in test")))
);

const device = (mac: string, contentInstanceId: string | null): LiveDeviceRow => ({
  mac,
  content_instance_id: contentInstanceId,
});

afterEach(() => {
  StubEventSource.last = null;
});

describe("useDeviceLiveUpdates", () => {
  it("adopts a reassignment delivered as new props without a remount", () => {
    const before = [device("A", "old"), device("B", null)];
    const { result, rerender } = renderHook((rows: LiveDeviceRow[]) => useDeviceLiveUpdates(rows), {
      initialProps: before,
    });

    expect(result.current.devices[0]!.content_instance_id).toBe("old");

    // What revalidatePath() produces after updateDevice: same route, new rows.
    rerender([device("A", "new"), device("B", null)]);

    expect(result.current.devices[0]!.content_instance_id).toBe("new");
    expect(result.current.devices.map((d) => d.mac)).toEqual(["A", "B"]);
  });

  it("keeps card order when the server reports devices in a different order", () => {
    const { result, rerender } = renderHook((rows: LiveDeviceRow[]) => useDeviceLiveUpdates(rows), {
      initialProps: [device("A", null), device("B", null), device("C", null)],
    });

    rerender([device("C", null), device("B", "assigned"), device("A", null)]);

    expect(result.current.devices.map((d) => d.mac)).toEqual(["A", "B", "C"]);
    expect(result.current.devices[1]!.content_instance_id).toBe("assigned");
  });

  it("drops a device the server no longer reports", () => {
    const { result, rerender } = renderHook((rows: LiveDeviceRow[]) => useDeviceLiveUpdates(rows), {
      initialProps: [device("A", null), device("B", null)],
    });

    rerender([device("A", null)]);

    expect(result.current.devices.map((d) => d.mac)).toEqual(["A"]);
  });

  /* Guards the loop the adoption effect can otherwise cause. The effect keys on
   * the prop's identity, so a caller building the array inline hands it a fresh
   * identity every render; before the hook bailed out on unchanged content this
   * exhausted memory and took the whole vitest worker down rather than failing. */
  it("settles when the caller rebuilds the prop array on every render", () => {
    const { result, rerender } = renderHook(() =>
      useDeviceLiveUpdates([device("A", "assigned"), device("B", null)])
    );

    rerender();
    rerender();

    expect(result.current.devices.map((d) => d.mac)).toEqual(["A", "B"]);
    expect(result.current.devices[0]!.content_instance_id).toBe("assigned");
  });

  it("subscribes to the device event stream and closes it on unmount", () => {
    const stable = [device("A", null)];
    const { unmount } = renderHook(() => useDeviceLiveUpdates(stable));

    const source = StubEventSource.last;
    expect(source?.url).toBe("/api/v1/admin/devices/events");
    expect(source?.closed).toBe(false);

    unmount();
    expect(source?.closed).toBe(true);
  });
});
