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
    const { log } = await import("./lib/logger");
    /* Guarded separately, because the database can legitimately be unreachable or
     * unmigrated at boot: compose starts the app alongside Postgres, and the
     * container's auto-migration is fail-open by design. An unguarded throw here
     * escaped register() before syncAutoPoll ran, and auto-poll is otherwise only
     * re-established when an operator re-saves the setting — so a transient boot
     * error silently disabled firmware polling for the life of the process.
     * Hydration itself needs no retry here; getAllManifests() re-attempts it. */
    await initializeFirmwareCatalog().catch((err) =>
      log.warn("Firmware catalog hydration skipped", { error: String(err) })
    );
    await syncAutoPoll().catch((err) =>
      log.warn("Firmware auto-poll sync skipped", { error: String(err) })
    );
  }
}
