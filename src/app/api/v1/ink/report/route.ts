import { NextRequest } from "next/server";
import { db } from "@/db";
import { reports } from "@/db/schema";
import { reportRequestSchema } from "@/lib/validation";
import { validateRequest, okResponse, errorResponse } from "@/lib/api-response";
import { validateToken } from "@/lib/auth";
import { apiLimiter, getClientIp, applyRateLimit } from "@/lib/rate-limit";
import { log } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(apiLimiter, getClientIp(request));
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(errorResponse("Invalid JSON body"), { status: 400 });
  }

  const validation = validateRequest(reportRequestSchema, body);
  if (!validation.success) {
    return validation.response;
  }

  const token = request.headers.get("x-device-token") ?? "";
  const isValid = await validateToken(validation.data.mac, token);
  if (!isValid) {
    return Response.json(errorResponse("Unauthorized"), { status: 401 });
  }

  try {
    await db.insert(reports).values({
      mac: validation.data.mac,
      issue: validation.data.issue,
      timestamp: new Date(),
    });
    return Response.json(okResponse({}));
  } catch (err) {
    log.error("report insert failed", { mac: validation.data.mac, error: String(err) });
    return Response.json(errorResponse("Internal server error"), { status: 500 });
  }
}
