// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Display capabilities — device-reported, server-stored.
 *
 * Two orthogonal axes:
 *   - format: How pixels are transmitted (raw binary or JPEG)
 *   - colorMode: Color depth of the display hardware
 *
 * The palette array serves different purposes per colorMode:
 *   - fullcolor: Theme color scheme (renderer picks from these for UI elements)
 *   - indexed: Exact colors the display can show (dithering target)
 *   - grayscale: Gray levels available (e.g. 16 entries for 4bpp)
 *   - mono: Always [[0,0,0],[255,255,255]]
 */

import { z } from "zod";
import type { ColorPalette } from "./render/dither";

export type OutputFormat = "raw" | "jpeg";
export type ColorMode = "fullcolor" | "indexed" | "grayscale" | "mono";

/** Schema for device-reported display capabilities */
export const displayCapsSchema = z.object({
  model: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  palette: z.array(z.tuple([z.number(), z.number(), z.number()])).min(0),
  /** Output format: raw binary pixels or JPEG-compressed */
  format: z.enum(["raw", "jpeg"]).default("raw"),
  /** Color mode of the display hardware */
  colorMode: z.enum(["fullcolor", "indexed", "grayscale", "mono"]).default("mono"),
  /** @deprecated Use format + colorMode instead. Kept for migration. */
  quantize: z.enum(["color", "grayscale", "mono", "none", "jpeg"]).optional(),
  /** Orientations the device supports. Empty = fixed (no rotation). */
  orientations: z.array(z.enum(["portrait", "landscape"])).default([]),
  /** Current orientation as reported by the device (from IMU or fixed). */
  orientation: z.enum(["portrait", "landscape"]).optional(),
});

export type DisplayCaps = z.infer<typeof displayCapsSchema>;

/** Resolved capabilities used by the render pipeline */
export interface ResolvedDisplay {
  width: number;
  height: number;
  palette: ColorPalette;
  format: OutputFormat;
  colorMode: ColorMode;
  colorCount: number;
  orientation: "portrait" | "landscape";
}

/** Fallback when device hasn't reported capabilities */
const DEFAULT_CAPS: DisplayCaps = {
  model: "unknown",
  width: 800,
  height: 480,
  palette: [[0, 0, 0], [255, 255, 255]],
  format: "raw",
  colorMode: "mono",
  orientations: [],
};

/**
 * SSOT display registry — all known display models.
 * Add new displays here; all other code imports from this registry.
 */
export const DISPLAY_REGISTRY: Record<string, {
  name: string;
  width: number;
  height: number;
  format: OutputFormat;
  colorMode: ColorMode;
  palette: [number, number, number][];
  orientations: ("portrait" | "landscape")[];
}> = {
  e1001: {
    name: "E1001 (7.5\" BW)",
    width: 800, height: 480,
    format: "raw", colorMode: "mono",
    palette: [[0, 0, 0], [255, 255, 255]],
    orientations: ["landscape"],
  },
  e1002: {
    name: "E1002 (7.3\" 6-Color)",
    width: 800, height: 480,
    format: "raw", colorMode: "indexed",
    palette: [[0, 0, 0], [255, 255, 255], [0, 128, 0], [0, 0, 255], [255, 0, 0], [255, 255, 0], [255, 128, 0]],
    orientations: ["landscape"],
  },
  e1003: {
    name: "E1003 (10.3\" 16-Gray)",
    width: 1872, height: 1404,
    format: "raw", colorMode: "grayscale",
    palette: Array.from({ length: 16 }, (_, i) => {
      const v = Math.round(i / 15 * 255);
      return [v, v, v] as [number, number, number];
    }),
    orientations: ["portrait", "landscape"],
  },
  d1001: {
    name: "D1001 (8\" LCD Color)",
    width: 800, height: 1280,
    format: "jpeg", colorMode: "fullcolor",
    palette: [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 128, 0]],
    orientations: ["portrait", "landscape"],
  },
};

/** Migrate legacy quantize field to format + colorMode */
function migrateQuantize(caps: DisplayCaps): { format: OutputFormat; colorMode: ColorMode } {
  if (caps.format && caps.colorMode) {
    return { format: caps.format, colorMode: caps.colorMode };
  }
  // Legacy migration from quantize field
  switch (caps.quantize) {
    case "jpeg": return { format: "jpeg", colorMode: "fullcolor" };
    case "color": return { format: "raw", colorMode: "indexed" };
    case "grayscale": return { format: "raw", colorMode: "grayscale" };
    case "mono": return { format: "raw", colorMode: "mono" };
    case "none": return { format: "raw", colorMode: "fullcolor" };
    default: return { format: caps.format ?? "raw", colorMode: caps.colorMode ?? "mono" };
  }
}

/**
 * Parse and validate display capabilities from a JSONB value.
 * Swaps width/height to match desired orientation.
 */
export function resolveDisplayCaps(raw: unknown, orientationOverride?: "portrait" | "landscape"): ResolvedDisplay {
  const result = displayCapsSchema.safeParse(raw);
  const caps = result.success ? result.data : DEFAULT_CAPS;

  const { format, colorMode } = migrateQuantize(caps);

  const orientation = orientationOverride
    ?? caps.orientation
    ?? (caps.height > caps.width ? "portrait" : "landscape");

  const nativePortrait = caps.height > caps.width;
  const wantPortrait = orientation === "portrait";
  const needSwap = nativePortrait !== wantPortrait;

  return {
    width: needSwap ? caps.height : caps.width,
    height: needSwap ? caps.width : caps.height,
    palette: caps.palette,
    format,
    colorMode,
    colorCount: caps.palette.length,
    orientation,
  };
}
