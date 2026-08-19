import { describe, it, expect } from "vitest";
import {
  evaluateBrightness,
  parseBrightnessPolicy,
  brightnessPolicySchema,
  DEFAULT_BRIGHTNESS,
} from "../brightness";

const night = brightnessPolicySchema.parse({
  usbPercent: 90,
  batteryPercent: 30,
  schedule: [{ name: "night", days: [], startHour: 22, endHour: 6, percent: 15 }],
});

const at = (iso: string) => new Date(iso);

describe("evaluateBrightness", () => {
  it("uses the power tier when no rule applies", () => {
    const usb = evaluateBrightness({
      policy: night,
      powerSource: "usb",
      now: at("2026-08-19T10:00:00Z"),
      timezone: "Europe/Berlin",
    });
    expect(usb).toEqual({ percent: 90, tier: "power-default" });

    const battery = evaluateBrightness({
      policy: night,
      powerSource: "battery",
      now: at("2026-08-19T10:00:00Z"),
      timezone: "Europe/Berlin",
    });
    expect(battery.percent).toBe(30);
  });

  it("prefers a matching rule over the power tier", () => {
    /* 22:00 UTC is 00:00 in Berlin, inside the 22-to-6 window. */
    const r = evaluateBrightness({
      policy: night,
      powerSource: "usb",
      now: at("2026-08-19T22:00:00Z"),
      timezone: "Europe/Berlin",
    });
    expect(r).toEqual({ percent: 15, tier: "schedule", rule: "night" });
  });

  /* The same instant judged in another zone must not match: this is the property
   * that makes a fleet across sites behave, and it is the one that was silently
   * missing from the cadence path until the timezone was wired in. */
  it("judges a rule in the display's zone, not the server's", () => {
    const la = evaluateBrightness({
      policy: night,
      powerSource: "usb",
      now: at("2026-08-19T22:00:00Z"),
      timezone: "America/Los_Angeles",
    });
    expect(la.tier).toBe("power-default");
    expect(la.percent).toBe(90);
  });

  it("takes the first matching rule, as the cadence section does", () => {
    const policy = brightnessPolicySchema.parse({
      schedule: [
        { name: "first", days: [], startHour: 0, endHour: 23, percent: 55 },
        { name: "second", days: [], startHour: 0, endHour: 23, percent: 5 },
      ],
    });
    const r = evaluateBrightness({
      policy,
      powerSource: "usb",
      now: at("2026-08-19T12:00:00Z"),
    });
    expect(r.rule).toBe("first");
    expect(r.percent).toBe(55);
  });

  /* An operator who sets a lobby to 100 means it at 23:00 too. Anything else makes
   * the override look broken at exactly the hour they were testing. */
  it("lets a per-display override outrank even a matching rule", () => {
    const r = evaluateBrightness({
      policy: night,
      powerSource: "usb",
      now: at("2026-08-19T22:00:00Z"),
      timezone: "Europe/Berlin",
      override: 100,
    });
    expect(r).toEqual({ percent: 100, tier: "device-override" });
  });

  it("accepts zero as an override rather than treating it as unset", () => {
    const r = evaluateBrightness({
      policy: night,
      powerSource: "usb",
      now: at("2026-08-19T10:00:00Z"),
      override: 0,
    });
    expect(r.percent).toBe(0);
    expect(r.tier).toBe("device-override");
  });

  it("clamps an out-of-range override rather than passing it to the panel", () => {
    expect(
      evaluateBrightness({ powerSource: "usb", now: at("2026-08-19T10:00:00Z"), override: 250 })
        .percent
    ).toBe(100);
    expect(
      evaluateBrightness({ powerSource: "usb", now: at("2026-08-19T10:00:00Z"), override: -5 })
        .percent
    ).toBe(0);
  });
});

describe("parseBrightnessPolicy", () => {
  /* Every profile written before this section existed. It must resolve to the
   * built-in policy, whose usbPercent of 80 is what the firmware did
   * unconditionally, so an untouched profile changes nothing. */
  it("falls back to the built-in policy for a profile with no brightness section", () => {
    expect(parseBrightnessPolicy({ usbIntervalS: 60 })).toEqual(DEFAULT_BRIGHTNESS);
    expect(parseBrightnessPolicy(null)).toEqual(DEFAULT_BRIGHTNESS);
    expect(DEFAULT_BRIGHTNESS.usbPercent).toBe(80);
  });

  it("reads a brightness section when the profile carries one", () => {
    const policy = parseBrightnessPolicy({ brightness: { usbPercent: 55 } });
    expect(policy.usbPercent).toBe(55);
    expect(policy.batteryPercent).toBe(DEFAULT_BRIGHTNESS.batteryPercent);
  });

  it("discards a malformed section rather than half-applying it", () => {
    expect(parseBrightnessPolicy({ brightness: { usbPercent: 400 } })).toEqual(DEFAULT_BRIGHTNESS);
  });
});
