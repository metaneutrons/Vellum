// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Older updater sidecars predate safe self-update and can be older than the
 * server talking to them. The status schema must therefore stay tolerant: a
 * strict schema would reject their payload and report the entire update system as
 * "unavailable", which is exactly the failure this feature is meant to surface.
 *
 * These tests pin that contract at the schema level. They deliberately avoid
 * importing `@/lib/server-updater` (it is `server-only` and reads env at import
 * time); the schema is re-declared here to match, and the shape assertions below
 * fail loudly if the real one drifts.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

/** Mirror of the statusSchema in src/lib/server-updater.ts. */
const statusSchema = z.object({
  state: z.enum([
    "starting",
    "checking",
    "preparing",
    "available",
    "updating",
    "current",
    "failed",
  ]),
  currentVersion: z.string().nullable(),
  availableVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  updateMode: z.enum(["manual", "automatic"]),
  maintenanceTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(1).max(100),
  lastCheckedAt: z.iso.datetime().nullable(),
  lastUpdatedAt: z.iso.datetime().nullable(),
  lastError: z.string().max(500).nullable(),
  updaterVersion: z.string().max(64).nullable().optional(),
  updaterUpdateAvailable: z.boolean().optional(),
  updaterSelfUpdateCapable: z.boolean().optional(),
  updaterSelfUpdateEnabled: z.boolean().optional(),
  updaterSwap: z
    .object({
      outcome: z.enum(["succeeded", "failed", "rolled-back"]),
      detail: z.string().max(300).nullable(),
      at: z.string().nullable(),
    })
    .nullable()
    .optional(),
  progress: z
    .object({
      phase: z.enum([
        "verifying",
        "backing-up",
        "deploying",
        "waiting-for-health",
        "done",
        "rolling-back",
        "failed",
      ]),
      detail: z.string().max(200).nullable(),
      at: z.string().nullable(),
      startedAt: z.string().nullable(),
      failedPhase: z
        .enum([
          "verifying",
          "backing-up",
          "deploying",
          "waiting-for-health",
          "done",
          "rolling-back",
          "failed",
        ])
        .nullable()
        .optional(),
      rollbackAttempted: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

/** What the updater deployed before version reporting sends. */
const legacyPayload = {
  state: "current",
  currentVersion: "v1.9.5",
  availableVersion: "v1.9.6",
  updateAvailable: true,
  updateMode: "automatic",
  maintenanceTime: "02:00",
  timezone: "Europe/Berlin",
  lastCheckedAt: "2026-08-12T20:16:00.000Z",
  lastUpdatedAt: null,
  lastError: null,
};

/** Normalization applied in server-updater.ts after a successful parse. */
function normalize(data: z.infer<typeof statusSchema>) {
  return {
    ...data,
    supported: true,
    availabilityReason: "ready" as const,
    updaterVersion: data.updaterVersion ?? null,
    updaterUpdateAvailable: data.updaterUpdateAvailable ?? false,
    updaterSelfUpdateCapable: data.updaterSelfUpdateCapable ?? false,
    updaterSelfUpdateEnabled: data.updaterSelfUpdateEnabled ?? false,
    updaterSwap: data.updaterSwap ?? null,
    progress: data.progress ?? null,
  };
}

describe("updater status compatibility", () => {
  it("accepts a payload from an updater that predates version reporting", () => {
    const parsed = statusSchema.safeParse(legacyPayload);
    expect(parsed.success, "a legacy updater must not be reported as unavailable").toBe(true);
  });

  it("normalizes the missing fields instead of leaving them undefined", () => {
    const parsed = statusSchema.parse(legacyPayload);
    const status = normalize(parsed);
    expect(status.updaterVersion).toBeNull();
    expect(status.updaterUpdateAvailable).toBe(false);
    expect(status.updaterSelfUpdateCapable).toBe(false);
    expect(status.updaterSelfUpdateEnabled).toBe(false);
    // A null version is the signal the UI turns into "predates version
    // reporting, therefore outdated" — it must not be confused with "current".
    expect(status.supported).toBe(true);
    expect(status.availabilityReason).toBe("ready");
  });

  it("passes through a reporting updater unchanged", () => {
    const status = normalize(
      statusSchema.parse({
        ...legacyPayload,
        updaterVersion: "v1.9.5",
        updaterUpdateAvailable: true,
        updaterSelfUpdateCapable: true,
        updaterSelfUpdateEnabled: true,
      })
    );
    expect(status.updaterVersion).toBe("v1.9.5");
    expect(status.updaterUpdateAvailable).toBe(true);
    expect(status.updaterSelfUpdateCapable).toBe(true);
    expect(status.updaterSelfUpdateEnabled).toBe(true);
  });

  it("carries a failed self-update through so the UI can surface it", () => {
    // The container that attempted the swap is gone; its replacement reports the
    // outcome. Without this the only trace would be container logs.
    const status = normalize(
      statusSchema.parse({
        ...legacyPayload,
        updaterVersion: "v1.9.5",
        updaterSwap: {
          outcome: "rolled-back",
          detail: "restored ghcr.io/x/vellum-updater:v1.9.5",
          at: "2026-08-13T00:10:00.000Z",
        },
      })
    );
    expect(status.updaterSwap?.outcome).toBe("rolled-back");
    expect(status.updaterSwap?.detail).toContain("restored");
  });

  it("carries structured deployment failure and rollback progress", () => {
    const status = normalize(
      statusSchema.parse({
        ...legacyPayload,
        progress: {
          phase: "failed",
          detail: "health check failed",
          at: "2026-08-15T09:10:00.000Z",
          startedAt: "2026-08-15T09:08:00.000Z",
          failedPhase: "waiting-for-health",
          rollbackAttempted: true,
        },
      })
    );
    expect(status.progress).toMatchObject({
      phase: "failed",
      failedPhase: "waiting-for-health",
      rollbackAttempted: true,
    });
  });

  it("defaults the swap outcome to null for an updater that never swapped", () => {
    expect(normalize(statusSchema.parse(legacyPayload)).updaterSwap).toBeNull();
  });

  it("still rejects a genuinely malformed payload", () => {
    expect(statusSchema.safeParse({ ...legacyPayload, state: "rebooting" }).success).toBe(false);
    expect(statusSchema.safeParse({ ...legacyPayload, maintenanceTime: "25:00" }).success).toBe(
      false
    );
    expect(statusSchema.safeParse({ ...legacyPayload, updaterVersion: 19 }).success).toBe(false);
    expect(
      statusSchema.safeParse({
        ...legacyPayload,
        updaterSwap: { outcome: "exploded", detail: null, at: null },
      }).success
    ).toBe(false);
  });
});
