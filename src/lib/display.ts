// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Display capabilities — device-reported, server-stored.
 *
 * The device sends its full capabilities in /hello. The server
 * stores them as JSONB and uses them for rendering. No server
 * changes needed when new display hardware is added.
 *
 * Fallback defaults are provided for devices that haven't
 * reported capabilities yet.
 */

import { z } from "zod";
import type { ColorPalette } from "./render/dither";

export type QuantizeMode = "color" | "grayscale" | "mono" | "none" | "jpeg";

/** Schema for device-reported display capabilities */
export const displayCapsSchema = z.object({
  model: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  palette: z.array(z.tuple([z.number(), z.number(), z.number()])).min(0),
  quantize: z.enum(["color", "grayscale", "mono", "none", "jpeg"]),
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
  quantize: QuantizeMode;
  colorCount: number;
  orientation: "portrait" | "landscape";
}

/** Fallback when device hasn't reported capabilities */
const DEFAULT_CAPS: DisplayCaps = {
  model: "unknown",
  width: 800,
  height: 480,
  palette: [[0, 0, 0], [255, 255, 255]],
  quantize: "mono",
  orientations: [],
};

/**
 * Parse and validate display capabilities from a JSONB value.
 * Optionally accepts an admin orientation override for sensorless devices.
 */
export function resolveDisplayCaps(raw: unknown, orientationOverride?: "portrait" | "landscape"): ResolvedDisplay {
  const result = displayCapsSchema.safeParse(raw);
  const caps = result.success ? result.data : DEFAULT_CAPS;

  // Determine orientation: override > device-reported > infer from dimensions
  const orientation = orientationOverride
    ?? caps.orientation
    ?? (caps.height > caps.width ? "portrait" : "landscape");

  // Swap width/height if orientation doesn't match native dimensions
  const nativePortrait = caps.height > caps.width;
  const wantPortrait = orientation === "portrait";
  const needSwap = nativePortrait !== wantPortrait;

  return {
    width: needSwap ? caps.height : caps.width,
    height: needSwap ? caps.width : caps.height,
    palette: caps.palette,
    quantize: caps.quantize,
    colorCount: caps.palette.length,
    orientation,
  };
}
