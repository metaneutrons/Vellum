// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { db } from "@/db";
import { telemetry } from "@/db/schema";
import { lt } from "drizzle-orm";

const RETENTION_DAYS = 90;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

export function scheduleTelemetryCleanup() {
  runCleanup();
  setInterval(runCleanup, INTERVAL_MS);
}

async function runCleanup() {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000);
    await db.delete(telemetry).where(lt(telemetry.timestamp, cutoff));
    console.log(`[cleanup] Deleted telemetry older than ${RETENTION_DAYS} days (before ${cutoff.toISOString().split("T")[0]})`);
  } catch (err) {
    console.error("[cleanup] Telemetry cleanup failed:", err);
  }
}
