// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Floyd-Steinberg dithering implementation.
 *
 * Converts 24-bit RGB image data to a limited color palette using
 * error-diffusion dithering. Processes pixels left-to-right,
 * top-to-bottom, distributing quantization error to neighbors.
 */

export type ColorPalette = [number, number, number][];

/**
 * Palette positions that are valid pixel codes but not printable colors, so they
 * must never be the result of quantisation.
 *
 * A palette position IS the on-wire pixel code, and a six-color panel can have a
 * hole in its code space (E1002: 0x4 is unused, blue is 0x5, green is 0x6). The
 * hole cannot be closed by shortening the palette without moving every later
 * color onto the wrong code, so it is skipped instead.
 */
export type ReservedIndices = readonly number[];

/**
 * Finds the index of the nearest usable color in the palette using
 * squared Euclidean distance in RGB space.
 */
export function nearestPaletteIndex(
  r: number,
  g: number,
  b: number,
  palette: ColorPalette,
  reserved: ReservedIndices = []
): number {
  let bestIdx = -1;
  let bestDist = Infinity;
  // Hoisted because this runs per pixel: e1003 is 2.6M pixels × 16 palette
  // entries, and reserved positions are the exception (only E1002 has one), so the
  // common path must not pay for an array scan.
  const hasReserved = reserved.length > 0;
  for (let i = 0; i < palette.length; i++) {
    if (hasReserved && reserved.includes(i)) continue;
    const entry = palette[i];
    if (!entry) continue;
    const dr = r - entry[0];
    const dg = g - entry[1];
    const db = b - entry[2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  // Every position reserved is a misconfiguration, not a reason to write a byte
  // the panel would interpret as an arbitrary color: fall back to code 0.
  return bestIdx === -1 ? 0 : bestIdx;
}

/**
 * Applies Floyd-Steinberg dithering to RGBA image data.
 *
 * @param imageData - Uint8ClampedArray of RGBA pixel data (4 bytes per pixel)
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @param palette - Array of RGB triples representing available colors
 * @param reserved - Palette positions that are pixel codes but not usable colors
 * @returns Buffer of palette indices, one byte per pixel (width × height)
 */
export function floydSteinbergDither(
  imageData: Uint8ClampedArray,
  width: number,
  height: number,
  palette: ColorPalette,
  reserved: ReservedIndices = []
): Buffer {
  // Work on a float copy so error diffusion can go negative
  /* Float32Array and the source buffer are typed arrays: an index read there
   * yields a number or NaN, never undefined, but TypeScript still widens it under
   * noUncheckedIndexedAccess. The `?? 0` below is unreachable for an in-range
   * index; a real runtime check per channel would run 2.6M × 3 times on an E1003
   * frame. */
  const pixels = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 3] = imageData[i * 4] ?? 0; // R
    pixels[i * 3 + 1] = imageData[i * 4 + 1] ?? 0; // G
    pixels[i * 3 + 2] = imageData[i * 4 + 2] ?? 0; // B
  }

  const output = Buffer.alloc(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const r = pixels[idx * 3] ?? 0;
      const g = pixels[idx * 3 + 1] ?? 0;
      const b = pixels[idx * 3 + 2] ?? 0;

      const palIdx = nearestPaletteIndex(r, g, b, palette, reserved);
      output[idx] = palIdx;

      /* nearestPaletteIndex returns an index from this same palette, falling back
       * to 0 rather than -1, so the entry exists for any non-empty palette. The
       * guard covers the one case the type cannot rule out — an empty palette —
       * where continuing beats diffusing NaN across the frame. */
      const chosen = palette[palIdx];
      if (!chosen) continue;
      const [pr, pg, pb] = chosen;

      const errR = r - pr;
      const errG = g - pg;
      const errB = b - pb;

      // Distribute error: 7/16 right, 3/16 below-left, 5/16 below, 1/16 below-right
      const neighbors: [number, number, number][] = [
        [x + 1, y, 7 / 16],
        [x - 1, y + 1, 3 / 16],
        [x, y + 1, 5 / 16],
        [x + 1, y + 1, 1 / 16],
      ];

      for (const [nx, ny, weight] of neighbors) {
        if (nx >= 0 && nx < width && ny < height) {
          const nIdx = ny * width + nx;
          pixels[nIdx * 3] = (pixels[nIdx * 3] ?? 0) + errR * weight;
          pixels[nIdx * 3 + 1] = (pixels[nIdx * 3 + 1] ?? 0) + errG * weight;
          pixels[nIdx * 3 + 2] = (pixels[nIdx * 3 + 2] ?? 0) + errB * weight;
        }
      }
    }
  }

  return output;
}
