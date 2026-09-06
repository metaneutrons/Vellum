// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

import { describe, it, expect } from "vitest";
import { blockCapacity, planBlockText, subjectNamesOccupant } from "../room-booking-blocks";

describe("subjectNamesOccupant", () => {
  it("recognises the provider pattern that makes the second line redundant", () => {
    expect(subjectNamesOccupant("Lukas Thiele (Hochschule Hannover)", "Lukas Thiele")).toBe(true);
  });

  it("still recognises plain equality", () => {
    expect(subjectNamesOccupant("Maria Warnking", "Maria Warnking")).toBe(true);
  });

  it("ignores case and repeated whitespace", () => {
    expect(subjectNamesOccupant("  maria   warnking – Jour fixe", "Maria Warnking")).toBe(true);
  });

  /* A substring search would call this redundant and then drop the only line
   * that names the person. The rule is a prefix test for exactly that reason. */
  it("does not treat a name buried in the subject as redundant", () => {
    expect(subjectNamesOccupant("Besprechung mit Maria Warnking", "Maria Warnking")).toBe(false);
  });

  it("is false when there is no occupant", () => {
    expect(subjectNamesOccupant("Projektbesprechung", "   ")).toBe(false);
  });
});

describe("planBlockText", () => {
  it("stacks subject then occupant when two lines fit", () => {
    expect(planBlockText("Projektbesprechung", "Maria Warnking", 2)).toEqual({
      primary: "Projektbesprechung",
      secondary: "Maria Warnking",
    });
  });

  it("gives the single line to the occupant", () => {
    expect(planBlockText("Projektbesprechung", "Maria Warnking", 1)).toEqual({
      primary: "Maria Warnking",
      secondary: "",
    });
  });

  it("keeps the subject when it already names the occupant", () => {
    expect(planBlockText("Maria Warnking (Hochschule Hannover)", "Maria Warnking", 1)).toEqual({
      primary: "Maria Warnking (Hochschule Hannover)",
      secondary: "",
    });
  });

  it("leaves the second line empty rather than repeating the name", () => {
    expect(planBlockText("Maria Warnking (HsH)", "Maria Warnking", 4).secondary).toBe("");
  });

  /* Microsoft 365 reports an empty organizer when the room mailbox is itself the
   * organizer and nobody else is invited. The subject is then all there is. */
  it("falls back to the subject when no occupant is known", () => {
    expect(planBlockText("Projektbesprechung", "", 1).primary).toBe("Projektbesprechung");
    expect(planBlockText("Projektbesprechung", "", 3)).toEqual({
      primary: "Projektbesprechung",
      secondary: "",
    });
  });

  it("says nothing when there is no room for a line", () => {
    expect(planBlockText("Projektbesprechung", "Maria Warnking", 0)).toEqual({
      primary: "",
      secondary: "",
    });
  });

  it("trims the strings it is given", () => {
    expect(planBlockText("  Jour fixe ", " Maria Warnking  ", 2)).toEqual({
      primary: "Jour fixe",
      secondary: "Maria Warnking",
    });
  });

  /* The invariant this file exists for. The eight-hour window clips a running
   * booking, so the same event is drawn with fewer and fewer lines as the day
   * goes on. Losing the meeting's title to that is acceptable; losing the name
   * of the person in the room is the defect that was measured on an E1003. */
  it("names the occupant at every capacity, however hard the window clips", () => {
    for (const [subject, occupant] of [
      ["Projektbesprechung", "Maria Warnking"],
      ["Maria Warnking (Hochschule Hannover)", "Maria Warnking"],
      ["Jour fixe", "Prof. Dr. Fabian Schmieder"],
    ] as const) {
      for (let capacity = 1; capacity <= 6; capacity++) {
        const plan = planBlockText(subject, occupant, capacity);
        const shown = `${plan.primary} ${plan.secondary}`;
        expect(shown, `capacity ${capacity} of "${subject}"`).toContain(occupant);
      }
    }
  });
});

describe("blockCapacity", () => {
  /* These four reproduce the previous gate `blockH > lineH * n`, so blocks that
   * already showed two lines keep showing two in the same place. */
  it("counts only lines that fit strictly inside the block", () => {
    expect(blockCapacity(48, 24)).toBe(1);
    expect(blockCapacity(49, 24)).toBe(2);
    expect(blockCapacity(72, 24)).toBe(2);
    expect(blockCapacity(132, 24)).toBe(5);
  });

  /* The measured case at 24 px lines, which is the 800x480 panels: a 10:00-13:00
   * booking has 132 px of visible block at 10:30 and 44 px at 12:30, once the
   * window start has moved to 12:00. The E1003 hits the same cliff at 70 px lines,
   * 387 px against 129. */
  it("drops to one line for the clipped hour of a running booking", () => {
    expect(blockCapacity(44, 24)).toBe(1);
  });

  it("never returns zero for a block that is drawn at all", () => {
    expect(blockCapacity(5, 24)).toBe(1);
    expect(blockCapacity(1, 70)).toBe(1);
  });

  it("returns zero rather than dividing by a zero line height", () => {
    expect(blockCapacity(100, 0)).toBe(0);
  });
});
