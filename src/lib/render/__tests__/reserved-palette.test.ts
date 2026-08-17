// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * E1002 is a six-color Spectra panel (GDEP073E01) whose on-wire pixel codes have a
 * hole: 0x0 black, 0x1 white, 0x2 yellow, 0x3 red, 0x4 UNUSED, 0x5 blue, 0x6 green.
 * The firmware's own LVGL palette has always skipped 0x4, but the capability report
 * it sent the server listed seven colors including orange at index 4, so the
 * renderer could quantise toward a color the panel cannot produce.
 *
 * A palette position IS its pixel code, which is why the obvious fix is wrong:
 * dropping index 4 slides blue onto 0x4 and green onto 0x5, corrupting the two
 * colors that were working. The position is kept and marked reserved instead.
 */
import { describe, it, expect } from "vitest";
import { nearestPaletteIndex, floydSteinbergDither, type ColorPalette } from "../dither";
import { completeDisplayCaps, resolveDisplayCaps, DISPLAY_REGISTRY } from "@/lib/display";

/** The wire order, straight from firmware/components/http_client/http_client.c. */
const E1002_PALETTE: ColorPalette = [
  [0, 0, 0], // 0x0 black
  [255, 255, 255], // 0x1 white
  [255, 255, 0], // 0x2 yellow
  [255, 0, 0], // 0x3 red
  [255, 255, 255], // 0x4 reserved
  [0, 0, 255], // 0x5 blue
  [0, 255, 0], // 0x6 green
];
const E1002_RESERVED = [4];

describe("reserved palette positions", () => {
  it("never selects a reserved position, even for its exact color", () => {
    // The reserved slot holds a duplicate of white, so an unguarded nearest-color
    // search could legitimately land on it.
    expect(nearestPaletteIndex(255, 255, 255, E1002_PALETTE, E1002_RESERVED)).toBe(1);
    // ...and orange, the color that used to live there, must now resolve to a
    // color the panel can actually print.
    const orange = nearestPaletteIndex(255, 128, 0, E1002_PALETTE, E1002_RESERVED);
    expect(E1002_RESERVED).not.toContain(orange);
    expect([2, 3]).toContain(orange); // yellow or red, both printable
  });

  it("keeps blue on 0x5 and green on 0x6", () => {
    // The regression that "just delete the orange entry" would cause.
    expect(nearestPaletteIndex(0, 0, 255, E1002_PALETTE, E1002_RESERVED)).toBe(5);
    expect(nearestPaletteIndex(0, 255, 0, E1002_PALETTE, E1002_RESERVED)).toBe(6);
    expect(nearestPaletteIndex(0, 0, 0, E1002_PALETTE, E1002_RESERVED)).toBe(0);
    expect(nearestPaletteIndex(255, 255, 0, E1002_PALETTE, E1002_RESERVED)).toBe(2);
    expect(nearestPaletteIndex(255, 0, 0, E1002_PALETTE, E1002_RESERVED)).toBe(3);
  });

  it("dithers a full image without ever emitting a reserved code", () => {
    // A gradient sweeping through orange is the worst case: every pixel is a near
    // miss for the reserved slot.
    const w = 32,
      h = 8;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 255; // R
      data[i * 4 + 1] = Math.round((i / (w * h)) * 255); // G sweeps red → yellow
      data[i * 4 + 2] = 0;
      data[i * 4 + 3] = 255;
    }
    const out = floydSteinbergDither(data, w, h, E1002_PALETTE, E1002_RESERVED);
    expect(out.length).toBe(w * h);
    for (const code of out) {
      expect(E1002_RESERVED).not.toContain(code);
      expect(code).toBeLessThan(E1002_PALETTE.length);
    }
  });

  it("still works when nothing is reserved", () => {
    // Old firmware reports no reserved positions; behaviour must be unchanged.
    expect(nearestPaletteIndex(255, 255, 255, E1002_PALETTE)).toBe(1);
    expect(nearestPaletteIndex(0, 0, 255, E1002_PALETTE)).toBe(5);
  });

  it("falls back to code 0 rather than an arbitrary color if everything is reserved", () => {
    const all = E1002_PALETTE.map((_, i) => i);
    expect(nearestPaletteIndex(12, 34, 56, E1002_PALETTE, all)).toBe(0);
  });
});

describe("device-reported capabilities", () => {
  const caps = {
    model: "e1002",
    width: 800,
    height: 480,
    palette: E1002_PALETTE,
    reservedPaletteIndices: E1002_RESERVED,
    format: "raw" as const,
    colorMode: "indexed" as const,
    orientations: [],
  };

  it("counts printable colors, not the size of the code space", () => {
    const resolved = resolveDisplayCaps(caps);
    expect(resolved.palette).toHaveLength(7); // codes 0x0–0x6 stay addressable
    expect(resolved.colorCount).toBe(6); // but only six can be printed
    expect(resolved.reservedPaletteIndices).toEqual([4]);
  });

  it("defaults to nothing reserved for firmware that predates the field", () => {
    const { reservedPaletteIndices, ...legacy } = caps;
    void reservedPaletteIndices;
    const resolved = resolveDisplayCaps(legacy);
    expect(resolved.reservedPaletteIndices).toEqual([]);
    expect(resolved.colorCount).toBe(7);
  });

  it("ignores a reserved index outside the palette", () => {
    // Otherwise a device reporting nonsense could shrink its own color count.
    const resolved = resolveDisplayCaps({ ...caps, reservedPaletteIndices: [4, 99] });
    expect(resolved.reservedPaletteIndices).toEqual([4]);
    expect(resolved.colorCount).toBe(6);
  });
});

describe("static registry", () => {
  it("matches the firmware's wire order for e1002", () => {
    // The registry drives the simulator, preview and flash UI. It used to list the
    // same seven colors in ACeP Gallery order — green and blue at 0x2/0x3 — which
    // is a different panel family, so every preview disagreed with the hardware.
    expect(DISPLAY_REGISTRY.e1002.palette).toEqual(E1002_PALETTE);
    expect(DISPLAY_REGISTRY.e1002.reservedPaletteIndices).toEqual(E1002_RESERVED);
  });

  it.each([
    ["e1002", 800, 480, "raw", "indexed"],
    ["d1001", 800, 1280, "jpeg", "fullcolor"],
  ] as const)("completes model-only %s capabilities", (model, width, height, format, colorMode) => {
    expect(completeDisplayCaps({ model }, model)).toEqual(
      expect.objectContaining({ model, width, height, format, colorMode })
    );
  });

  it("keeps valid device-reported geometry while filling missing fields", () => {
    expect(completeDisplayCaps({ model: "d1001", width: 1280, height: 800 }, "d1001")).toEqual(
      expect.objectContaining({ width: 1280, height: 800, format: "jpeg" })
    );
  });

  it("does not guess capabilities for an unknown model", () => {
    expect(completeDisplayCaps({ model: "future" }, "future")).toBeNull();
  });
});
