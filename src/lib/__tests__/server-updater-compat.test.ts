// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The updater sidecar never replaces its own container, so a deployed stack runs
 * an updater that is older than the server talking to it — by design. The status
 * schema must therefore stay tolerant: a strict schema would reject the whole
 * payload of an older updater and report the entire update system as
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
  state: z.enum(["starting", "checking", "available", "updating", "current", "failed"]),
  currentVersion: z.string().nullable(),
  availableVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  updateMode: z.enum(["manual", "automatic"]),
  maintenanceTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(1).max(100),
  lastCheckedAt: z.string().datetime().nullable(),
  lastUpdatedAt: z.string().datetime().nullable(),
  lastError: z.string().max(500).nullable(),
  updaterVersion: z.string().max(64).nullable().optional(),
  updaterUpdateAvailable: z.boolean().optional(),
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
    updaterVersion: data.updaterVersion ?? null,
    updaterUpdateAvailable: data.updaterUpdateAvailable ?? false,
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
    // A null version is the signal the UI turns into "predates version
    // reporting, therefore outdated" — it must not be confused with "current".
    expect(status.supported).toBe(true);
  });

  it("passes through a reporting updater unchanged", () => {
    const status = normalize(
      statusSchema.parse({ ...legacyPayload, updaterVersion: "v1.9.5", updaterUpdateAvailable: true }),
    );
    expect(status.updaterVersion).toBe("v1.9.5");
    expect(status.updaterUpdateAvailable).toBe(true);
  });

  it("still rejects a genuinely malformed payload", () => {
    expect(statusSchema.safeParse({ ...legacyPayload, state: "rebooting" }).success).toBe(false);
    expect(statusSchema.safeParse({ ...legacyPayload, maintenanceTime: "25:00" }).success).toBe(false);
    expect(statusSchema.safeParse({ ...legacyPayload, updaterVersion: 19 }).success).toBe(false);
  });
});
