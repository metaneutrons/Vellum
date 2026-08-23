// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Where the name plate puts things, with no canvas in sight.
 *
 * Kept free of `@napi-rs/canvas` so the two decisions with any arithmetic in
 * them can be tested directly: how the panel is divided, and what type size the
 * names get. Text measurement is injected for the same reason.
 */

import type { Seat } from "./name-plate-types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Divide the drawable area into one band per seat.
 *
 * Bands, always, rather than a grid that turns into 2x2 at four seats. A name is
 * a WIDE piece of text, so the cell shape that helps is full-width and short,
 * not half-width and tall: on an 800x480 panel four bands give each name 800 px
 * to run in, where quadrants would give 400. "Prof. Dr. Fabian Schmieder" fits
 * the first and wraps or shrinks in the second.
 *
 * It also means the only thing that changes between one seat and four is the
 * band height, which is a layout you can predict without running it.
 */
export function seatBands(count: number, width: number, height: number, pad: number): Rect[] {
  const bands: Rect[] = [];
  if (count <= 0) return bands;

  const innerW = Math.max(0, width - pad * 2);
  const innerH = Math.max(0, height - pad * 2);
  /* Gaps BETWEEN bands only. Edge spacing is the padding's job, and counting it
   * twice is how a four-seat plate ends up with less room than a three-seat one
   * for no visible reason. */
  const gap = count > 1 ? Math.round(pad / 2) : 0;
  const bandH = (innerH - gap * (count - 1)) / count;

  for (let i = 0; i < count; i++) {
    bands.push({
      x: pad,
      y: Math.round(pad + i * (bandH + gap)),
      w: innerW,
      h: Math.round(bandH),
    });
  }
  return bands;
}

/** What a single band actually has to show. */
export interface BandContent {
  caption: string | null;
  name: string;
  /** null when this seat cannot have a state, or the plate does not show one. */
  status: string | null;
}

/**
 * Decide what a band shows, so the drawing code never asks "is this empty?".
 *
 * A static seat returns `status: null` even when the plate shows status, because
 * it has no booking to be free or busy. The band then composes two lines instead
 * of three rather than leaving a gap where the third would go.
 */
export function bandContent(
  seat: Seat,
  resolved: { name: string; status: string | null },
  showStatus: boolean
): BandContent {
  const isCalendar = seat.occupant.kind === "calendar";
  return {
    caption: seat.caption.trim() ? seat.caption.trim() : null,
    name: resolved.name,
    status: showStatus && isCalendar ? resolved.status : null,
  };
}

/** How many lines a band will draw. Drives the height split inside it. */
export function bandLineCount(content: BandContent): number {
  return 1 + (content.caption ? 1 : 0) + (content.status ? 1 : 0);
}

export interface FitOptions {
  /** Every string that has to fit at the SAME size. */
  texts: string[];
  maxWidth: number;
  maxHeight: number;
  /** Width of `text` if drawn at `size`. Injected so this stays testable. */
  measure: (text: string, size: number) => number;
  min: number;
  max: number;
}

/**
 * Largest type size at which EVERY name still fits its band.
 *
 * Shared across bands on purpose. Sizing each name to its own band maximises
 * each one alone and looks ragged together: a short static name would tower over
 * a long calendar name directly beneath it. One size for all names keeps the
 * plate calm, and the cost is only that the shortest name could have been
 * larger.
 *
 * Binary search rather than stepping down by ones: measurement is the expensive
 * part here, and a plate can legitimately span 12 px to 200 px.
 */
export function fitSharedSize(opts: FitOptions): number {
  const fits = (size: number) =>
    size <= opts.maxHeight && opts.texts.every((t) => opts.measure(t, size) <= opts.maxWidth);

  if (!fits(opts.min)) return opts.min; /* Nothing fits; the caller clips. */

  let lo = opts.min;
  let hi = Math.max(opts.min, Math.floor(opts.max));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
