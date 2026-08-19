// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { and, eq, lt, sql } from "drizzle-orm";
import { db, withDbWrite } from "@/db";
import { deviceLogs } from "@/db/schema";
import { validateToken } from "@/lib/auth";
import { validateRequest, okResponse, errorResponse } from "@/lib/api-response";
import { deviceLogBatchSchema } from "@/lib/validation";
import { apiLimiter, getClientIp, applyRateLimit } from "@/lib/rate-limit";
import { log } from "@/lib/logger";

/** Keep a bounded history per device: enough to read an incident, not a fleet-wide archive. */
const RETAIN_DAYS = 30;
const RETAIN_BATCHES = 50;

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(apiLimiter, getClientIp(request));
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(errorResponse("Invalid JSON body"), { status: 400 });
  }
  const validation = validateRequest(deviceLogBatchSchema, body);
  if (!validation.success) return validation.response;

  const token = request.headers.get("x-device-token") ?? "";
  if (!(await validateToken(validation.data.mac, token))) {
    return Response.json(errorResponse("Unauthorized"), { status: 401 });
  }

  const { mac, seq, lines } = validation.data;
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

    /* Pruned on write rather than by a scheduler: uploads are event-driven and
     * rare, so this runs about as often as it needs to and needs no cron. */
    const cutoff = new Date(Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000);
    await withDbWrite(
      () =>
        db
          .delete(deviceLogs)
          .where(and(eq(deviceLogs.mac, mac), lt(deviceLogs.receivedAt, cutoff))),
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
