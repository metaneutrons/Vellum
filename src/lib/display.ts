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

export type QuantizeMode = "color" | "grayscale" | "mono" | "none";

/** Schema for device-reported display capabilities */
export const displayCapsSchema = z.object({
  model: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  palette: z.array(z.tuple([z.number(), z.number(), z.number()])).min(0),
  quantize: z.enum(["color", "grayscale", "mono", "none"]),
});

export type DisplayCaps = z.infer<typeof displayCapsSchema>;

/** Resolved capabilities used by the render pipeline */
export interface ResolvedDisplay {
  width: number;
  height: number;
  palette: ColorPalette;
  quantize: QuantizeMode;
  colorCount: number;
}

/** Fallback when device hasn't reported capabilities */
const DEFAULT_CAPS: DisplayCaps = {
  model: "unknown",
  width: 800,
  height: 480,
  palette: [[0, 0, 0], [255, 255, 255]],
  quantize: "mono",
};

/**
 * Parse and validate display capabilities from a JSONB value.
 * Returns validated caps or the default fallback.
 */
export function resolveDisplayCaps(raw: unknown): ResolvedDisplay {
  const result = displayCapsSchema.safeParse(raw);
  const caps = result.success ? result.data : DEFAULT_CAPS;
  return {
    width: caps.width,
    height: caps.height,
    palette: caps.palette,
    quantize: caps.quantize,
    colorCount: caps.palette.length,
  };
}
