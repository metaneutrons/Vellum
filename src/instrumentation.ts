// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

export async function register() {
  // Only run cleanup in Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { scheduleTelemetryCleanup } = await import("./lib/telemetry-cleanup");
    scheduleTelemetryCleanup();
  }
}
