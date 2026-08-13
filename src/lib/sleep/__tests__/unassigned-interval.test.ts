// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The cadence a display uses while it has nothing assigned to render.
 *
 * This is the commissioning state — the one moment an operator is standing in
 * front of the display waiting for it to react — and it used to be the slowest
 * one. `/api/v1/ink/render` answered 204 before computing any cadence, so the
 * device fell back to its 900 s firmware default and its refresh profile never
 * applied at all: a USB-powered display configured for 60 s waited a quarter of
 * an hour.
 *
 * `unassignedIntervalS` is a CEILING rather than an interval of its own, so it
 * inherits the USB / battery tiers instead of duplicating them. It can only make
 * a display more responsive, never less — with one deliberate exception.
 */
import { describe, it, expect } from "vitest";
import { computeSleep, parseRefreshProfile } from "../index";

const profile = parseRefreshProfile({});          // usb 60, battery 900, low 3600 @ 20%
const now = new Date("2026-08-13T12:00:00Z");
const base = { nextEventStart: null, now, profile };

describe("cadence while awaiting content", () => {
  it("caps a slow battery interval", () => {
    const assigned = computeSleep({ ...base, powerSource: "battery", batteryLevel: 80 });
    const waiting = computeSleep({
      ...base, powerSource: "battery", batteryLevel: 80, hasContent: false,
    });
    expect(assigned.durationS).toBe(900);
    expect(waiting.durationS).toBe(300);
  });

  it("never slows a display that is already faster", () => {
    // USB is 60 s, well under the 300 s ceiling — min(), not assignment.
    const waiting = computeSleep({
      ...base, powerSource: "usb", batteryLevel: 100, hasContent: false,
    });
    expect(waiting.durationS).toBe(60);
  });

  it("leaves a display with content on its profile's cadence", () => {
    const assigned = computeSleep({
      ...base, powerSource: "battery", batteryLevel: 80, hasContent: true,
    });
    expect(assigned.durationS).toBe(900);
  });

  it("defaults to assuming content, so an unaware caller cannot speed a display up", () => {
    // hasContent is optional; omitting it must behave like true.
    const omitted = computeSleep({ ...base, powerSource: "battery", batteryLevel: 80 });
    expect(omitted.durationS).toBe(900);
  });

  it("does NOT override the low-battery tier", () => {
    // The one exception: protecting a near-dead cell outranks commissioning
    // convenience, and this tier exists precisely to be slow.
    const critical = computeSleep({
      ...base, powerSource: "battery", batteryLevel: 5, hasContent: false,
    });
    expect(critical.durationS).toBe(3600);
    expect(critical.mode).toBe("sleep");
  });

  it("caps a schedule rule too, and keeps the rule's mode", () => {
    const scheduled = parseRefreshProfile({
      schedule: [{ name: "Night", startHour: 0, endHour: 23, intervalS: 7200, mode: "poll" }],
    });
    const waiting = computeSleep({
      ...base, profile: scheduled, powerSource: "battery", batteryLevel: 80, hasContent: false,
    });
    expect(waiting.durationS).toBe(300);
    expect(waiting.mode).toBe("poll");
  });

  it("honours a per-profile ceiling", () => {
    const brisk = parseRefreshProfile({ unassignedIntervalS: 60 });
    expect(computeSleep({
      ...base, profile: brisk, powerSource: "battery", batteryLevel: 80, hasContent: false,
    }).durationS).toBe(60);
  });

  it("defaults the ceiling to the firmware's approval cadence", () => {
    // 300 s matches VELLUM_APPROVAL_POLL_SEC, already used for the analogous
    // "enrolled but waiting for an operator" state.
    expect(parseRefreshProfile({}).unassignedIntervalS).toBe(300);
  });

  it("rejects a zero or fractional ceiling", () => {
    // Would produce a hot poll loop or a non-integer header value.
    expect(parseRefreshProfile({ unassignedIntervalS: 0 }).unassignedIntervalS).toBe(300);
    expect(parseRefreshProfile({ unassignedIntervalS: 1.5 }).unassignedIntervalS).toBe(300);
  });
});
