import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { renderQuerySchema } from "@/lib/validation";
import { validateRequest, okResponse, errorResponse } from "@/lib/api-response";
import { validateToken } from "@/lib/auth";
import { apiLimiter, getClientIp, applyRateLimit } from "@/lib/rate-limit";
import { resolveOta, type FirmwareChannel } from "@/lib/firmware";
import { extractTelemetry, logTelemetry } from "@/lib/telemetry";

export async function GET(request: NextRequest) {
  const rateLimited = applyRateLimit(apiLimiter, getClientIp(request));
  if (rateLimited) return rateLimited;

  const mac = request.nextUrl.searchParams.get("mac");
  const validation = validateRequest(renderQuerySchema, { mac });
  if (!validation.success) return validation.response;

  const token = request.headers.get("x-device-token") ?? "";
  const isValid = await validateToken(validation.data.mac, token);
  if (!isValid) {
    return Response.json(errorResponse("Unauthorized"), { status: 401 });
  }

  // Load device for channel + pin info
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.mac, validation.data.mac))
    .limit(1);

  // Resolve OTA update
  const firmwareVer = request.headers.get("x-firmware-ver") ?? "0.0.0";
  const displayModel = (device?.displayCaps as { model?: string })?.model ?? "unknown";

  const ota = await resolveOta(
    firmwareVer,
    displayModel,
    (device?.firmwareChannel as FirmwareChannel) ?? "stable",
    device?.firmwarePinVersion ?? null
  );

  const t = extractTelemetry(request.headers);
  if (t) logTelemetry({ ...t, mac: validation.data.mac, timestamp: new Date() }).catch(() => {});

  return Response.json(
    okResponse({
      ...ota,
      rotation: 0,
    })
  );
}
