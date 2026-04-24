/**
 * Floyd-Steinberg dithering implementation.
 *
 * Converts 24-bit RGB image data to a limited color palette using
 * error-diffusion dithering. Processes pixels left-to-right,
 * top-to-bottom, distributing quantization error to neighbors.
 */

export type ColorPalette = [number, number, number][];

/**
 * Finds the index of the nearest color in the palette using
 * squared Euclidean distance in RGB space.
 */
export function nearestPaletteIndex(
  r: number,
  g: number,
  b: number,
  palette: ColorPalette
): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const dr = r - palette[i][0];
    const dg = g - palette[i][1];
    const db = b - palette[i][2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Applies Floyd-Steinberg dithering to RGBA image data.
 *
 * @param imageData - Uint8ClampedArray of RGBA pixel data (4 bytes per pixel)
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @param palette - Array of RGB triples representing available colors
 * @returns Buffer of palette indices, one byte per pixel (width × height)
 */
export function floydSteinbergDither(
  imageData: Uint8ClampedArray,
  width: number,
  height: number,
  palette: ColorPalette
): Buffer {
  // Work on a float copy so error diffusion can go negative
  const pixels = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 3] = imageData[i * 4];       // R
    pixels[i * 3 + 1] = imageData[i * 4 + 1]; // G
    pixels[i * 3 + 2] = imageData[i * 4 + 2]; // B
  }

  const output = Buffer.alloc(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const r = pixels[idx * 3];
      const g = pixels[idx * 3 + 1];
      const b = pixels[idx * 3 + 2];

      const palIdx = nearestPaletteIndex(r, g, b, palette);
      output[idx] = palIdx;

      const pr = palette[palIdx][0];
      const pg = palette[palIdx][1];
      const pb = palette[palIdx][2];

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
          pixels[nIdx * 3] += errR * weight;
          pixels[nIdx * 3 + 1] += errG * weight;
          pixels[nIdx * 3 + 2] += errB * weight;
        }
      }
    }
  }

  return output;
}
