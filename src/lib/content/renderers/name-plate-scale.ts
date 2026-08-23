// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The name plate's type scale, and the one unit everything else is measured in.
 *
 * Its own module because both the layout arithmetic and the drawing need it, and
 * a ratio that lived in one of them would be imported backwards by the other.
 */

import type { SKRSContext2D } from "@napi-rs/canvas";

/* ── Drawing ──────────────────────────────────────────────────── */

export interface TypeCtx {
  ctx: SKRSContext2D;
  ff: string;
}

/**
 * Vertical room one line occupies, as a fraction of its size.
 *
 * Cap height, because vector text is drawn from its alphabetic baseline: centring
 * on the em would push a block down by the descender, which on a single large
 * name is visible.
 */
export const CAP_RATIO = 0.72;

/**
 * The surname's share of its band in STACKED mode, by how many lines the fullest
 * band stacks.
 *
 * Derived rather than chosen. A stack of n lines occupies
 * `sum(capHeights) + sum(gaps)`, which with the ratios below comes to 1.18 S for
 * two lines, 1.65 S for three, 2.03 S for four and 2.41 S for five, where S is
 * the surname size. Inverting each and keeping about a tenth in hand gives this
 * table. A first cut used round numbers 30 % under the limit, which cost the
 * four-line case 0.8 m of reading distance for nothing.
 */
export const SURNAME_SHARE = [1.0, 0.75, 0.55, 0.44, 0.37];

/** The surname's share of its band in ROW mode, where there is one line. */
export const ROW_SHARE = 0.8;

/** Size of the given-name rank, as a fraction of the surname's. */
export const GIVEN_RATIO = 0.45;

/** Size of every secondary line (caption, titles, affiliation, pill). */
export const SECONDARY_RATIO = 0.34;

/** Space between the surname and the given name beside it, in row mode. */
export const ROW_NAME_GAP = 0.24;

export interface BandSizes {
  surname: number;
  given: number;
  secondary: number;
  /** Notices are subordinate to a name but must still be legible. See `planSizes`. */
  notice: number;
}

export interface BandColors {
  name: string;
  secondary: string;
  pillBg: string;
  pillText: string;
}

export function measureAt(t: TypeCtx, text: string, size: number, bold = true): number {
  t.ctx.font = `${bold ? "bold " : ""}${size}px ${t.ff}`;
  return t.ctx.measureText(text).width;
}
