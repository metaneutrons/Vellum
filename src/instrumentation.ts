// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

export async function register() {
  // Only run cleanup in Node.js runtime (not Edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { scheduleTelemetryCleanup } = await import("./lib/telemetry-cleanup");
    scheduleTelemetryCleanup();

    /* Hydrate the last-known-good firmware catalog from PostgreSQL before the
     * first admin/device request. GitHub discovery is scheduled but deliberately
     * not awaited: an external API may never extend server startup or first-page
     * latency. */
    const { initializeFirmwareCatalog, syncAutoPoll } = await import("./lib/firmware");
    await initializeFirmwareCatalog();
    await syncAutoPoll();
  }
}
