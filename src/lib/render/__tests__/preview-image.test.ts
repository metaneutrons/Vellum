// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The claim the preview route rests on: what an operator sees is what the panel
 * prints.
 *
 * Before this, the preview returned the unquantised canvas, so it answered a
 * different question than the device did. That is not a cosmetic difference. A
 * mono theme that drew white on white went unnoticed for months because every
 * preview showed it as grey on white: grey is what the renderer asked for, white
 * is what the panel made of it.
 *
 * These tests compare the two paths pixel by pixel rather than trusting that they
 * call the same helper, because "they share a function" is exactly the kind of
 * thing that stays true until someone optimises one of them.
 */

import { describe, it, expect } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { canvasToPixelBuffer, previewImage, quantizeToIndices } from "..";
import { DISPLAY_REGISTRY } from "@/lib/display";

/** A gradient, so every palette entry gets a chance to be chosen. */
function gradient(width: number, height: number) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  for (let x = 0; x < width; x++) {
    const v = Math.round((x / (width - 1)) * 255);
    ctx.fillStyle = `rgb(${v}, ${Math.round(v * 0.6)}, ${255 - v})`;
    ctx.fillRect(x, 0, 1, height);
  }
  return canvas;
}

/** The colours a preview PNG actually contains, decoded back out of it. */
async function pixelsOf(png: Buffer, width: number, height: number): Promise<Uint8ClampedArray> {
  const image = await loadImage(png);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, width, height).data;
}

describe("previewImage", () => {
  const W = 64;
  const H = 8;

  it("paints exactly the palette entries the device buffer packs, on the mono panel", () => {
    const reg = DISPLAY_REGISTRY.e1001;
    const canvas = gradient(W, H);
    const indices = quantizeToIndices(
      canvas,
      reg.palette,
      "mono",
      reg.reservedPaletteIndices ?? []
    );
    const packed = canvasToPixelBuffer(
      canvas,
      reg.palette,
      "raw",
      "mono",
      reg.reservedPaletteIndices ?? []
    );

    /* 1 bpp, MSB first: bit set means index 1. Unpacking the device's own bytes
     * has to reproduce the indices the preview paints from. */
    for (let i = 0; i < W * H; i++) {
      const bit = (packed[Math.floor(i / 8)] >> (7 - (i % 8))) & 1;
      expect(bit, `pixel ${i}`).toBe(indices[i] > 0 ? 1 : 0);
    }
  });

  it("paints exactly the palette entries the device buffer packs, on the six-colour panel", () => {
    const reg = DISPLAY_REGISTRY.e1002;
    const canvas = gradient(W, H);
    const reserved = reg.reservedPaletteIndices ?? [];
    const indices = quantizeToIndices(canvas, reg.palette, "indexed", reserved);
    const packed = canvasToPixelBuffer(canvas, reg.palette, "raw", "indexed", reserved);

    // 4 bpp, two pixels per byte, high nibble first.
    for (let i = 0; i < W * H; i++) {
      const nibble = i % 2 === 0 ? packed[i / 2] >> 4 : packed[(i - 1) / 2] & 0x0f;
      expect(nibble, `pixel ${i}`).toBe(indices[i] & 0x0f);
    }
  });

  it("never chooses a reserved palette position", () => {
    const reg = DISPLAY_REGISTRY.e1002;
    const reserved = reg.reservedPaletteIndices ?? [];
    if (reserved.length === 0) return;
    const indices = quantizeToIndices(gradient(W, H), reg.palette, "indexed", reserved);
    for (const index of indices) expect(reserved).not.toContain(index);
  });

  it("hands an LCD its own JPEG rather than a re-encoded picture", () => {
    const reg = DISPLAY_REGISTRY.d1001;
    const out = previewImage(gradient(W, H), reg.palette, "jpeg", "fullcolor");
    expect(out.contentType).toBe("image/jpeg");
    // JPEG magic: FF D8 FF
    expect([out.body[0], out.body[1], out.body[2]]).toEqual([0xff, 0xd8, 0xff]);
  });

  it("returns a PNG for every e-paper panel", () => {
    for (const model of ["e1001", "e1002", "e1003"] as const) {
      const reg = DISPLAY_REGISTRY[model];
      const out = previewImage(
        gradient(W, H),
        reg.palette,
        "raw",
        reg.colorMode,
        reg.reservedPaletteIndices ?? []
      );
      expect(out.contentType, model).toBe("image/png");
      // PNG magic: 89 50 4E 47
      expect([...out.body.subarray(0, 4)], model).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
  });

  /* The end-to-end claim: decode the PNG an operator's browser receives and check
   * every pixel against the palette entry the device's own buffer names. Sharing a
   * helper is an implementation detail; this is the property. */
  it("decodes to exactly the colours the panel will print", async () => {
    const reg = DISPLAY_REGISTRY.e1002;
    const reserved = reg.reservedPaletteIndices ?? [];
    const canvas = gradient(W, H);
    const indices = quantizeToIndices(canvas, reg.palette, "indexed", reserved);
    const out = previewImage(canvas, reg.palette, "raw", "indexed", reserved);
    const pixels = await pixelsOf(out.body, W, H);

    for (let i = 0; i < W * H; i++) {
      const [r, g, b] = reg.palette[indices[i]];
      expect([pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]], `pixel ${i}`).toEqual([
        r,
        g,
        b,
      ]);
    }
  });

  /* The defect this exists for, reproduced: mid-grey text on a white ground is
   * legible in the unquantised canvas and vanishes on a two-colour panel. The
   * preview has to show the vanishing. */
  it("shows the panel losing a mid grey that the canvas kept", () => {
    const reg = DISPLAY_REGISTRY.e1001;
    const canvas = createCanvas(16, 4);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, 16, 4);
    ctx.fillStyle = "#B0B0B0";
    ctx.fillRect(0, 0, 8, 4);

    const indices = quantizeToIndices(
      canvas,
      reg.palette,
      "mono",
      reg.reservedPaletteIndices ?? []
    );
    const distinct = new Set(indices.subarray(0, 32));
    /* Floyd-Steinberg may scatter a few dark pixels, but a light grey on a
     * two-colour panel is overwhelmingly white, and that is what the operator
     * needs to see rather than a comfortable grey. */
    const white = [...indices.subarray(0, 32)].filter((i) => i === 1).length;
    expect(white).toBeGreaterThan(24);
    expect(distinct.size).toBeLessThanOrEqual(2);
  });
});
