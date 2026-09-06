// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Rendering pipeline — quantization and pixel buffer conversion.
 */

export { floydSteinbergDither, type ColorPalette, type ReservedIndices } from "./dither";

import { createCanvas, type Canvas } from "@napi-rs/canvas";
import {
  floydSteinbergDither,
  nearestPaletteIndex,
  type ColorPalette,
  type ReservedIndices,
} from "./dither";
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
  palette: ColorPalette,
  reserved: ReservedIndices = []
): Buffer {
  const output = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    /* imageData is a typed array: an index read yields a number, never
     * undefined, whatever noUncheckedIndexedAccess says about it, so the
     * fallbacks below never apply. */
    output[i] = nearestPaletteIndex(
      imageData[i * 4] ?? 0,
      imageData[i * 4 + 1] ?? 0,
      imageData[i * 4 + 2] ?? 0,
      palette,
      reserved
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
  // Accepted so callers still passing a QuantizeMode keep working; the branches
  // below translate it into format + colorMode.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  format: OutputFormat | QuantizeMode = "raw",
  colorMode: ColorMode = "mono",
  reserved: ReservedIndices = []
): Buffer {
  // Legacy QuantizeMode support
  if (format === "none") return canvas.toBuffer("image/png");
  if (format === "jpeg") return canvas.toBuffer("image/jpeg", 95);
  if (format === "color") {
    format = "raw";
    colorMode = "indexed";
  }
  if (format === "grayscale") {
    format = "raw";
    colorMode = "grayscale";
  }
  if (format === "mono") {
    format = "raw";
    colorMode = "mono";
  }

  // New format + colorMode (format is now guaranteed "raw" after legacy handling)
  if (colorMode === "fullcolor") {
    return canvas.toBuffer("image/png");
  }

  const indices = quantizeToIndices(canvas, palette, colorMode, reserved);
  return colorMode === "mono"
    ? packTo1bit(indices, canvas.width, canvas.height)
    : packTo4bit(indices, canvas.width, canvas.height);
}

/**
 * One palette index per pixel — the step the panel and its preview must share.
 *
 * Split out so that `canvasToPixelBuffer` and `previewImage` cannot disagree: one
 * packs these indices into the panel's bit format, the other paints them back as
 * colours for a browser. Before this the preview returned the UNQUANTISED canvas,
 * which is how a mono theme that drew white on white went unnoticed for months —
 * every preview showed it as grey on white, because grey is what the renderer
 * asked for and the panel is what turned it into white.
 */
export function quantizeToIndices(
  canvas: Canvas,
  palette: ColorPalette,
  colorMode: Exclude<ColorMode, "fullcolor">,
  reserved: ReservedIndices = []
): Buffer {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const data = new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data);

  if (colorMode === "mono") {
    return floydSteinbergDither(data, width, height, palette, reserved);
  }

  if (colorMode === "indexed") {
    // Snap anti-aliasing artifacts to palette colors. Reserved positions are
    // skipped here too: snapping toward a color the panel cannot print would
    // reintroduce it as the nearest match in the quantise pass below.
    const AA_THRESHOLD = 3000;
    const hasReserved = reserved.length > 0;
    for (let i = 0; i < width * height; i++) {
      const r = data[i * 4] ?? 0,
        g = data[i * 4 + 1] ?? 0,
        b = data[i * 4 + 2] ?? 0;
      let bestDist = Infinity;
      let bestR = 0,
        bestG = 0,
        bestB = 0;
      for (let p = 0; p < palette.length; p++) {
        if (hasReserved && reserved.includes(p)) continue;
        const entry = palette[p];
        if (!entry) continue;
        const [pr, pg, pb] = entry;
        const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          bestR = pr;
          bestG = pg;
          bestB = pb;
        }
      }
      if (bestDist < AA_THRESHOLD) {
        data[i * 4] = bestR;
        data[i * 4 + 1] = bestG;
        data[i * 4 + 2] = bestB;
      } else {
        const v = 0.299 * r + 0.587 * g + 0.114 * b > 128 ? 255 : 0;
        data[i * 4] = v;
        data[i * 4 + 1] = v;
        data[i * 4 + 2] = v;
      }
    }
  }

  return nearestColorQuantize(data, width, height, palette, reserved);
}

/**
 * What the panel will show, as an image a browser can display.
 *
 * The preview route used to return the raw canvas, so it answered a different
 * question than the device: it showed what the RENDERER drew rather than what the
 * PANEL prints. On a six-colour or two-colour display those are not the same
 * picture, and the difference is exactly where the interesting defects live.
 */
export function previewImage(
  canvas: Canvas,
  palette: ColorPalette,
  format: OutputFormat,
  colorMode: ColorMode,
  reserved: ReservedIndices = []
): { body: Buffer; contentType: string } {
  /* An LCD is handed a JPEG and a full-colour panel a PNG, so for those two the
   * device's own bytes ARE the preview. */
  if (format === "jpeg")
    return { body: canvas.toBuffer("image/jpeg", 95), contentType: "image/jpeg" };
  if (colorMode === "fullcolor") {
    return { body: canvas.toBuffer("image/png"), contentType: "image/png" };
  }

  const { width, height } = canvas;
  const indices = quantizeToIndices(canvas, palette, colorMode, reserved);
  const out = createCanvas(width, height);
  const octx = out.getContext("2d");
  const image = octx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const [r, g, b] = palette[indices[i] ?? 0] ?? [0, 0, 0];
    image.data[i * 4] = r;
    image.data[i * 4 + 1] = g;
    image.data[i * 4 + 2] = b;
    image.data[i * 4 + 3] = 255;
  }
  octx.putImageData(image, 0, 0);
  return { body: out.toBuffer("image/png"), contentType: "image/png" };
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
    if ((input[i] ?? 0) > 0) {
      /* Buffer.alloc zero-fills, so an untouched byte really is 0. */
      output[Math.floor(i / 8)] = (output[Math.floor(i / 8)] ?? 0) | (0x80 >> (i % 8));
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
    /* An odd pixel count leaves the second nibble without a source pixel, which
     * is the one place here where the fallback is reached. */
    output[i / 2] = (((input[i] ?? 0) & 0x0f) << 4) | ((input[i + 1] ?? 0) & 0x0f);
  }
  return output;
}
