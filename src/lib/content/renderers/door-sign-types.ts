// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Door-sign shared types — SSOT for renderer + editor.
 */

import { z } from "zod";
import { DISPLAY_REGISTRY } from "@/lib/display";

/* ── Display sizes ────────────────────────────────────────────── */

export interface DisplaySize {
  label: string;
  width: number;
  height: number;
}

/** All known display sizes (including orientation variants) derived from DISPLAY_REGISTRY */
export const KNOWN_DISPLAYS: DisplaySize[] = Object.entries(DISPLAY_REGISTRY).flatMap(([id, d]) =>
  d.orientations.map(o => {
    const isLandscape = o === "landscape";
    const w = isLandscape ? Math.max(d.width, d.height) : Math.min(d.width, d.height);
    const h = isLandscape ? Math.min(d.width, d.height) : Math.max(d.width, d.height);
    return { label: `${id.toUpperCase()} ${w}×${h}`, width: w, height: h };
  })
).filter((d, i, arr) => arr.findIndex(x => x.width === d.width && x.height === d.height) === i);

export const DEFAULT_DISPLAY: DisplaySize = KNOWN_DISPLAYS[0];

/* ── Template variables available in door-sign context ─────────── */

export const TEMPLATE_VARS: readonly { key: string; label: string }[] = [
  { key: "{full_name}", label: "Full name (organizer)" },
  { key: "{booking_description}", label: "Booking description" },
  { key: "{start}", label: "Start time" },
  { key: "{end}", label: "End time" },
  { key: "{date}", label: "Date" },
  { key: "{resource_name}", label: "Resource name" },
] as const;

/* ── Schemas ──────────────────────────────────────────────────── */

export const textBoxSchema = z.object({
  id: z.string(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
  template: z.string(),
  fontSize: z.number().min(0.01).max(0.5),
  align: z.enum(["left", "center", "right"]).default("center"),
  color: z.string().default("#000000"),
  bold: z.boolean().default(false),
});

export const designSchema = z.object({
  backgroundAssetId: z.string().uuid().nullable().default(null),
  textBoxes: z.array(textBoxSchema).default([]),
  freeTextBoxes: z.array(textBoxSchema).default([]),
  backgroundColor: z.string().default("#FFFFFF"),
});

export const doorSignConfigSchema = z.object({
  providerId: z.string().uuid(),
  resourceId: z.string(),
  resourceName: z.string().optional(),
  locale: z.string().default("de"),
  timezone: z.string().default("Europe/Berlin"),
  cachedProperties: z.record(z.string(), z.string()).default({}),
  design: designSchema,
  designOverrides: z.record(z.string(), designSchema).default({}),
});

export type TextBox = z.infer<typeof textBoxSchema>;
export type Design = z.infer<typeof designSchema>;
export type DoorSignConfig = z.infer<typeof doorSignConfigSchema>;
