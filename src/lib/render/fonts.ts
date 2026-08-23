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

let registered = false;

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
  registered = true;
  return RENDER_FONT_FAMILY;
}
