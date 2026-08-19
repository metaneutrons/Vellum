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
  /**
   * Palette positions that exist as on-wire pixel codes but that the panel cannot
   * actually produce, and which the renderer must therefore never select.
   *
   * E1002 is the case this exists for: GDEP073E01 is a six-color Spectra panel
   * whose codes are 0x0–0x3, 0x5, 0x6 — 0x4 is unused. Because a palette position
   * IS its pixel code, that gap cannot be closed by shortening the array without
   * sliding blue onto 0x4 and green onto 0x5.
   */
  reservedPaletteIndices: z.array(z.number().int().nonnegative()).default([]),
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
  /** Palette positions the renderer must never select. See displayCapsSchema. */
  reservedPaletteIndices: number[];
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
  palette: [
    [0, 0, 0],
    [255, 255, 255],
  ],
  reservedPaletteIndices: [],
  format: "raw",
  colorMode: "mono",
  orientations: [],
};

/**
 * SSOT display registry — all known display models.
 * Add new displays here; all other code imports from this registry.
 */
export const DISPLAY_REGISTRY: Record<
  string,
  {
    name: string;
    width: number;
    height: number;
    format: OutputFormat;
    colorMode: ColorMode;
    palette: [number, number, number][];
    /** See displayCapsSchema — positions that are pixel codes but not usable colors. */
    reservedPaletteIndices?: number[];
    orientations: ("portrait" | "landscape")[];
  }
> = {
  e1001: {
    name: 'E1001 (7.5" BW)',
    width: 800,
    height: 480,
    format: "raw",
    colorMode: "mono",
    palette: [
      [0, 0, 0],
      [255, 255, 255],
    ],
    orientations: ["landscape"],
  },
  e1002: {
    name: 'E1002 (7.3" 6-Color)',
    width: 800,
    height: 480,
    format: "raw",
    colorMode: "indexed",
    /* Positions are on-wire pixel codes, so this must match the firmware's order
     * exactly (components/http_client/http_client.c, EPD_PIXEL_* in
     * epaper_config.h). It previously listed the same seven colors in the ACeP
     * Gallery order — green and blue at 0x2/0x3, red at 0x4 — which is a different
     * panel family, so every preview disagreed with the hardware.
     * 0x4 is reserved: unused on Spectra 6. */
    palette: [
      [0, 0, 0], // 0x0 black
      [255, 255, 255], // 0x1 white
      [255, 255, 0], // 0x2 yellow
      [255, 0, 0], // 0x3 red
      [255, 255, 255], // 0x4 reserved
      [0, 0, 255], // 0x5 blue
      [0, 255, 0], // 0x6 green
    ],
    reservedPaletteIndices: [4],
    orientations: ["landscape"],
  },
  e1003: {
    name: 'E1003 (10.3" 16-Gray)',
    width: 1872,
    height: 1404,
    format: "raw",
    colorMode: "grayscale",
    palette: Array.from({ length: 16 }, (_, i) => {
      const v = Math.round((i / 15) * 255);
      return [v, v, v] as [number, number, number];
    }),
    orientations: ["portrait", "landscape"],
  },
  d1001: {
    name: 'D1001 (8" LCD Color)',
    width: 800,
    height: 1280,
    format: "jpeg",
    colorMode: "fullcolor",
    palette: [
      [0, 0, 0],
      [255, 255, 255],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 0],
      [255, 128, 0],
    ],
    orientations: ["portrait", "landscape"],
  },
};

/** Complete a model-only or legacy partial capability record from the canonical
 * registry. Device-reported fields win when present; the registry supplies only
 * what is missing. Unknown models remain untouched rather than being guessed. */
export function completeDisplayCaps(raw: unknown, model: string): DisplayCaps | null {
  const canonical = DISPLAY_REGISTRY[model.toLowerCase()];
  if (!canonical) return null;
  const reported =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const result = displayCapsSchema.safeParse({
    width: canonical.width,
    height: canonical.height,
    palette: canonical.palette,
    reservedPaletteIndices: canonical.reservedPaletteIndices ?? [],
    format: canonical.format,
    colorMode: canonical.colorMode,
    orientations: canonical.orientations,
    ...reported,
    // The authenticated config request's compile-time model header is the
    // authoritative identity for this repair.
    model: model.toLowerCase(),
  });
  return result.success ? result.data : null;
}

/** Migrate legacy quantize field to format + colorMode */
function migrateQuantize(caps: DisplayCaps): { format: OutputFormat; colorMode: ColorMode } {
  if (caps.format && caps.colorMode) {
    return { format: caps.format, colorMode: caps.colorMode };
  }
  // Legacy migration from quantize field
  switch (caps.quantize) {
    case "jpeg":
      return { format: "jpeg", colorMode: "fullcolor" };
    case "color":
      return { format: "raw", colorMode: "indexed" };
    case "grayscale":
      return { format: "raw", colorMode: "grayscale" };
    case "mono":
      return { format: "raw", colorMode: "mono" };
    case "none":
      return { format: "raw", colorMode: "fullcolor" };
    default:
      return { format: caps.format ?? "raw", colorMode: caps.colorMode ?? "mono" };
  }
}

