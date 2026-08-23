// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Theme system — Single Source of Truth for display branding.
 */

import { z } from "zod";

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/);

export const themeSchema = z.object({
  name: z.string(),
  headerBg: hexColor,
  headerText: hexColor,
  freeBadge: hexColor,
  busyBadge: hexColor,
  badgeText: hexColor,
  background: hexColor,
  eventBg: hexColor,
  slotText: hexColor,
  slotSecondary: hexColor,
  footerText: hexColor,
});

export type Theme = z.infer<typeof themeSchema>;

/** Safely parse a JSONB value into a Theme, returning null on failure. */
export function parseTheme(raw: unknown): Theme | null {
  const result = themeSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export const THEME_DEFAULT: Theme = {
  name: "Default",
  headerBg: "#000000",
  headerText: "#FFFFFF",
  freeBadge: "#00FF00",
  busyBadge: "#FF0000",
  badgeText: "#FFFFFF",
  background: "#FFFFFF",
  eventBg: "#0000FF",
  slotText: "#FFFFFF",
  slotSecondary: "#000000",
  footerText: "#000000",
};

/**
 * The built-in theme for a TWO-COLOUR panel, and the mid-tones are gone from it.
 *
 * `slotSecondary` and `footerText` were `#888888`, which reads as "secondary" on
 * a screen and is unrepresentable on a 1-bit panel. `snapThemeToPalette` then
 * resolved that grey to WHITE, because in RGB distance white is nearer to
 * mid-grey than black is, so both landed on the background colour. The name plate
 * draws the occupant in `footerText`, which made the whole plate blank below the
 * header on an E1001: rendered and counted, zero ink pixels there against 28 884
 * on the E1002. `room-booking` uses the same two tokens and lost text the same
 * way.
 *
 * On a panel with two colours a secondary rank cannot be a lighter tone. It is a
 * smaller size and a lighter WEIGHT, which is what the renderers now do.
 *
 * Two more mid-tones in here are the same class of defect and are NOT fixed,
 * because each needs a design decision rather than a colour: `eventBg` at
 * `#444444` snaps to black while `slotText` is black, and `badgeText` is white on
 * a `freeBadge` that is also white. Both are room-booking's, both are on
 * ROADMAP.md, and both turn on how a 1-bit panel should distinguish a filled
 * block from an outlined one.
 */
export const THEME_MONO: Theme = {
  name: "Mono",
  headerBg: "#000000",
  headerText: "#FFFFFF",
  freeBadge: "#FFFFFF",
  busyBadge: "#000000",
  badgeText: "#FFFFFF",
  background: "#FFFFFF",
  eventBg: "#444444",
  slotText: "#000000",
  slotSecondary: "#000000",
  footerText: "#000000",
};

export function resolveTheme(colorCount: number): Theme {
  return colorCount > 2 ? THEME_DEFAULT : THEME_MONO;
}

/**
 * Snap all theme colors to the nearest available palette color.
 * Ensures the renderer only uses colors the display can actually show.
 * No dithering needed — every pixel is an exact palette match.
 */
export function snapThemeToPalette(theme: Theme, palette: [number, number, number][]): Theme {
  function nearest(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    let bestDist = Infinity;
    let bestColor = hex;
    for (const [pr, pg, pb] of palette) {
      const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        bestColor =
          `#${pr.toString(16).padStart(2, "0")}${pg.toString(16).padStart(2, "0")}${pb.toString(16).padStart(2, "0")}`.toUpperCase();
      }
    }
    return bestColor;
  }

  return {
    ...theme,
    headerBg: nearest(theme.headerBg),
    headerText: nearest(theme.headerText),
    freeBadge: nearest(theme.freeBadge),
    busyBadge: nearest(theme.busyBadge),
    badgeText: nearest(theme.badgeText),
    background: nearest(theme.background),
    eventBg: nearest(theme.eventBg),
    slotText: nearest(theme.slotText),
    slotSecondary: nearest(theme.slotSecondary),
    footerText: nearest(theme.footerText),
  };
}
