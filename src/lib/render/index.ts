// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Rendering pipeline — quantization and pixel buffer conversion.
 */

export { floydSteinbergDither, type ColorPalette } from "./dither";

import type { Canvas } from "@napi-rs/canvas";
import { floydSteinbergDither, nearestPaletteIndex, type ColorPalette } from "./dither";
import type { QuantizeMode } from "@/lib/display";

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
 * Convert canvas to palette-indexed pixel buffer.
 *
 * "color":     Snap non-palette pixels to B&W by luminance, then nearest-color.
 * "grayscale": Nearest-color directly — AA gray pixels map to gray palette entries.
 * "mono":      Floyd-Steinberg dithering for pure B&W.
 * "none":      No quantization — returns raw PNG bytes for TFT displays.
 */
export function canvasToPixelBuffer(
  canvas: Canvas,
  palette: ColorPalette = DEFAULT_PALETTE,
  quantize: QuantizeMode = "mono"
): Buffer {
  if (quantize === "none") {
    return canvas.toBuffer("image/png");
  }

  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const data = new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data);

  if (quantize === "color") {
    // Pre-pass: fix anti-aliasing artifacts on color e-paper.
    // For each pixel, find the nearest palette color. If the distance
    // is large (AA blend between two colors), snap to B&W by luminance.
    // Small distances (near a palette color) are left alone.
    const AA_THRESHOLD = 3000; // squared distance — ~55 per channel

    for (let i = 0; i < width * height; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];

      // Find nearest palette color and its distance
      let bestDist = Infinity;
      let bestR = 0, bestG = 0, bestB = 0;
      for (const [pr, pg, pb] of palette) {
        const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          bestR = pr; bestG = pg; bestB = pb;
        }
      }

      if (bestDist < AA_THRESHOLD) {
        // Close enough to a palette color — snap to it
        data[i * 4] = bestR; data[i * 4 + 1] = bestG; data[i * 4 + 2] = bestB;
      } else {
        // Far from any palette color — AA artifact, snap to B&W
        const v = (0.299 * r + 0.587 * g + 0.114 * b) > 128 ? 255 : 0;
        data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v;
      }
    }
    return packTo4bit(nearestColorQuantize(data, width, height, palette), width, height);
  }

  if (quantize === "grayscale") {
    return nearestColorQuantize(data, width, height, palette);
  }

  return floydSteinbergDither(data, width, height, palette);
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
