// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The development simulator enrols as a real device row, under a fixed address.
 *
 * Which means it competes with the displays on the wall wherever the system picks
 * "a device showing this content". That is not hypothetical: the content preview
 * used to choose arbitrarily and landed on the simulator, so an operator was shown
 * a 1872x1404 portrait panel for content that hangs on a 1280x800 landscape one.
 * Ordering by "most recently seen" fixed the arbitrariness and would have
 * reintroduced the same wrong answer the moment somebody opened the simulator,
 * because the simulator is then the most recently seen device of all.
 *
 * So it is named here once and sorted last wherever the choice is made. Its page
 * returns 404 outside development, but its row survives in whatever database a
 * developer pointed it at, which for a small deployment is the same database that
 * serves the wall.
 */

/** The simulator's own address, hard-coded in `app/simulator/client.tsx`. */
export const SIMULATOR_MAC = "DEADBEEFCAFE";

export function isSimulator(mac: string): boolean {
  return mac.toUpperCase() === SIMULATOR_MAC;
}
