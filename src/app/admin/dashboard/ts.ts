// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Parse a DB timestamp to epoch ms. DB timestamps arrive UTC without a zone
 * marker, so we normalise (like the device table does) before parsing.
 * Pure + dependency-free so it is safe in both server and client bundles.
 */
export function parseDeviceTs(ts: string | null): number | null {
  if (!ts) return null;
  const hasZone = /[Z]|\dT\d.*[-+]\d\d/.test(ts);
  const iso = hasZone ? ts : ts.replace(" ", "T") + "Z";
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}
