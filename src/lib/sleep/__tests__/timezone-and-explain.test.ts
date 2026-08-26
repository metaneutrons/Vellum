import { describe, it, expect } from "vitest";
import {
  computeDisplayPower,
  computeSleep,
  parseRefreshProfile,
  parseRefreshProfilePatch,
  upgradeRefreshProfileConfig,
  type SleepContext,
} from "../index";

/* A rule that only applies at night, so the same instant lands inside it in one
 * zone and outside it in another. 22:00 UTC in August is 00:00 the next day in
 * Berlin (CEST, +2) and 15:00 in Los Angeles, which is the whole point. */
const nightProfile = parseRefreshProfile({
  usbIntervalS: 60,
  schedule: [{ name: "night", days: [], startHour: 22, endHour: 6, intervalS: 1800, mode: "poll" }],
});

const at = (iso: string): SleepContext => ({
  powerSource: "usb",
  batteryLevel: 100,
  nextEventStart: null,
  now: new Date(iso),
  profile: nightProfile,
  hasContent: true,
});

describe("schedule rules in the display's timezone", () => {
  it("matches a night rule for a display whose local time is inside it", () => {
    const r = computeSleep({ ...at("2026-08-19T22:00:00Z"), timezone: "Europe/Berlin" });
    expect(r.tier).toBe("schedule");
    expect(r.rule).toBe("night");
    expect(r.durationS).toBe(1800);
  });

  /* The same instant, a display in California: 15:00 local, so the night rule
   * must not apply. Before the timezone was wired in, both displays were judged
   * by the server's clock and one of them was always wrong. */
  it("does not match for a display whose local time is outside it", () => {
    const r = computeSleep({ ...at("2026-08-19T22:00:00Z"), timezone: "America/Los_Angeles" });
    expect(r.tier).toBe("power-default");
    expect(r.durationS).toBe(60);
  });

  it("falls back to the server clock when no timezone is known", () => {
    const r = computeSleep(at("2026-08-19T22:00:00Z"));
    /* Whatever the server's zone is, the result must be one of the two branches
     * and must not throw. Asserting the branch would pin the test to the machine
     * that runs it. */
    expect(["schedule", "power-default"]).toContain(r.tier);
  });

  it("attributes the after-midnight portion to the day on which a phase began", () => {
    const profile = parseRefreshProfile({
      version: 2,
      schedule: [
        {
          name: "Friday night",
          days: [5],
          startHour: 22,
          endHour: 6,
          battery: { intervalS: 7200 },
        },
      ],
    });
    const result = computeSleep({
      ...at("2026-08-29T00:00:00Z"), // Saturday 02:00 in Berlin
      powerSource: "battery",
      profile,
      timezone: "Europe/Berlin",
    });
    expect(result.tier).toBe("schedule");
    expect(result.durationS).toBe(7200);
  });

  it("treats equal start and end hours as a full-day phase", () => {
    const profile = parseRefreshProfile({
      version: 2,
      schedule: [
        {
          name: "Weekend",
          days: [6],
          startHour: 0,
          endHour: 0,
          usb: { intervalS: 3600 },
        },
      ],
    });
    const result = computeSleep({
      ...at("2026-08-29T12:00:00Z"),
      profile,
      timezone: "Europe/Berlin",
    });
    expect(result.tier).toBe("schedule");
    expect(result.durationS).toBe(3600);
  });

  it("sleeps until the rule's end hour in the display's zone", () => {
    const sleepProfile = parseRefreshProfile({
      version: 2,
      schedule: [
        {
          name: "rest",
          days: [],
          startHour: 22,
          endHour: 6,
          usb: { intervalS: 3600, device: "awake" },
          battery: { intervalS: 3600, device: "sleep", display: "off" },
        },
      ],
    });
    const berlin = computeSleep({
      ...at("2026-08-19T22:00:00Z"),
      powerSource: "battery",
      profile: sleepProfile,
      timezone: "Europe/Berlin",
    });
    /* 00:00 Berlin to 06:00 Berlin is six hours. A zone-blind computation would
     * have used the server's own clock, and on a room display that difference is
     * a dark panel through the first meeting. */
    expect(berlin.durationS).toBe(6 * 3600);
    expect(berlin.mode).toBe("sleep");
  });

  it("keeps USB awake while the same phase sleeps on battery", () => {
    const profile = parseRefreshProfile({
      version: 2,
      schedule: [
        {
          name: "night",
          days: [],
          startHour: 22,
          endHour: 6,
          usb: { intervalS: 7200, device: "awake", display: "off" },
          battery: { intervalS: 7200, device: "sleep", display: "off" },
        },
      ],
    });
    const base = { ...at("2026-08-19T22:00:00Z"), profile, timezone: "Europe/Berlin" };
    expect(computeSleep({ ...base, powerSource: "usb" }).mode).toBe("poll");
    expect(computeSleep({ ...base, powerSource: "battery" }).mode).toBe("sleep");
    expect(computeDisplayPower({ ...base, powerSource: "usb" }).state).toBe("off");
    expect(computeDisplayPower({ ...base, powerSource: "battery" }).state).toBe("off");
  });

  it("does not let content cadence or the commissioning cap defeat explicit sleep", () => {
    const profile = parseRefreshProfile({
      version: 2,
      unassignedIntervalS: 300,
      schedule: [
        {
          name: "night",
          days: [],
          startHour: 22,
          endHour: 6,
          battery: { intervalS: 7200, device: "sleep", display: "off" },
        },
      ],
    });
    const result = computeSleep({
      ...at("2026-08-19T22:00:00Z"),
      powerSource: "battery",
      profile,
      timezone: "Europe/Berlin",
      rendererOverrideS: 60,
      hasContent: false,
    });
    expect(result.mode).toBe("sleep");
    expect(result.durationS).toBe(6 * 3600);
    expect(result.capped).toBeUndefined();
  });

  it("does not activate the historical sleep field during migration", () => {
    const legacy = parseRefreshProfile({
      defaultMode: "sleep",
      schedule: [
        { name: "night", days: [], startHour: 22, endHour: 6, intervalS: 7200, mode: "sleep" },
      ],
    });
    const result = computeSleep({
      ...at("2026-08-19T22:00:00Z"),
      profile: legacy,
      timezone: "Europe/Berlin",
    });
    expect(result.mode).toBe("poll");
  });

  it("merges legacy cadence and brightness windows into one phase", () => {
    const upgraded = upgradeRefreshProfileConfig({
      schedule: [{ name: "Night", days: [], startHour: 22, endHour: 6, intervalS: 7200 }],
      brightness: {
        usbPercent: 80,
        batteryPercent: 40,
        schedule: [{ name: "Night", days: [], startHour: 22, endHour: 6, percent: 10 }],
      },
    });
    expect(upgraded.version).toBe(2);
    expect(upgraded.schedule).toHaveLength(1);
    expect(upgraded.schedule[0].usb).toMatchObject({ intervalS: 7200, brightnessPercent: 10 });
    expect(upgraded.schedule[0].battery).toMatchObject({
      intervalS: 7200,
      brightnessPercent: 10,
    });
    expect(upgraded.schedule[0].usb?.device).toBeUndefined();
  });
});

