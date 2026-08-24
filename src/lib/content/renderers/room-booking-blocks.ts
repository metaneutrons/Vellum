// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * What a timeline block says when it cannot say everything.
 *
 * Pure and separate from the canvas because the rule it encodes carries an
 * invariant worth asserting directly: a block the eight-hour window has clipped
 * must not identify the occupant less well than the same booking unclipped.
 *
 * The old layout broke exactly that. Subject went on line one, occupant on line
 * two, and line two was gated on the CLIPPED height. A running meeting therefore
 * lost the name of the person in the room as it scrolled off the top of the
 * window, while keeping a time range the hour grid behind it already showed.
 * Measured on an E1003: a 10:00-13:00 booking rendered at 10:30 had 132 px of
 * visible block and printed the name, the same booking at 12:30 had 44 px
 * against a 48 px threshold and printed only "Projektbesprechung 10:00 - 13:00".
 */

/** Whitespace- and case-insensitive form, for comparing names to subjects. */
function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * True when the subject already names the occupant, so a separate occupant line
 * would only repeat it.
 *
 * Exact equality is not enough, because the redundant case is the normal one:
 * anny reports the subject as "Lukas Thiele (Hochschule Hannover)" and the
 * organizer as "Lukas Thiele". A prefix test catches that and leaves the second
 * line free for something else. It deliberately stops short of a substring
 * search, which would swallow "Besprechung mit Thiele" and, for short names,
 * match by accident.
 */
export function subjectNamesOccupant(subject: string, occupant: string): boolean {
  const who = normalize(occupant);
  if (!who) return false;
  return normalize(subject).startsWith(who);
}

/** The left-hand lines of a block, in drawing order. */
export interface BlockText {
  /** Line one, set bold. Empty only when there is nothing to say at all. */
  primary: string;
  /** Line two, or "" when one line is all there is or all that is needed. */
  secondary: string;
}

/**
 * Fill `capacity` lines, most useful thing first.
 *
 * Two lines or more read as before, subject then occupant. One line goes to the
 * occupant, because a sign beside a door answers "who is in there" and the
 * meeting's title is the part a passer-by can do without. Where the subject
 * already carries the name, it wins the line instead, since it says the same and
 * more.
 *
 * The time range is not part of this decision. It sits at the right end of line
 * one and costs no line of its own.
 */
export function planBlockText(subject: string, occupant: string, capacity: number): BlockText {
  const what = subject.trim();
  const who = occupant.trim();
  if (capacity < 1) return { primary: "", secondary: "" };
  const standalone = who !== "" && !subjectNamesOccupant(what, who);
  if (capacity === 1) return { primary: standalone ? who : what, secondary: "" };
  return { primary: what, secondary: standalone ? who : "" };
}

/**
 * Lines of `lineH` that fit in a block of `blockH`.
 *
 * The count is the number of whole lines that fit strictly inside the block, so
 * a line's baseline never lands on its bottom edge. That reproduces the previous
 * gate (`blockH > lineH * n`) exactly, which keeps every block that already
 * showed two lines looking the way it did.
 *
 * This is necessarily the height the window left visible, not the booking's
 * duration, because a block clipped to one line cannot draw two. What must not
 * depend on the clipping is WHICH line survives, and that is planBlockText's job.
 */
export function blockCapacity(blockH: number, lineH: number): number {
  if (lineH <= 0) return 0;
  return Math.max(1, Math.ceil(blockH / lineH) - 1);
}
