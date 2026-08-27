// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

import { describe, expect, it } from "vitest";
import {
  computeDisplayPower,
  computeSleep,
  resolveActiveScheduleRule,
  unifiedRefreshProfileSchema,
  upgradeRefreshProfileConfig,
} from "../index";
import { evaluateBrightness, parseBrightnessPolicy } from "@/lib/settings/brightness";

const now = new Date("2026-08-27T10:30:00Z");

describe("enterprise profile policy", () => {
  it("uses one active phase for cadence, display power and brightness", () => {
    const profile = upgradeRefreshProfileConfig({
      version: 2,
      schedule: [
        {
          name: "first",
          days: [],
          startHour: 0,
          endHour: 0,
          usb: { intervalS: 60, brightnessPercent: 80, display: "on", device: "awake" },
          battery: { intervalS: 900 },
        },
        {
          name: "must-not-leak",
          days: [],
          startHour: 0,
          endHour: 0,
          usb: { intervalS: 7200, brightnessPercent: 0, display: "off", device: "sleep" },
          battery: { intervalS: 7200 },
        },
      ],
      brightness: { usbPercent: 80, batteryPercent: 40, schedule: [] },
    });

    expect(resolveActiveScheduleRule(profile, now)?.name).toBe("first");
    expect(
      computeSleep({
        profile,
        now,
        timezone: "UTC",
        powerSource: "usb",
        batteryLevel: 100,
        nextEventStart: null,
      })
    ).toMatchObject({ durationS: 60, mode: "poll", rule: "first" });
    expect(
      computeDisplayPower({ profile, now, timezone: "UTC", powerSource: "usb" })
    ).toMatchObject({ state: "on", rule: "first" });
    expect(
      evaluateBrightness({
        policy: parseBrightnessPolicy(profile),
        now,
        timezone: "UTC",
        powerSource: "usb",
      })
    ).toMatchObject({ percent: 80, rule: "first" });
  });

  it("supports quarter-hour phase boundaries", () => {
    const profile = upgradeRefreshProfileConfig({
      version: 2,
      schedule: [
        {
          name: "quarter",
          days: [],
          startHour: 10.25,
          endHour: 10.75,
          usb: { intervalS: 120 },
          battery: { intervalS: 120 },
        },
      ],
      brightness: { usbPercent: 80, batteryPercent: 40, schedule: [] },
    });
    expect(resolveActiveScheduleRule(profile, now, "UTC")?.name).toBe("quarter");
  });

  it.each([
    { usbIntervalS: -1 },
    { usbIntervalS: 1.5 },
    { lowBatteryThresholdPct: 101 },
    { errorBackoffS: [300, 60] },
    { imminentEventWindowS: 60, wakeBeforeEventS: 300 },
    {
      schedule: [{ name: "bad", days: [1, 1], startHour: 8, endHour: 9, usb: {}, battery: {} }],
    },
  ])("rejects invalid policy %#", (patch) => {
    expect(
      unifiedRefreshProfileSchema.safeParse({
        ...upgradeRefreshProfileConfig({}),
        ...patch,
      }).success
    ).toBe(false);
  });

  it("uses real next-event timing when no scheduled phase overrides it", () => {
    const profile = upgradeRefreshProfileConfig({
      imminentEventWindowS: 1200,
      wakeBeforeEventS: 300,
    });
    expect(
      computeSleep({
        profile,
        now,
        powerSource: "battery",
        batteryLevel: 80,
        nextEventStart: new Date(now.getTime() + 600_000),
      })
    ).toMatchObject({ durationS: 300, tier: "imminent-event" });
  });
});
