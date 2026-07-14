// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, it, expect } from "vitest";
import { computeTimelineLayout } from "../room-booking";
import type { DisplayEvent } from "@/lib/types";

// A fixed 8-hour window (08:00–16:00) matching the timeline renderer's geometry,
// with a simple 0..800px vertical area so column math is easy to reason about.
const DAY = "2026-07-14";
const at = (hhmm: string): Date => new Date(`${DAY}T${hhmm}:00`);
const WINDOW_START = at("08:00").getTime();
const WINDOW_END = at("16:00").getTime();
const AREA_TOP = 0;
const AREA_H = 800;

function evt(subject: string, start: string, end: string): DisplayEvent {
  return {
    displaySubject: subject,
    organizer: subject,
    startTime: at(start),
    endTime: at(end),
    isPrivate: false,
    showLockIcon: false,
  };
}

const layout = (events: DisplayEvent[]) =>
  computeTimelineLayout(events, WINDOW_START, WINDOW_END, AREA_TOP, AREA_H);

/** Pull the computed block for a given subject out of the (start-sorted) layout. */
const block = (events: DisplayEvent[], subject: string) => {
  const found = layout(events).find((b) => b.evt.displaySubject === subject);
  if (!found) throw new Error(`no layout block for ${subject}`);
  return found;
};

describe("computeTimelineLayout — column packing", () => {
  it("gives two non-overlapping events full width regardless of input order (the JF S2 / Green Office regression)", () => {
    // Reproduces the on-device bug: the provider returned the later event FIRST.
    const events = [
      evt("Green Office", "15:00", "16:00"), // later, listed first
      evt("JF S2", "09:30", "11:00"), // earlier, listed second
    ];
    for (const b of layout(events)) {
      expect(b.col, `${b.evt.displaySubject} column`).toBe(0);
      expect(b.totalCols, `${b.evt.displaySubject} totalCols`).toBe(1);
    }
  });

  it("is order-independent: forward vs reverse input yields the same columns", () => {
    const forward = [evt("A", "09:30", "11:00"), evt("B", "15:00", "16:00")];
    const reverse = [evt("B", "15:00", "16:00"), evt("A", "09:30", "11:00")];
    expect(block(forward, "A").col).toBe(block(reverse, "A").col);
    expect(block(forward, "A").totalCols).toBe(block(reverse, "A").totalCols);
    expect(block(forward, "B").col).toBe(block(reverse, "B").col);
    expect(block(forward, "B").totalCols).toBe(block(reverse, "B").totalCols);
  });

  it("places genuinely overlapping events into side-by-side half-width columns", () => {
    const events = [
      evt("Standup", "09:00", "10:00"),
      evt("Interview", "09:30", "10:30"), // overlaps Standup
    ];
    const cols = layout(events).map((b) => ({ s: b.evt.displaySubject, col: b.col, total: b.totalCols }));
    expect(cols).toEqual([
      { s: "Standup", col: 0, total: 2 },
      { s: "Interview", col: 1, total: 2 },
    ]);
  });

  it("treats touching edges (end == next start) as non-overlapping, reusing column 0", () => {
    const events = [
      evt("First", "09:00", "10:00"),
      evt("Second", "10:00", "11:00"), // starts exactly when First ends
    ];
    for (const b of layout(events)) {
      expect(b.col).toBe(0);
      expect(b.totalCols).toBe(1);
    }
  });

  it("packs a released middle column: A|B overlap, then C reuses A's freed column", () => {
    // A 09:00–10:00 (col0), B 09:30–11:00 (col1), C 10:15–11:30 overlaps only B →
    // C should reuse col0 (A has ended), not open a third column.
    const events = [
      evt("A", "09:00", "10:00"),
      evt("B", "09:30", "11:00"),
      evt("C", "10:15", "11:30"),
    ];
    expect(block(events, "A").col).toBe(0);
    expect(block(events, "B").col).toBe(1);
    expect(block(events, "C").col).toBe(0);
    // B overlaps both A and C, so its group is 2 wide.
    expect(block(events, "B").totalCols).toBe(2);
  });

  it("returns an empty layout for no events", () => {
    expect(layout([])).toEqual([]);
  });
});
