// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { readDeviceRequest } from "@/lib/device-request";
import { db, withDbWrite } from "@/db";
import { otaEvents } from "@/db/schema";
import { otaReportSchema } from "@/lib/validation";
import { okResponse, errorResponse } from "@/lib/api-response";
import { log } from "@/lib/logger";

/**
 * Device OTA outcome report. The firmware posts one per phase transition of an
 * update (downloading → verify_ok/verify_fail → applied → boot_confirmed /
 * rolled_back). These power the rollout dashboard and, crucially, the
 * per-device failure blocklist that breaks the brick-retry loop.
 */
export async function POST(request: NextRequest) {
  const parsed = await readDeviceRequest(request, otaReportSchema);
  if (!parsed.ok) return parsed.response;

  try {
    await withDbWrite(
      () =>
        db.insert(otaEvents).values({
          mac: parsed.data.mac,
          model: parsed.data.model ?? null,
          fromVersion: parsed.data.fromVersion ?? null,
          toVersion: parsed.data.toVersion ?? null,
          phase: parsed.data.phase,
          errorCode: parsed.data.errorCode ?? null,
          timestamp: new Date(),
        }),
      "insert-ota-event"
    );
    return Response.json(okResponse({}));
  } catch (err) {
    log.error("ota-report insert failed", {
      mac: parsed.data.mac,
      error: String(err),
    });
    return Response.json(errorResponse("Internal server error"), { status: 500 });
  }
}
