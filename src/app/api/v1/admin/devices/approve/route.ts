// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { z } from "zod";
import { validateRequest, okResponse, errorResponse } from "@/lib/api-response";
import { approveDevice } from "@/lib/auth";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { helloLimiter, getClientIp, applyRateLimit } from "@/lib/rate-limit";
import { macSchema } from "@/lib/validation";
import { constantTimeEqual } from "@/lib/constant-time";

const approveSchema = z.object({
  mac: macSchema,
});

function validateApiKey(request: NextRequest): boolean {
  const key = request.headers.get("x-api-key") ?? "";
  if (!key) return false;
  return constantTimeEqual(env.ADMIN_API_KEY, key);
}

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(helloLimiter, getClientIp(request));
  if (rateLimited) return rateLimited;

  if (!validateApiKey(request)) {
    return Response.json(errorResponse("Unauthorized"), { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(errorResponse("Invalid JSON body"), { status: 400 });
  }

  const validation = validateRequest(approveSchema, body);
  if (!validation.success) return validation.response;

  try {
    await approveDevice(validation.data.mac);
    log.info("Device approved", { mac: validation.data.mac });
    return Response.json(okResponse({ approved: true }));
  } catch (err) {
    log.error("Device approval failed", { mac: validation.data.mac, error: String(err) });
    return Response.json(errorResponse("Internal server error"), { status: 500 });
  }
}
