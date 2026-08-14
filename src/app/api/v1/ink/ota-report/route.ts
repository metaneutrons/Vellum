// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { db, withDbWrite } from "@/db";
import { otaEvents } from "@/db/schema";
import { otaReportSchema } from "@/lib/validation";
import { validateRequest, okResponse, errorResponse } from "@/lib/api-response";
import { validateToken } from "@/lib/auth";
import { apiLimiter, getClientIp, applyRateLimit } from "@/lib/rate-limit";
import { log } from "@/lib/logger";

/**
 * Device OTA outcome report. The firmware posts one per phase transition of an
 * update (downloading → verify_ok/verify_fail → applied → boot_confirmed /
 * rolled_back). These power the rollout dashboard and, crucially, the
 * per-device failure blocklist that breaks the brick-retry loop.
 */
export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(apiLimiter, getClientIp(request));
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(errorResponse("Invalid JSON body"), { status: 400 });
  }

  const validation = validateRequest(otaReportSchema, body);
  if (!validation.success) {
    return validation.response;
  }

  const token = request.headers.get("x-device-token") ?? "";
  const isValid = await validateToken(validation.data.mac, token);
  if (!isValid) {
    return Response.json(errorResponse("Unauthorized"), { status: 401 });
  }

  try {
    await withDbWrite(
      () =>
        db.insert(otaEvents).values({
          mac: validation.data.mac,
          model: validation.data.model ?? null,
          fromVersion: validation.data.fromVersion ?? null,
          toVersion: validation.data.toVersion ?? null,
          phase: validation.data.phase,
          errorCode: validation.data.errorCode ?? null,
          timestamp: new Date(),
        }),
      "insert-ota-event",
    );
    return Response.json(okResponse({}));
  } catch (err) {
    log.error("ota-report insert failed", {
      mac: validation.data.mac,
      error: String(err),
    });
    return Response.json(errorResponse("Internal server error"), { status: 500 });
  }
}
