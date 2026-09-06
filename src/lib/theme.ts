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
  /* Black, not a mid-grey: `#444444` snapped to black on this palette anyway, so the
   * value said one thing and the panel showed another.
   *
   * The text colours stay BLACK, and that is deliberate. Every one of them is drawn
   * on the white ground somewhere — `slotSecondary` labels the timeline's hours, and
   * the name plate sets its captions in it — so tuning them for the filled blocks
   * breaks them on the panel's own background. Flipping them for a filled ground is
   * `readableOn`'s job, at the point of use, where the ground is known. Setting
   * `slotSecondary` to white here did in fact erase the hour column, and would have
   * erased the name plate's captions with it. */
  slotText: "#000000",
  slotSecondary: "#000000",
  eventBg: "#000000",
  footerText: "#000000",
};

/** WCAG relative luminance of one 8-bit channel. */
function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const r = channelLuminance(parseInt(hex.slice(1, 3), 16));
  const g = channelLuminance(parseInt(hex.slice(3, 5), 16));
  const b = channelLuminance(parseInt(hex.slice(5, 7), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 for identical colours and 21 for black on white. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The preferred text colour, or black/white when it would be illegible.
 *
 * A theme holds ONE text colour for pairs of grounds that need opposite ones. The
 * booking badge is the clearest case: its background is `busyBadge` or `freeBadge`,
 * and a single `badgeText` has to sit on both. On the two-colour panel those are
 * black and white, so whichever the operator picks, one of the two states renders
 * text on its own colour and disappears. The same holds for `slotText` over an event
 * block that may be `eventBg` or `busyBadge`.
 *
 * Widening the schema would fix it for the built-in themes and leave every
 * operator-made theme able to reproduce it, so the repair belongs at the point of
 * use. Intent is preserved wherever it works: the preferred colour is returned
 * untouched above the threshold, and only replaced when it is genuinely unreadable.
 *
 * 3:1 is the WCAG AA floor for large text, which is what a wall display is. E-paper
 * reaches roughly 10:1 in the first place, so demanding 4.5 would reject pairs that
 * are perfectly legible on the panel.
 */
export function readableOn(background: string, preferred: string, minContrast = 3): string {
  if (contrastRatio(background, preferred) >= minContrast) return preferred;
  return contrastRatio(background, "#000000") >= contrastRatio(background, "#FFFFFF")
    ? "#000000"
    : "#FFFFFF";
}

export function resolveTheme(colorCount: number): Theme {
  return colorCount > 2 ? THEME_DEFAULT : THEME_MONO;
}

/** True when every entry is a grey, i.e. the panel carries value but no hue. */
function isGreyscalePalette(palette: [number, number, number][]): boolean {
  return palette.length > 0 && palette.every(([r, g, b]) => r === g && g === b);
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase();
}

/**
 * Snap all theme colors to the nearest available palette color.
 * Ensures the renderer only uses colors the display can actually show.
 * No dithering needed — every pixel is an exact palette match.
 *
 * "Nearest" is measured differently on a GREYSCALE palette, and it has to be.
 * Euclidean distance to a grey ramp depends only on the sum of the channels, and
 * pure red, green and blue all have the same sum, so all three snapped to the same
 * grey: of the E1003's sixteen levels the four accent colours reached exactly two,
 * and a free badge became indistinguishable from a busy one. Matching by
 * PERCEIVED LIGHTNESS instead spreads them out, because that is the only thing a
 * greyscale panel can carry of a colour. Red lands near 47 % lightness, green near
 * 87 % and blue near 29 %.
 *
 * Palettes with hue keep the Euclidean match, where it is right.
 */
export function snapThemeToPalette(theme: Theme, palette: [number, number, number][]): Theme {
  const byLightness = isGreyscalePalette(palette);

  function nearest(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);

    if (byLightness) {
      const target = luminance(hex);
      let best = palette[0];
      /* Nothing to snap to on an empty palette, so the colour stays as it is. */
      if (!best) return hex;
      let bestDelta = Infinity;
      for (const entry of palette) {
        const delta = Math.abs(luminance(toHex(entry)) - target);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = entry;
        }
      }
      return toHex(best);
    }

    let bestDist = Infinity;
    let bestColor = hex;
    for (const entry of palette) {
      const [pr, pg, pb] = entry;
      const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        bestColor = toHex(entry);
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
