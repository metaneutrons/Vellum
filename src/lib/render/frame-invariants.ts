// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Properties every frame a display shows must have, whatever renderer made it.
 *
 * These are shipped code rather than test helpers so that the sweep over
 * renderers, panels and clock offsets stays a loop over data, and so that a new
 * renderer can be held to the same five statements without copying assertions.
 *
 * The five, and what each one caught:
 *
 *  1. READS      every string the model puts on the frame is drawn, whole.
 *                A running booking stopped naming its occupant for two hours a
 *                day and nothing failed.
 *  2. STATE      exactly one state label, never both, never neither.
 *                A door sign with no bookings drew the room line and nothing
 *                else, so "free" and "the pipeline is broken" looked identical.
 *  3. CONTRAST   no text below 3:1 against the ground it sits on.
 *                The mono theme drew white on white; every preview showed grey on
 *                white because previews were not quantised.
 *  4. BOUNDS     no ink outside the panel.
 *  5. LEGIBLE    no text condensed past a stated ratio.
 *                Canvas condenses instead of clipping, so an over-long line stays
 *                complete, gets narrower, and disappears from a distance without
 *                any error anywhere.
 *
 * 3:1 is the WCAG floor for large text. It is the right floor rather than 4.5
 * because e-paper reaches about 10:1 at best, and because every string on these
 * panels is large text by any reasonable reading distance.
 */

import { contrastRatio } from "@/lib/theme";
import type { Box, DrawnText, Recording } from "./surface";

export interface Violation {
  invariant: "reads" | "state" | "contrast" | "bounds" | "legible";
  detail: string;
}

export interface FrameExpectation {
  /**
   * Strings the frame must carry, complete and unsqueezed.
   *
   * The room's name, the occupant, and anything else the model knows and a person
   * at the door needs. Compared after collapsing whitespace and case, because a
   * renderer may set a label in capitals.
   */
  mustRead?: string[];
  /** Exactly one of these must appear. The state labels of the locale in use. */
  exactlyOneOf?: string[];
  /** Floor for text against its ground. Default 3, the WCAG large-text floor. */
  minContrast?: number;
  /**
   * How far text may be condensed before it counts as illegible. 0.8 by default:
   * a fifth narrower is a design choice, a third narrower is a layout failure.
   */
  minSqueeze?: number;
  /**
   * Tolerance in pixels for the bounds check.
   *
   * Not zero, because glyph bounding boxes include side bearings and an accent or
   * a descender legitimately touches the edge of a band that was measured on cap
   * height. A whole character outside the panel is a different matter.
   */
  boundsSlackPx?: number;
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Every string drawn on the frame, in paint order, normalised for comparison. */
export function textsOf(recording: Recording): string[] {
  return recording.texts.map((t) => t.text);
}

function centre(box: Box): { x: number; y: number } {
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}

function covers(
  fill: { x: number; y: number; width: number; height: number },
  x: number,
  y: number
) {
  return x >= fill.x && x <= fill.x + fill.width && y >= fill.y && y <= fill.y + fill.height;
}

/**
 * The colours visible under one piece of text, painter's algorithm.
 *
 * Sampled at three points across the ink rather than requiring one fill to
 * contain the whole box, because text legitimately overhangs a block it is
 * labelling, and the interesting question is whether it is readable everywhere it
 * lands, not whether it sits neatly inside one rectangle.
 *
 * A sample with nothing under it at all returns nothing for that point, and the
 * contrast invariant abstains rather than guessing. That happens over a QR code
 * or a background image, whose pixels this module cannot see.
 */
export function groundsUnder(recording: Recording, text: DrawnText): string[] {
  const c = centre(text.box);
  const xs = [
    text.box.left + (text.box.right - text.box.left) * 0.15,
    c.x,
    text.box.left + (text.box.right - text.box.left) * 0.85,
  ];
  const grounds = new Set<string>();
  for (const x of xs) {
    let ground: string | null = null;
    for (const fill of recording.fills) if (covers(fill, x, c.y)) ground = fill.color;
    if (ground) grounds.add(ground);
  }
  return [...grounds];
}

function boundsViolations(recording: Recording, slack: number): Violation[] {
  const out: Violation[] = [];
  for (const t of recording.texts) {
    const over: string[] = [];
    if (t.box.left < -slack) over.push(`left ${Math.round(t.box.left)}`);
    if (t.box.top < -slack) over.push(`top ${Math.round(t.box.top)}`);
    if (t.box.right > recording.width + slack)
      over.push(`right ${Math.round(t.box.right)} of ${recording.width}`);
    if (t.box.bottom > recording.height + slack)
      over.push(`bottom ${Math.round(t.box.bottom)} of ${recording.height}`);
    if (over.length > 0)
      out.push({ invariant: "bounds", detail: `"${t.text}" leaves the panel: ${over.join(", ")}` });
  }
  return out;
}

function contrastViolations(recording: Recording, min: number): Violation[] {
  const out: Violation[] = [];
  for (const t of recording.texts) {
    if (!t.text.trim()) continue;
    for (const ground of groundsUnder(recording, t)) {
      const ratio = contrastRatio(ground, t.color);
      if (ratio < min)
        out.push({
          invariant: "contrast",
          detail: `"${t.text}" is ${t.color} on ${ground}, ${ratio.toFixed(2)}:1 below ${min}:1`,
        });
    }
  }
  return out;
}

function readsViolations(
  recording: Recording,
  required: string[],
  minSqueeze: number
): Violation[] {
  const out: Violation[] = [];
  for (const want of required) {
    const needle = normalize(want);
    if (!needle) continue;
    const hits = recording.texts.filter((t) => normalize(t.text).includes(needle));
    if (hits.length === 0) {
      out.push({ invariant: "reads", detail: `"${want}" is on no line of the frame` });
      continue;
    }
    const widest = Math.max(...hits.map((h) => h.squeeze));
    if (widest < minSqueeze)
      out.push({
        invariant: "legible",
        detail: `"${want}" is only drawn condensed to ${widest.toFixed(2)} of its width`,
      });
  }
  return out;
}

function stateViolations(recording: Recording, labels: string[]): Violation[] {
  const drawn = recording.texts.map((t) => normalize(t.text));
  const present = labels.filter((l) => drawn.some((d) => d.includes(normalize(l))));
  if (present.length === 1) return [];
  return [
    {
      invariant: "state",
      detail:
        present.length === 0
          ? `no state label of [${labels.join(", ")}] appears`
          : `state is ambiguous, [${present.join(", ")}] all appear`,
    },
  ];
}

/**
 * Check one frame against the five. Empty means the frame is sound.
 *
 * Order matters only for reading the output: bounds and contrast are properties
 * of every frame, the other three are claims about this particular model.
 */
export function checkFrame(recording: Recording, expect: FrameExpectation = {}): Violation[] {
  const out = [
    ...boundsViolations(recording, expect.boundsSlackPx ?? 2),
    ...contrastViolations(recording, expect.minContrast ?? 3),
    ...readsViolations(recording, expect.mustRead ?? [], expect.minSqueeze ?? 0.8),
  ];
  if (expect.exactlyOneOf) out.push(...stateViolations(recording, expect.exactlyOneOf));
  return out;
}
