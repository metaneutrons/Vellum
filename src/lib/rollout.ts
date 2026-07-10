// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Fleet OTA rollout control.
 *
 * The ROLLOUT — not "the newest artifact" — decides what ships to a device, so
 * publishing a release never auto-ships to 100% of a channel and a bad build is
 * one `halted` away from stopping fleet-wide. Two independent gates apply on
 * top of the version/channel resolution:
 *
 *   1. Failure blocklist — a device that already reported a failed OTA for a
 *      target version is never re-offered it, breaking the brick-retry loop
 *      (rollback → old version reported → same bad image re-served → repeat).
 *   2. Rollout state — a per-(version, channel) record gates eligibility. A
 *      device's cohort is a deterministic hash of its MAC, so it stays in (or
 *      out of) a canary across polls. A version with NO row falls back to
 *      `full` — i.e. current auto-ship behaviour — so this is backward
 *      compatible until an operator explicitly gates, canaries, or halts.
 */
import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, withDb } from "@/db";
import { firmwareRollouts, otaEvents } from "@/db/schema";

export type RolloutState = "paused" | "canary" | "percent" | "full" | "halted";

/** Default when a version has no rollout row: ship as before (no gating). */
export const DEFAULT_ROLLOUT_STATE: RolloutState = "full";

/** OTA phases that mark a target version as PERSISTENTLY failed for a device —
 *  a bad signature/model/hash (verify_fail) or an image that booted but failed
 *  its health check (rolled_back). Transient download failures are NOT included:
 *  they should be retried, not blocklisted. These must be valid `otaReportSchema`
 *  phases. */
export const OTA_FAILED_PHASES = ["verify_fail", "rolled_back"] as const;

/**
 * Deterministic cohort bucket [0,100) for a device MAC. Stable across polls so a
 * device that's in a 10% canary stays in it as the percentage advances.
 */
export function deviceBucket(mac: string): number {
  const digest = crypto.createHash("sha256").update(mac.toLowerCase()).digest();
  return digest.readUInt32BE(0) % 100;
}

/** True if this device already reported a failed OTA for `version`. */
export async function deviceFailedTarget(mac: string, version: string): Promise<boolean> {
  try {
    const rows = await withDb(
      () =>
        db
          .select({ id: otaEvents.id })
          .from(otaEvents)
          .where(
            and(
              eq(otaEvents.mac, mac),
              eq(otaEvents.toVersion, version),
              inArray(otaEvents.phase, [...OTA_FAILED_PHASES]),
            ),
          )
          .limit(1),
      "ota-failed-check",
    );
    return rows.length > 0;
  } catch {
    // Fail OPEN on a DB hiccup: better to (rarely) re-offer than to wedge OTA.
    return false;
  }
}

/**
 * Is this device eligible for `version` on `channel` right now, per its rollout
 * state? A missing row means DEFAULT_ROLLOUT_STATE.
 */
export async function isDeviceInRollout(
  mac: string,
  version: string,
  channel: string,
): Promise<boolean> {
  let rollout: { state: string; percent: number } | undefined;
  try {
    [rollout] = await withDb(
      () =>
        db
          .select({ state: firmwareRollouts.state, percent: firmwareRollouts.percent })
          .from(firmwareRollouts)
          .where(and(eq(firmwareRollouts.version, version), eq(firmwareRollouts.channel, channel)))
          .limit(1),
      "rollout-lookup",
    );
  } catch {
    // DB unavailable → fall back to the default state (ship as before).
    rollout = undefined;
  }

  const state = (rollout?.state as RolloutState) ?? DEFAULT_ROLLOUT_STATE;
  switch (state) {
    case "halted":
    case "paused":
      return false;
    case "full":
      return true;
    case "canary":
    case "percent":
      return deviceBucket(mac) < (rollout?.percent ?? 0);
    default:
      return true;
  }
}