/**
 * Parse and validate display capabilities from a JSONB value.
 * Swaps width/height to match desired orientation.
 */
/**
 * Merge the surface a device reports into its stored capabilities.
 *
 * Only /config used to do this, and the device asks for its frame BEFORE it polls
 * /config. So the first frame of every boot was rendered from whatever geometry the
 * row still held, and after a mounting change that is the old one: a D1001 whose
 * surface had just become landscape 1280x800 was sent a portrait 800x1280 frame,
 * drawn top-left, with everything below row 800 cut off. It looked like the content
 * had failed to load, and it corrected itself only on the next cycle.
 *
 * Deliberately narrow, same as on /config: geometry and mountings are measurements
 * the driver alone knows, while orientationOverride is an operator decision a device
 * must never overrule.
 */
export function mergeReportedCaps(
  stored: unknown,
  header: string | null
): { caps: unknown; changed: boolean } {
  const reported = parseDisplayCapsHeader(header);
  if (!reported || !displayCapsSchema.safeParse(stored).success) {
    return { caps: stored, changed: false };
  }
  const merged = {
    ...(stored as Record<string, unknown>),
    width: reported.width,
    height: reported.height,
    orientation: reported.orientation,
    orientations: reported.orientations,
  };
  return { caps: merged, changed: JSON.stringify(merged) !== JSON.stringify(stored) };
}

export function resolveDisplayCaps(
  raw: unknown,
  orientationOverride?: "portrait" | "landscape"
): ResolvedDisplay {
  const result = displayCapsSchema.safeParse(raw);
  const caps = result.success ? result.data : DEFAULT_CAPS;

  const { format, colorMode } = migrateQuantize(caps);

  /*
   * Landscape is the default, deliberately, and there is no third "derive it from
   * the geometry" state any more. That guess is what made a D1001 portrait: its
   * panel is natively 800x1280, so taller-than-wide read as "mounted portrait"
   * when the device had said nothing of the kind.
   *
   * Stage two is not a guess and stays: a device that reports its own mounting is
   * stating a fact about the installation, and the renderer must follow it.
   *
   * The one case this changes is firmware old enough to report geometry but no
   * mounting. Such a device really does have a portrait surface, so it will be
   * rendered landscape and look wrong until it is updated. Every device in the
   * fleet reports an explicit mounting, so this is a path for a downgraded or
   * very old image, not for anything deployed.
   */
  const orientation = orientationOverride ?? caps.orientation ?? "landscape";

  const nativePortrait = caps.height > caps.width;
  const wantPortrait = orientation === "portrait";
  const needSwap = nativePortrait !== wantPortrait;

  // Only positions that exist in the palette can be reserved; a device reporting a
  // stray index must not shrink the count below what it can actually print.
  const reserved = caps.reservedPaletteIndices.filter((i) => i < caps.palette.length);

  return {
    width: needSwap ? caps.height : caps.width,
    height: needSwap ? caps.width : caps.height,
    palette: caps.palette,
    reservedPaletteIndices: reserved,
    format,
    colorMode,
    // What the panel can print, which is what operators are shown — not the length
    // of the code space.
    colorCount: caps.palette.length - reserved.length,
    orientation,
  };
}
export type Orientation = "portrait" | "landscape";

/**
 * Parse the `X-Display-Caps` header a device sends on every poll.
 *
 * Capabilities used to arrive only with `/hello`, so they were pinned to
 * enrolment while the firmware describing them keeps changing. A display
 * enrolled with the wrong geometry kept it forever, which is how a D1001 went on
 * advertising portrait 800x1280 long after its drawable surface had become
 * landscape 1280x800 — costing 480px off the bottom of every portrait render.
 *
 * Format: `WxH;orientation;orientations,csv` — only what the server cannot derive
 * from the model. Treated as untrusted input: a device may be on any firmware, so
 * anything malformed or out of range yields null and the stored record stands.
 */
export function parseDisplayCapsHeader(value: string | null | undefined): {
  width: number;
  height: number;
  orientation: Orientation;
  orientations: Orientation[];
} | null {
  if (!value) return null;
  const [geometry, orientation, list] = value.split(";");
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(geometry?.trim() ?? "");
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  // A plausible panel, not an arbitrary number: the value sizes render buffers.
  if (!width || !height || width > 4096 || height > 4096) return null;

  const isOrientation = (v: string): v is Orientation => v === "portrait" || v === "landscape";
  const current = orientation?.trim() ?? "";
  if (!isOrientation(current)) return null;

  const orientations = (list ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(isOrientation);
  // A device that reports no mounting it supports still supports the one it is in.
  if (!orientations.includes(current)) orientations.unshift(current);

  return { width, height, orientation: current, orientations };
}
