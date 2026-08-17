// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { z } from "zod";
import { displayCapsSchema } from "./display";

/** UUID v4 regex — use for validating path/query params before DB queries */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** OTA outcome report — device posts one per phase transition of an update. */
export const OTA_PHASES = [
  "downloading",
  "verify_ok",
  "verify_fail",
  "applied",
  "boot_confirmed",
  "rolled_back",
  "deferred",
] as const;

export const otaReportSchema = z.object({
  mac: macSchema,
  model: z.string().max(32).optional(),
  fromVersion: z.string().max(64).optional(),
  toVersion: z.string().max(64).optional(),
  phase: z.enum(OTA_PHASES),
  errorCode: z.string().max(64).optional(),
});

export const configurationReportSchema = z
  .object({
    mac: macSchema,
    id: z.uuid(),
    status: z.enum(["applying", "applied", "failed"]),
    errorCode: z.string().max(64).optional(),
  })
  .superRefine((value, context) => {
    if (value.status === "failed" && !value.errorCode) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "errorCode is required for failure",
      });
    }
    if (value.status !== "failed" && value.errorCode) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "errorCode is invalid for success",
      });
    }
  });

export const renderQuerySchema = z.object({
  mac: macSchema,
});
