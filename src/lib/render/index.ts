// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Rendering pipeline — quantization and pixel buffer conversion.
 */

export { floydSteinbergDither, type ColorPalette } from "./dither";

import type { Canvas } from "@napi-rs/canvas";
import { floydSteinbergDither, nearestPaletteIndex, type ColorPalette } from "./dither";
import type { OutputFormat, ColorMode } from "@/lib/display";

/** @deprecated — use OutputFormat + ColorMode */
export type QuantizeMode = "color" | "grayscale" | "mono" | "none" | "jpeg";

export const DEFAULT_PALETTE: ColorPalette = [
  [0, 0, 0],
  [255, 255, 255],
];

function nearestColorQuantize(
  imageData: Uint8ClampedArray,
  width: number,
  height: number,
  palette: ColorPalette
): Buffer {
  const output = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    output[i] = nearestPaletteIndex(
      imageData[i * 4], imageData[i * 4 + 1], imageData[i * 4 + 2], palette
    );
  }
  return output;
}

/**
 * Convert canvas to pixel buffer based on format + colorMode.
 *
 * format=jpeg: JPEG-compressed output (for LCD displays)
 * format=raw + colorMode:
 *   - fullcolor: PNG (for preview/testing)
 *   - indexed: Snap AA artifacts to palette, then nearest-color 4bpp
 *   - grayscale: Nearest-color 4bpp (AA grays map to gray palette)
 *   - mono: Floyd-Steinberg dithering, 1bpp packed
 */
export function canvasToPixelBuffer(
  canvas: Canvas,
  palette: ColorPalette = DEFAULT_PALETTE,
  format: OutputFormat | QuantizeMode = "raw",
  colorMode: ColorMode = "mono"
): Buffer {
  // Legacy QuantizeMode support
  if (format === "none") return canvas.toBuffer("image/png");
  if (format === "jpeg") return canvas.toBuffer("image/jpeg", 95);
  if (format === "color") { format = "raw"; colorMode = "indexed"; }
  if (format === "grayscale") { format = "raw"; colorMode = "grayscale"; }
  if (format === "mono") { format = "raw"; colorMode = "mono"; }

  // New format + colorMode (format is now guaranteed "raw" after legacy handling)
  if (colorMode === "fullcolor") {
    return canvas.toBuffer("image/png");
  }

  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const data = new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data);

  if (colorMode === "indexed") {
    // Snap anti-aliasing artifacts to palette colors
    const AA_THRESHOLD = 3000;
    for (let i = 0; i < width * height; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      let bestDist = Infinity;
      let bestR = 0, bestG = 0, bestB = 0;
      for (const [pr, pg, pb] of palette) {
        const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
        if (dist < bestDist) { bestDist = dist; bestR = pr; bestG = pg; bestB = pb; }
      }
      if (bestDist < AA_THRESHOLD) {
        data[i * 4] = bestR; data[i * 4 + 1] = bestG; data[i * 4 + 2] = bestB;
      } else {
        const v = (0.299 * r + 0.587 * g + 0.114 * b) > 128 ? 255 : 0;
        data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v;
      }
    }
    return packTo4bit(nearestColorQuantize(data, width, height, palette), width, height);
  }

  if (colorMode === "grayscale") {
    return packTo4bit(nearestColorQuantize(data, width, height, palette), width, height);
  }

  // mono — Floyd-Steinberg dither then pack to 1-bit
  return packTo1bit(floydSteinbergDither(data, width, height, palette), width, height);
}

/**
 * Pack 1-byte-per-pixel palette indices into 1-bit packed format.
 * 8 pixels per byte, MSB first. Index 0 = black (bit 0), index 1 = white (bit 1).
 * Native format for B/W e-paper displays (E1001).
 */
function packTo1bit(input: Buffer, width: number, height: number): Buffer {
  const output = Buffer.alloc(Math.ceil((width * height) / 8));
  for (let i = 0; i < width * height; i++) {
    // Palette index 0 = black = bit 0, index 1 = white = bit 1
    if (input[i] > 0) {
      output[Math.floor(i / 8)] |= (0x80 >> (i % 8));
    }
  }
  return output;
}

/**
 * Pack 1-byte-per-pixel palette indices into 4-bit packed format.
 * Two pixels per byte: high nibble = first pixel, low nibble = second pixel.
 * This is the native format for 6-color (Spectra 6) e-paper displays.
 */
function packTo4bit(input: Buffer, width: number, height: number): Buffer {
  const output = Buffer.alloc((width * height) / 2);
  for (let i = 0; i < width * height; i += 2) {
    output[i / 2] = ((input[i] & 0x0F) << 4) | (input[i + 1] & 0x0F);
  }
  return output;
}
