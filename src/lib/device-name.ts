// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * What to call a display, in one place.
 *
 * A device is identified by its MAC everywhere in the system, which is correct
 * for the machine and useless for a person standing in a corridor. Until this
 * existed the only human handle was the content it happened to carry, and that
 * changes whenever the assignment does.
 *
 * The order is operator's name, then the assigned content, then the address. The
 * MAC is never hidden entirely — it is what the sticker on the back says, and it
 * is what someone matches against when they are holding the thing — so views show
 * it alongside rather than instead.
 */
export function deviceName(
  device: { label?: string | null; mac: string },
  contentName?: string | null
): string {
  return device.label?.trim() || contentName?.trim() || device.mac;
}

/** True when the name above is something a person chose, rather than a fallback. */
export function hasOwnName(device: { label?: string | null }): boolean {
  return Boolean(device.label?.trim());
}
