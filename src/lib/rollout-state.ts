// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The rollout states, in one place.
 *
 * Separate from `lib/rollout.ts` because that module reaches for the database and
 * `node:crypto`, so a client component cannot import it. The rollout panel used
 * to re-declare the union and its list for that reason, which is two lists to
 * keep in step.
 *
 * The list is the source and the type follows it, so a new state cannot leave the
 * narrowing below behind.
 */
export const ROLLOUT_STATES = ["paused", "canary", "percent", "full", "halted"] as const;

export type RolloutState = (typeof ROLLOUT_STATES)[number];

/** Default when a version has no rollout row: ship as before (no gating). */
export const DEFAULT_ROLLOUT_STATE: RolloutState = "full";

function isRolloutState(value: unknown): value is RolloutState {
  return typeof value === "string" && (ROLLOUT_STATES as readonly string[]).includes(value);
}

/**
 * A stored rollout state, or the default when the column holds a value this build
 * does not know — a downgrade, or a state removed since the row was written.
 */
export function asRolloutState(value: unknown): RolloutState {
  return isRolloutState(value) ? value : DEFAULT_ROLLOUT_STATE;
}
