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
export function seatBands(
  count: number,
  width: number,
  height: number,
  pad: number,
  headerH = 0
): Rect[] {
  const bands: Rect[] = [];
  if (count <= 0) return bands;

  const innerW = Math.max(0, width - pad * 2);
  const innerH = Math.max(0, height - headerH - pad * 2);
  /* Gaps BETWEEN bands only. Edge spacing is the padding's job, and counting it
   * twice is how a four-seat plate ends up with less room than a three-seat one
   * for no visible reason. */
  const gap = count > 1 ? Math.round(pad / 2) : 0;
  const bandH = (innerH - gap * (count - 1)) / count;

  for (let i = 0; i < count; i++) {
    bands.push({
      x: pad,
      y: Math.round(headerH + pad + i * (bandH + gap)),
      w: innerW,
      h: Math.round(bandH),
    });
  }
  return bands;
}

/** What a single band actually has to show. */
export interface BandContent {
  /** The seat itself: "Schreibtisch 1", or the resource's own name. */
  caption: string | null;
  /** Who is there — or the word for nobody. Always present, always the payload. */
  name: string;
  /** Extra detail, such as how long the booking runs. */
  status: string | null;
  /**
   * The name line is a NOTICE, not a name.
   *
   * "Keine Verbindung" is not a person and must not be typeset like one: at name
   * size it is the loudest thing on the wall, and because the type size is shared
   * across bands, its length would shrink every real name beside it. Drawn small
   * and muted, and excluded from the fit.
   */
  nameIsNotice?: boolean;
}

/** What a resolved seat can say. */
export interface SeatState {
  /** Who is there, or null when nobody is. */
  occupant: string | null;
  /** The seat's own name from the provider, for the caption fallback. */
  placeLabel?: string;
  /** "bis 12:00" and the like. Only shown when the plate shows status. */
  detail?: string | null;
  /** The provider could not be asked. */
  unreachable?: boolean;
}

/**
 * Decide what a band shows, so the drawing code never asks "is this empty?".
 *
 * The roles are fixed and that is the whole point: the ROOM is in the header, the
 * SEAT is the caption, and the big line is the person. Before this the resource
 * name went into the big line whenever a seat was free, so an empty desk rendered
 * as "Föhr 1 (1J.2.27)" in the slot meant for a person and read like one.
 *
 * With nobody there the big line says so. A calendar seat therefore always
 * reveals free or occupied, and `showStatus` governs the DETAIL — the "until" —
 * rather than whether the state is admitted. A plate that cannot say "free" is
 * not a door sign, and it is indistinguishable from a lookup that failed.
 *
 * A static seat has no state to show at all, so it composes two lines instead of
 * three rather than leaving a gap where the third would go.
 */
export function bandContent(
  seat: Seat,
  state: SeatState,
  showStatus: boolean,
  labels: { free: string; unknown: string }
): BandContent {
  const caption = seat.caption.trim() || state.placeLabel?.trim() || "";
  /* An unreachable provider is named whatever the operator asked for: a sign may
   * withhold detail, but it may not present an unknown state as a current one. */
  const name = state.unreachable ? labels.unknown : (state.occupant ?? labels.free);
  return {
    caption: caption || null,
    name,
    status: showStatus && !state.unreachable ? (state.detail ?? null) : null,
    nameIsNotice: state.unreachable ? true : undefined,
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
