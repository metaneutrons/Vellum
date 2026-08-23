// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Font registration for the server-side renderers.
 *
 * One place, because every renderer needs the same three faces from the same
 * directory and each copy of that knowledge is a chance for one of them to drift
 * — a different path, a family name spelled differently, or a missing weight
 * that only shows up as a silently substituted face on one content type.
 */

import path from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";

const FONT_DIR = path.join(process.cwd(), "assets/fonts");

/** Family the renderers ask for. Registered from assets, not from the system. */
export const RENDER_FONT_FAMILY = "Inter";

/**
 * Family for the narrow cut, when one is installed.
 *
 * A neutral name rather than the face's own, deliberately: a door sign wants "the
 * narrow face", not a brand. Swapping the physical face is then two files in
 * `assets/fonts` and no code at all.
 *
 * It exists because a door sign is width-bound. A condensed cut buys roughly a
 * fifth of the width, and therefore a fifth of the reading distance, on every sign
 * where the type runs out of room before it runs out of height. That is most of
 * them on the D1001, whose panel is 800 px wide in portrait.
 */
export const NARROW_FONT_FAMILY = "Vellum Narrow";

/** The narrow faces, in the order they are tried. Regular first: it must exist. */
const NARROW_FILES = ["VellumNarrow-Regular.ttf", "VellumNarrow-Bold.ttf"];

let registered = false;
let narrowAvailable = false;

/**
 * Register the render faces once and return the family to use.
 *
 * Failure is not fatal and deliberately quiet: a missing asset means canvas
 * falls back to a system sans-serif, which still draws readable text. Refusing
 * to render a room display over a font file would be the worse trade.
 */
export function ensureRenderFonts(): string {
  if (registered) return RENDER_FONT_FAMILY;
  try {
    GlobalFonts.registerFromPath(path.join(FONT_DIR, "Inter-Regular.ttf"), RENDER_FONT_FAMILY);
    GlobalFonts.registerFromPath(path.join(FONT_DIR, "Inter-Bold.ttf"), RENDER_FONT_FAMILY);
    GlobalFonts.registerFromPath(path.join(FONT_DIR, "Inter-Medium.ttf"), RENDER_FONT_FAMILY);
  } catch {
    /* Fall back to sans-serif. */
  }

  /* The narrow cut is OPTIONAL, and its absence has to be silent and total: the
   * renderers ask `narrowFontFamily()` and simply never consider it. Registering
   * only one of the two weights would be worse than none, because a bold surname
   * would then fall back to a system face beside a regular one that did not, so
   * both files have to land or neither counts.
   *
   * The RETURN VALUE is what settles it, not an exception. `registerFromPath`
   * answers false for a missing file rather than throwing, so a try/catch alone
   * reported the family as available, canvas quietly substituted a system face for
   * it, and the size search preferred that face because it happened to be 18 %
   * narrower than Inter. A plate would then have been set in whatever the host
   * machine had lying around. */
  narrowAvailable = NARROW_FILES.every((file) =>
    GlobalFonts.registerFromPath(path.join(FONT_DIR, file), NARROW_FONT_FAMILY)
  );

  registered = true;
  return RENDER_FONT_FAMILY;
}

/**
 * The narrow family, or null when it is not installed.
 *
 * Null is a normal answer, not an error: the repository can ship without the face
 * and every sign then renders exactly as it did before the narrow cut existed.
 */
export function narrowFontFamily(): string | null {
  ensureRenderFonts();
  return narrowAvailable ? NARROW_FONT_FAMILY : null;
}
