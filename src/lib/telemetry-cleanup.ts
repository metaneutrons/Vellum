// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { db, withDb } from "@/db";
import { telemetry } from "@/db/schema";
import { lt } from "drizzle-orm";
import { log } from "@/lib/logger";

const RETENTION_DAYS = 90;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

export function scheduleTelemetryCleanup() {
  runCleanup();
  setInterval(runCleanup, INTERVAL_MS);
}

async function runCleanup() {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000);
    await withDb(
      () => db.delete(telemetry).where(lt(telemetry.timestamp, cutoff)),
      "telemetry-cleanup"
    );
    log.info("Telemetry cleanup complete", { retentionDays: RETENTION_DAYS });
  } catch (err) {
    // withDb already logged retries and circuit state — just note the final failure
    log.warn("Telemetry cleanup skipped", { error: String(err) });
  }
}
