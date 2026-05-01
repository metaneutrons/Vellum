// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Next.js instrumentation — runs once on server startup.
 * Used for scheduled background tasks.
 */

const TELEMETRY_RETENTION_DAYS = 90;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

export async function register() {
  // Only run on the server (not edge)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    scheduleTelemetryCleanup();
  }
}

function scheduleTelemetryCleanup() {
  // Run once on startup, then every 24h
  runCleanup();
  setInterval(runCleanup, CLEANUP_INTERVAL_MS);
}

async function runCleanup() {
  try {
    const { db } = await import("@/db");
    const { telemetry } = await import("@/db/schema");
    const { lt } = await import("drizzle-orm");

    const cutoff = new Date(Date.now() - TELEMETRY_RETENTION_DAYS * 86400_000);
    const result = await db.delete(telemetry).where(lt(telemetry.timestamp, cutoff));

    console.log(`[cleanup] Deleted telemetry older than ${TELEMETRY_RETENTION_DAYS} days (before ${cutoff.toISOString().split("T")[0]})`);
  } catch (err) {
    console.error("[cleanup] Telemetry cleanup failed:", err);
  }
}