describe("explaining a decision", () => {
  it("names the tier that decided", () => {
    const base = at("2026-08-19T12:00:00Z");
    expect(computeSleep({ ...base, rendererOverrideS: 45 }).tier).toBe("renderer-override");
    expect(computeSleep({ ...base, powerSource: "battery", batteryLevel: 5 }).tier).toBe(
      "low-battery"
    );
    expect(
      computeSleep({
        ...base,
        nextEventStart: new Date("2026-08-19T12:05:00Z"),
      }).tier
    ).toBe("imminent-event");
    expect(computeSleep(base).tier).toBe("power-default");
  });

  it("reports when the unassigned cap shortened the answer", () => {
    const waiting = computeSleep({
      ...at("2026-08-19T12:00:00Z"),
      powerSource: "battery",
      batteryLevel: 90,
      hasContent: false,
    });
    expect(waiting.capped).toBe(true);
    /* The tier survives the cap: knowing the cap applied is only useful together
     * with what it capped. */
    expect(waiting.tier).toBe("power-default");
  });
});

describe("partial profiles for layering", () => {
  it("keeps a silent layer silent", () => {
    const patch = parseRefreshProfilePatch({ usbIntervalS: 30 });
    expect(patch).toEqual({ usbIntervalS: 30 });
    /* The reason this test exists: zod's own .partial() returns ten keys here,
     * because every field has a default and an absent optional key still
     * resolves to it. Those defaults would then outrank the layer below. */
    expect(Object.keys(patch)).toHaveLength(1);
  });

  it("returns nothing usable for a malformed layer rather than inventing defaults", () => {
    expect(parseRefreshProfilePatch({ usbIntervalS: "soon" })).toEqual({});
  });
});
