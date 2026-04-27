// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { helloRequestSchema } from "@/lib/validation";
import { validateRequest, okResponse, errorResponse } from "@/lib/api-response";
import { handleHello } from "@/lib/auth";
import { helloLimiter, getClientIp, applyRateLimit } from "@/lib/rate-limit";
import { extractTelemetry, logTelemetry } from "@/lib/telemetry";
import { log } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(helloLimiter, getClientIp(request));
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(errorResponse("Invalid JSON body"), { status: 400 });
  }

  const validation = validateRequest(helloRequestSchema, body);
  if (!validation.success) {
    return validation.response;
  }

  try {
    const result = await handleHello(
      validation.data.mac,
      validation.data.publicKey ?? null,
      validation.data.display
    );

    const t = extractTelemetry(request.headers);
    if (t) logTelemetry({ ...t, mac: validation.data.mac, timestamp: new Date() }).catch(() => {});

    return Response.json(okResponse(result));
  } catch (err) {
    log.error("hello handler failed", { mac: validation.data.mac, error: String(err) });
    return Response.json(errorResponse("Internal server error"), { status: 500 });
  }
}
