// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The retry ladder a device walks after failed render cycles.
 *
 * It exists because the firmware used to DOUBLE the normal cadence per failure,
 * which made recovery worse the slower the profile: on a 15-minute battery
 * cadence, one dropped request pushed the next attempt to 30 minutes. The ladder
 * has to start below the cadence, and a profile that omits it must not produce a
 * header at all — the device then keeps its normal cadence, which errs toward
 * retrying too often rather than stranding a panel.
 */
import { describe, it, expect } from "vitest";
import { parseRefreshProfile, refreshProfileSchema } from "../index";

describe("errorBackoffS", () => {
  it("defaults to a ladder that starts well below any sane cadence", () => {
    const profile = parseRefreshProfile({});
    expect(profile.errorBackoffS).toEqual([60, 300, 900, 3600]);
    // The first rung is what makes a single failure recover quickly.
    expect(profile.errorBackoffS[0]).toBeLessThan(profile.batteryIntervalS);
  });

  it("is ascending, so walking it always backs off", () => {
    const { errorBackoffS } = parseRefreshProfile({});
    for (let i = 1; i < errorBackoffS.length; i++) {
      expect(errorBackoffS[i]!).toBeGreaterThan(errorBackoffS[i - 1]!);
    }
  });

  it("accepts an operator-supplied ladder", () => {
    const profile = parseRefreshProfile({ errorBackoffS: [30, 120] });
    expect(profile.errorBackoffS).toEqual([30, 120]);
  });

  it("accepts an empty ladder, which suppresses the header entirely", () => {
    const profile = parseRefreshProfile({ errorBackoffS: [] });
    expect(profile.errorBackoffS).toEqual([]);
  });

  it("rejects a zero or negative rung — the firmware would busy-loop its radio", () => {
    expect(refreshProfileSchema.safeParse({ errorBackoffS: [0, 60] }).success).toBe(false);
    expect(refreshProfileSchema.safeParse({ errorBackoffS: [-5] }).success).toBe(false);
    expect(refreshProfileSchema.safeParse({ errorBackoffS: [1.5] }).success).toBe(false);
  });

  it("rejects a ladder longer than the firmware's RENDER_BACKOFF_MAX_STEPS", () => {
    const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(refreshProfileSchema.safeParse({ errorBackoffS: nine }).success).toBe(false);
    expect(refreshProfileSchema.safeParse({ errorBackoffS: nine.slice(0, 8) }).success).toBe(true);
  });

  it("falls back to the whole default profile on a malformed ladder", () => {
    // parseRefreshProfile is deliberately total — a bad stored config must not
    // take down /api/v1/ink/render.
    const profile = parseRefreshProfile({ errorBackoffS: "60,300" });
    expect(profile.errorBackoffS).toEqual([60, 300, 900, 3600]);
  });

  it("serializes to the exact X-Error-Backoff wire format the firmware parses", () => {
    const { errorBackoffS } = parseRefreshProfile({});
    // render_backoff_parse() in firmware/components/sleep_manager: comma-separated
    // positive integers, no units, no spaces required.
    expect(errorBackoffS.join(",")).toBe("60,300,900,3600");
    expect(errorBackoffS.join(",")).toMatch(/^\d+(,\d+)*$/);
  });
});
