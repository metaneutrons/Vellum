// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, it, expect } from "vitest";
import { deviceConnectivity, connectivityTone, DEFAULT_INTERVAL_S } from "./connectivity";

const NOW = 1_700_000_000_000; // fixed epoch ms — no Date.now() in tests
/** lastSeen `sec` seconds before NOW. */
const seenAgo = (sec: number) => NOW - sec * 1000;

describe("deviceConnectivity", () => {
  it("reports 'never' when the device has never checked in", () => {
    expect(deviceConnectivity(null, 900, NOW)).toBe("never");
  });

  it("is 'online' up to 1.5× the interval (+grace)", () => {
    expect(deviceConnectivity(seenAgo(0), 900, NOW)).toBe("online");
    expect(deviceConnectivity(seenAgo(900), 900, NOW)).toBe("online"); // 1×
    expect(deviceConnectivity(seenAgo(1410), 900, NOW)).toBe("online"); // 1.5× + 60s grace boundary
  });

  it("is 'late' between 1.5× and 3× the interval", () => {
    expect(deviceConnectivity(seenAgo(1411), 900, NOW)).toBe("late");
    expect(deviceConnectivity(seenAgo(2760), 900, NOW)).toBe("late"); // 3× + grace boundary
  });

  it("is 'offline' beyond 3× the interval", () => {
    expect(deviceConnectivity(seenAgo(2761), 900, NOW)).toBe("offline");
    expect(deviceConnectivity(seenAgo(100000), 900, NOW)).toBe("offline");
  });

  it("respects each device's OWN cadence, not a fixed window", () => {
    // USB display (60s cadence) unseen for 5 min → clearly offline
    expect(deviceConnectivity(seenAgo(300), 60, NOW)).toBe("offline");
    // low-battery display (1h cadence) seen 1h ago → still online
    // (a fixed 1-hour window would wrongly call this "offline")
    expect(deviceConnectivity(seenAgo(3600), 3600, NOW)).toBe("online");
  });

  it("falls back to DEFAULT_INTERVAL_S when the interval is missing or zero", () => {
    expect(DEFAULT_INTERVAL_S).toBe(900);
    expect(deviceConnectivity(seenAgo(600), null, NOW)).toBe("online");
    expect(deviceConnectivity(seenAgo(600), undefined, NOW)).toBe("online");
    expect(deviceConnectivity(seenAgo(600), 0, NOW)).toBe("online");
  });

  it("maps states to badge tones", () => {
    expect(connectivityTone("online")).toBe("green");
    expect(connectivityTone("late")).toBe("orange");
    expect(connectivityTone("offline")).toBe("red");
    expect(connectivityTone("never")).toBe("neutral");
  });
});
