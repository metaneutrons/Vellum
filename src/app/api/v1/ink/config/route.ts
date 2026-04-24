import { NextRequest } from "next/server";
import { renderQuerySchema } from "@/lib/validation";
import { validateRequest, okResponse, errorResponse } from "@/lib/api-response";
import { validateToken } from "@/lib/auth";
import { apiLimiter, getClientIp, applyRateLimit } from "@/lib/rate-limit";

export async function GET(request: NextRequest) {
  const rateLimited = applyRateLimit(apiLimiter, getClientIp(request));
  if (rateLimited) return rateLimited;
  const mac = request.nextUrl.searchParams.get("mac");
  const validation = validateRequest(renderQuerySchema, { mac });
  if (!validation.success) {
    return validation.response;
  }

  const token = request.headers.get("x-device-token") ?? "";
  const isValid = await validateToken(validation.data.mac, token);
  if (!isValid) {
    return Response.json(errorResponse("Unauthorized"), { status: 401 });
  }

  return Response.json(
    okResponse({
      otaUrl: null,
      rotation: 0,
    })
  );
}
