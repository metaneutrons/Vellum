// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { readDeviceRequest } from "@/lib/device-request";
import { db, withDbWrite } from "@/db";
import { reports } from "@/db/schema";
import { reportRequestSchema } from "@/lib/validation";
import { okResponse, errorResponse } from "@/lib/api-response";
import { extractTelemetry, logTelemetry } from "@/lib/telemetry";
import { log } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const parsed = await readDeviceRequest(request, reportRequestSchema);
  if (!parsed.ok) return parsed.response;

  try {
    await withDbWrite(
      () =>
        db.insert(reports).values({
          mac: parsed.data.mac,
          issue: parsed.data.issue,
          timestamp: new Date(),
        }),
      "insert-report"
    );

    const t = extractTelemetry(request.headers);
    if (t)
      logTelemetry({ ...t, mac: parsed.data.mac, timestamp: new Date() }).catch((error) =>
        log.warn("Report telemetry persistence failed", {
          mac: parsed.data.mac,
          error: String(error),
        })
      );

    return Response.json(okResponse({}));
  } catch (err) {
    log.error("report insert failed", { mac: parsed.data.mac, error: String(err) });
    return Response.json(errorResponse("Internal server error"), { status: 500 });
  }
}
