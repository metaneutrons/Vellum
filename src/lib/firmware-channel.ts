// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The firmware channels, in one place.
 *
 * Separate from `lib/firmware.ts` because that module talks to the GitHub release
 * API, so importing it for a value type drags the whole client along — and a test
 * that mocks it wholesale then breaks on every new export the module gains.
 *
 * The list is the source and the type follows it, so a new channel cannot leave
 * the narrowing below behind.
 */
export const FIRMWARE_CHANNELS = ["stable", "beta"] as const;

export type FirmwareChannel = (typeof FIRMWARE_CHANNELS)[number];

function isFirmwareChannel(value: unknown): value is FirmwareChannel {
  return typeof value === "string" && (FIRMWARE_CHANNELS as readonly string[]).includes(value);
}

/**
 * A channel, or `stable` for anything else — an unknown query parameter, or a
 * column written by a build that knew a channel this one does not.
 *
 * Falling back to the conservative channel is the safe direction: no device ends
 * up on a prerelease image because a value went bad.
 */
export function asFirmwareChannel(value: unknown): FirmwareChannel {
  return isFirmwareChannel(value) ? value : "stable";
}
