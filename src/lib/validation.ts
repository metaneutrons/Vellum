// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { z } from "zod";
import { displayCapsSchema } from "./display";

/**
 * MAC address schema — accepts both "AABBCCDDEEFF" and "AA:BB:CC:DD:EE:FF",
 * normalizes to uppercase compact form (no colons).
 */
export const macSchema = z
  .string()
  .transform((s) => s.replace(/:/g, "").toUpperCase())
  .pipe(z.string().regex(/^[0-9A-F]{12}$/, "Invalid MAC address"));

export const helloRequestSchema = z.object({
  mac: macSchema,
  publicKey: z.string().min(1).optional(),
  display: displayCapsSchema.optional(),
});

export const reportRequestSchema = z.object({
  mac: macSchema,
  issue: z.string().min(1),
});

export const renderQuerySchema = z.object({
  mac: macSchema,
});
