// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/** A refresh cadence, short enough to sit inline. */
export function fmtInterval(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(seconds % 3600 ? 1 : 0)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}
