// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Door-sign-multi types — multi-resource name plate (e.g. shared office with multiple desks).
 *
 * Layout: Header area (free TextBoxes) + repeating resource rows.
 * The row template is defined once and rendered for each resource.
 */

import { z } from "zod";
import { textBoxSchema, designSchema } from "./door-sign-types";

/* ── Resource entry ───────────────────────────────────────────── */

export const resourceEntrySchema = z.object({
  providerId: z.string().uuid(),
  resourceId: z.string(),
  resourceName: z.string().optional(),
});

export type ResourceEntry = z.infer<typeof resourceEntrySchema>;

/* ── Row template (rendered once per resource) ────────────────── */

export const rowTemplateSchema = z.object({
  /** Height of each row as fraction of total height (0-1) */
  height: z.number().min(0.05).max(0.5).default(0.12),
  /** TextBoxes within the row (positions relative to row bounds) */
  textBoxes: z.array(textBoxSchema).default([]),
  /** TextBoxes shown when resource is free */
  freeTextBoxes: z.array(textBoxSchema).default([]),
});

export type RowTemplate = z.infer<typeof rowTemplateSchema>;

/* ── Config schema ────────────────────────────────────────────── */

export const doorSignMultiConfigSchema = z.object({
  resources: z.array(resourceEntrySchema).min(1),
  locale: z.string().default("de"),
  timezone: z.string().default("Europe/Berlin"),
  cachedProperties: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  /** Header area design (background + header TextBoxes) */
  design: designSchema,
  designOverrides: z.record(z.string(), designSchema).default({}),
  /** Header height as fraction (0-1). Remaining space is split among resource rows. */
  headerHeight: z.number().min(0).max(0.8).default(0.25),
  /** Row template — repeated for each resource */
  rowTemplate: rowTemplateSchema.default({ height: 0.12, textBoxes: [], freeTextBoxes: [] }),
});

export type DoorSignMultiConfig = z.infer<typeof doorSignMultiConfigSchema>;

/* ── Template variables available in multi context ─────────────── */

export const MULTI_TEMPLATE_VARS: readonly { key: string; label: string }[] = [
  { key: "{resource_name}", label: "Resource name" },
  { key: "{full_name}", label: "Current occupant" },
  { key: "{start}", label: "Booking start" },
  { key: "{end}", label: "Booking end" },
  { key: "{status}", label: "Free / Occupied" },
] as const;
