// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Where the name plate puts things, with no canvas in sight.
 *
 * Kept free of `@napi-rs/canvas` so the two decisions with any arithmetic in
 * them can be tested directly: how the panel is divided, and what type size the
 * names get. Text measurement is injected for the same reason.
 */

import { splitName, type NameRanks } from "./name-split";
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
  /**
   * The occupant, taken apart into the three ranks the sign sets.
   *
   * Null when the band has a notice instead of a person. Never both.
   */
  ranks: NameRanks | null;
  /**
   * A statement about the SIGN rather than its content, such as "Frei" or
   * "Keine Verbindung".
   *
   * Set small, in the light weight, and left out of the size search. Both
   * reasons are the same one: it is not a name. At name size "Keine Verbindung"
   * is the loudest thing on the wall, and because one size is shared across
   * bands its length would shrink every real name beside it.
   */
  notice: string | null;
  /** Position and unit, joined, or null when the operator gave neither. */
  affiliation: string | null;
  /**
   * What the filled state pill says, or null for no pill.
   *
   * Only an OCCUPIED seat gets one. A filled area is the one thing that carries
   * across a corridor, so its presence means occupied and its absence means free.
   * An outlined pill for "free" was the first draft and it earned nothing: at the
   * distance where the outline is legible, so is the word inside it.
   */
  pill: string | null;
}

/** What a resolved seat can say. */
export interface SeatState {
  /** Who is there, or null when nobody is. */
  occupant: string | null;
  /**
   * The occupant's name as the PROVIDER structured it.
   *
   * Believed over `splitName`, because a source that separates given name from
   * surname knows something no heuristic can recover. anny does; Microsoft Graph
   * does not.
   */
  ranks?: NameRanks;
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
 * SEAT is the caption, and the big rank is the person. Before this the resource
 * name went into the big line whenever a seat was free, so an empty desk rendered
 * as "Föhr 1 (1J.2.27)" in the slot meant for a person and read like one.
 *
 * With nobody there the band says so, as a notice rather than as a name. A
 * calendar seat therefore always reveals free or occupied, and `showStatus`
 * governs the DETAIL, the "until", rather than whether the state is admitted. A
 * plate that cannot say "free" is not a door sign, and it is indistinguishable
 * from a lookup that failed.
 */
export function bandContent(
  seat: Seat,
  state: SeatState,
  showStatus: boolean,
  labels: { free: string; busy: string; unknown: string },
  /**
   * Whether an unlabelled seat may borrow the provider's name for the place.
   *
   * False on a single-seat plate, where the header already names the place and
   * repeating it puts "Besprechungsraum" twice on the same sign. The operator's
   * own caption is always honoured either way.
   */
  placeFallback = true
): BandContent {
  const base = {
    caption: captionOf(seat, state, placeFallback) || null,
    affiliation: affiliationOf(seat) || null,
  };

  /* An unreachable provider is named whatever the operator asked for: a sign may
   * withhold detail, but it may not present an unknown state as a current one. */
  if (state.unreachable) {
    return { ...base, ranks: null, notice: labels.unknown, pill: null };
  }
  if (!state.occupant) {
    return { ...base, ranks: null, notice: labels.free, pill: null };
  }

  return {
    ...base,
    ranks: state.ranks ?? splitName(state.occupant),
    notice: null,
    pill: pillFor(seat, state, showStatus, labels),
  };
}

/** The operator's own caption, else the provider's name for the place. */
function captionOf(seat: Seat, state: SeatState, placeFallback: boolean): string {
  const own = seat.caption.trim();
  if (own) return own;
  return placeFallback ? (state.placeLabel?.trim() ?? "") : "";
}

/**
 * What an occupied seat's filled pill says, or null for no pill.
 *
 * A static seat has no state at all, so it gets no pill rather than one that would
 * always read the same. `showStatus` decides only whether the pill carries the
 * detail ("bis 12:00") or just the word.
 */
function pillFor(
  seat: Seat,
  state: SeatState,
  showStatus: boolean,
  labels: { busy: string }
): string | null {
  if (seat.occupant.kind !== "calendar") return null;
  return showStatus ? state.detail || labels.busy : labels.busy;
}

/**
 * Position and unit, joined, for a fixed occupant.
 *
 * Only a fixed occupant has these. A booking carries neither, and that is a
 * property of the sources rather than of this code: see the comment on `unit` in
 * name-plate-types.ts.
 *
 * Position first, unit second, the way a business card sets them. The position is
 * the more specific fact and the unit qualifies it.
 */
function affiliationOf(seat: Seat): string {
  if (seat.occupant.kind !== "static") return "";
  return [seat.occupant.role, seat.occupant.unit]
    .map((v) => v.trim())
    .filter(Boolean)
    .join(" · ");
}

/**
 * How many lines a band stacks. Drives the height split inside it.
 *
 * The pill is not a line: it sits beside the stack rather than in it, so counting
 * it would shrink the name to make room for something that costs no height.
 */
export function bandLineCount(content: BandContent): number {
  const name = content.ranks
    ? (content.ranks.titles ? 1 : 0) + (content.ranks.given ? 1 : 0) + 1
    : 1;
  return (content.caption ? 1 : 0) + name + (content.affiliation ? 1 : 0);
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
