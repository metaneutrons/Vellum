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

  it("upgrades historical ordinary values into explicit source defaults", () => {
    const profile = upgradeRefreshProfileConfig({
      version: 2,
      usbIntervalS: 120,
      batteryIntervalS: 1800,
      brightness: { usbPercent: 65, batteryPercent: 25, schedule: [] },
    });

    expect(profile).toMatchObject({
      version: 3,
      defaults: {
        usb: { intervalS: 120, brightnessPercent: 65, display: "on", device: "awake" },
        battery: {
          intervalS: 1800,
          brightnessPercent: 25,
          display: "on",
          device: "awake",
        },
      },
      usbIntervalS: 120,
      batteryIntervalS: 1800,
      brightness: { usbPercent: 65, batteryPercent: 25, schedule: [] },
    });
  });

  it("uses explicit ordinary display, cadence, brightness and sleep behaviour", () => {
    const profile = upgradeRefreshProfileConfig({
      version: 3,
      defaults: {
        usb: { intervalS: 90, brightnessPercent: 70, display: "on", device: "awake" },
        battery: {
          intervalS: 2400,
          brightnessPercent: 15,
          display: "off",
          device: "sleep",
        },
      },
      schedule: [],
    });

    expect(
      computeSleep({
        profile,
        now,
        powerSource: "battery",
        batteryLevel: 80,
        nextEventStart: null,
      })
    ).toMatchObject({
      durationS: 2400,
      mode: "sleep",
      tier: "power-default",
      devicePolicy: "sleep",
    });
    expect(computeDisplayPower({ profile, now, powerSource: "battery" })).toEqual({
      state: "off",
      tier: "power-default",
    });
    expect(
      evaluateBrightness({
        policy: parseBrightnessPolicy(profile),
        now,
        powerSource: "battery",
      })
    ).toMatchObject({ percent: 15, tier: "power-default" });
  });

  it("lets a phase explicitly resume normal cadence over an ordinary sleep policy", () => {
    const profile = upgradeRefreshProfileConfig({
      version: 3,
      defaults: {
        usb: { intervalS: 60, brightnessPercent: 80, display: "on", device: "awake" },
        battery: {
          intervalS: 1800,
          brightnessPercent: 20,
          display: "off",
          device: "sleep",
        },
      },
      schedule: [
        {
          name: "office",
          days: [],
          startHour: 0,
          endHour: 0,
          battery: { intervalS: 300, display: "on", device: "awake" },
        },
      ],
    });

    expect(
      computeSleep({
        profile,
        now,
        powerSource: "battery",
        batteryLevel: 80,
        nextEventStart: null,
      })
    ).toMatchObject({ durationS: 300, mode: "poll", rule: "office" });
    expect(computeDisplayPower({ profile, now, powerSource: "battery" })).toMatchObject({
      state: "on",
      rule: "office",
    });
  });

  it("rejects an illuminated panel paired with ordinary controller sleep", () => {
    const profile = upgradeRefreshProfileConfig({});
    expect(
      unifiedRefreshProfileSchema.safeParse({
        ...profile,
        defaults: {
          ...profile.defaults,
          battery: { ...profile.defaults.battery, display: "on", device: "sleep" },
        },
      }).success
    ).toBe(false);
  });

  it("rejects stale rollback mirrors in a version-3 write", () => {
    const profile = upgradeRefreshProfileConfig({});
    expect(unifiedRefreshProfileSchema.safeParse({ ...profile, usbIntervalS: 999 }).success).toBe(
      false
    );
    expect(
      unifiedRefreshProfileSchema.safeParse({
        ...profile,
        brightness: { ...profile.brightness, batteryPercent: 99 },
      }).success
    ).toBe(false);
  });

  it("rejects a phase display-on override that inherits ordinary controller sleep", () => {
    const profile = upgradeRefreshProfileConfig({
      version: 3,
      defaults: {
        usb: { intervalS: 60, brightnessPercent: 80, display: "on", device: "awake" },
        battery: {
          intervalS: 900,
          brightnessPercent: 40,
          display: "off",
          device: "sleep",
        },
      },
      schedule: [],
    });
    expect(
      unifiedRefreshProfileSchema.safeParse({
        ...profile,
        schedule: [
          {
            name: "invalid inheritance",
            days: [],
            startHour: 0,
            endHour: 0,
            battery: { display: "on" },
          },
        ],
      }).success
    ).toBe(false);
  });
});
