// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { readDeviceRequest } from "@/lib/device-request";
import { and, eq, lt, sql } from "drizzle-orm";
import { db, withDbWrite } from "@/db";
import { deviceLogs } from "@/db/schema";
import { okResponse, errorResponse } from "@/lib/api-response";
import { deviceLogBatchSchema } from "@/lib/validation";
import { log } from "@/lib/logger";

/** Keep a bounded history per device: enough to read an incident, not a fleet-wide archive. */
const RETAIN_DAYS = 30;
const RETAIN_BATCHES = 50;

/*
 * Pruned on write rather than by a scheduler: uploads are event-driven and rare,
 * so this runs about as often as it needs to and the deployment needs no cron.
 */
async function prune(mac: string) {
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000);
  await withDbWrite(
    () =>
      db.delete(deviceLogs).where(and(eq(deviceLogs.mac, mac), lt(deviceLogs.receivedAt, cutoff))),
    "prune-device-logs-by-age"
  );
  await withDbWrite(
    () =>
      db.delete(deviceLogs).where(
        and(
          eq(deviceLogs.mac, mac),
          sql`${deviceLogs.id} NOT IN (
              SELECT id FROM ${deviceLogs}
              WHERE ${deviceLogs.mac} = ${mac}
              ORDER BY ${deviceLogs.receivedAt} DESC, ${deviceLogs.id} DESC
              LIMIT ${RETAIN_BATCHES}
            )`
        )
      ),
    "prune-device-logs-by-count"
  );
}

export async function POST(request: NextRequest) {
  const parsed = await readDeviceRequest(request, deviceLogBatchSchema);
  if (!parsed.ok) return parsed.response;

  const { mac, seq, lines } = parsed.data;
  try {
    /* A device re-offers the same sequence until it sees a 2xx, so a lost
     * response must cost nothing. The unique (mac, seq) index turns the retry
     * into a no-op, and the device still gets its 2xx and drops the bytes. */
    await withDbWrite(
      () =>
        db
          .insert(deviceLogs)
          .values({ mac, seq, lines, byteLen: lines.length })
          .onConflictDoNothing({ target: [deviceLogs.mac, deviceLogs.seq] }),
      "store-device-log-batch"
    );

    /* Housekeeping must never withhold the acknowledgement. The device drops its
     * bytes only on a 2xx, so a pruning failure that reached the caller would make
     * it retry a batch that is already stored, for as long as the failure lasts. */
    prune(mac).catch((error: unknown) =>
      log.warn("Unable to prune device log history", {
        mac,
        errorType: error instanceof Error ? error.name : "unknown",
      })
    );

    return Response.json(okResponse({ seq }));
  } catch (error) {
    log.error("Unable to store device log batch", {
      mac,
      seq,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    return Response.json(errorResponse("Unable to store log batch"), { status: 500 });
  }
}
