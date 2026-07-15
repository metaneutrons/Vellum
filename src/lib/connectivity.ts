// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

/**
 * Device connectivity (liveness) — ORTHOGONAL to authorization status
 * (pending / approved / rejected). Judged relative to each device's OWN
 * expected check-in cadence (the sleep interval the server last handed it),
 * never a fixed wall-clock window: a low-battery display on a 1 h interval must
 * not read as "offline", and a USB display on a 60 s interval that dies must be
 * caught quickly. This is the single source of truth for online/offline across
 * the dashboard and the device list.
 */
export type Connectivity = "online" | "late" | "offline" | "never";

/** Fallback interval when a device has none recorded yet (battery default). */
export const DEFAULT_INTERVAL_S = 900;

/** Absorbs render-side jitter, clock skew, and one slightly-late wake. */
const GRACE_S = 60;
/** Seen within this × interval → still online. */
const ONLINE_MAX_FACTOR = 1.5;
/** Within this × interval → late (missed a check-in); beyond → offline. */
const LATE_MAX_FACTOR = 3;

/**
 * Classify a device's connectivity from its last check-in and expected cadence.
 * Pure + numeric so it is trivially testable and safe in server and client
 * bundles alike. Callers parse DB timestamps to epoch ms first (see
 * `parseDeviceTs`).
 */
export function deviceConnectivity(
  lastSeenMs: number | null,
  expectedIntervalS: number | null | undefined,
  nowMs: number,
): Connectivity {
  if (lastSeenMs === null) return "never";
  const interval = expectedIntervalS && expectedIntervalS > 0 ? expectedIntervalS : DEFAULT_INTERVAL_S;
  const ageS = (nowMs - lastSeenMs) / 1000;
  if (ageS <= interval * ONLINE_MAX_FACTOR + GRACE_S) return "online";
  if (ageS <= interval * LATE_MAX_FACTOR + GRACE_S) return "late";
  return "offline";
}

/** Badge / dot tone for a connectivity state (names match `ui/badge` tones). */
export function connectivityTone(c: Connectivity): "green" | "orange" | "red" | "neutral" {
  switch (c) {
    case "online":
      return "green";
    case "late":
      return "orange";
    case "offline":
      return "red";
    case "never":
      return "neutral";
  }
}
