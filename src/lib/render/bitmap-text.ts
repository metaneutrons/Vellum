/**
 * Bitmap text renderer — pixel-perfect text without anti-aliasing.
 *
 * Uses a pre-generated font atlas (Inter rasterized at target sizes).
 * Each glyph is stored as a 1-bit bitmap. Text is drawn pixel-by-pixel
 * using fillRect, producing zero anti-aliasing artifacts.
 */

import type { SKRSContext2D } from "@napi-rs/canvas";
import atlasData from "./font-atlas.json";

interface Glyph {
  w: number;
  h: number;
  advance: number;
  bits: string[]; // base36-encoded bitmask per row
}

interface FontVariant {
  size: number;
  weight: string;
  glyphs: Record<string, Glyph>;
}

const atlas = atlasData as Record<string, FontVariant>;

export type BitmapFontSize = "sm" | "md" | "md-bold" | "lg-bold";

/**
 * Draw text pixel-by-pixel from the bitmap font atlas.
 * No anti-aliasing, no sub-pixel rendering — every pixel is exact.
 */
export function drawBitmapText(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  fontKey: BitmapFontSize,
  color: string,
  maxWidth?: number
): number {
  const variant = atlas[fontKey];
  if (!variant) return 0;

  ctx.fillStyle = color;
  let curX = Math.round(x);
  const baseY = Math.round(y - variant.size); // y is baseline, bitmap starts from top

  for (const ch of text) {
    const glyph = variant.glyphs[ch] ?? variant.glyphs["?"];
    if (!glyph) continue;

    if (maxWidth && curX + glyph.advance - x > maxWidth) break;

    // Draw each row of the glyph bitmap
    for (let row = 0; row < glyph.h; row++) {
      const bits = BigInt(parseInt(glyph.bits[row], 36));
      for (let col = 0; col < glyph.w; col++) {
        if ((bits >> BigInt(col)) & BigInt(1)) {
          ctx.fillRect(curX + col, baseY + row, 1, 1);
        }
      }
    }

    curX += glyph.advance;
  }

  return curX - x; // return total width drawn
}

/** Measure text width without drawing */
export function measureBitmapText(text: string, fontKey: BitmapFontSize): number {
  const variant = atlas[fontKey];
  if (!variant) return 0;
  let w = 0;
  for (const ch of text) {
    const glyph = variant.glyphs[ch] ?? variant.glyphs["?"];
    if (glyph) w += glyph.advance;
  }
  return w;
}
