// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, withDbRead, withDbWrite } from "@/db";
import { devices } from "@/db/schema";
import { renderQuerySchema } from "@/lib/validation";
import { validateRequest, okResponse, errorResponse } from "@/lib/api-response";
import { validateToken } from "@/lib/auth";
import { apiLimiter, getClientIp, applyRateLimit } from "@/lib/rate-limit";
import { resolveOta, type FirmwareChannel } from "@/lib/firmware";
import { extractTelemetry, logTelemetry } from "@/lib/telemetry";
import { log } from "@/lib/logger";
import { env } from "@/lib/env";
import { createOtaDownloadUrl } from "@/lib/firmware-download";
import { completeDisplayCaps, displayCapsSchema } from "@/lib/display";

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

  // Load device for channel + pin info — through the resilience layer (circuit
  // breaker + retry) like every other DB access on the hot device path.
  const [device] = await withDbRead(
    () => db.select().from(devices).where(eq(devices.mac, validation.data.mac)).limit(1),
    "config-get-device"
  );

  // Resolve OTA update.
  //
  // The model is taken from the request header first, then from the stored
  // capabilities. Both matter: `/hello` is the only path that persists
  // displayCaps, and a device enrolled through a provisioning voucher is
  // approved with a token immediately — so it never calls `/hello` again and its
  // displayCaps stay NULL. That resolved to "unknown", no manifest entry
  // matched, and the device silently never received an OTA update (observed in
  // the field on a D1001 stuck on an old firmware while rendering normally).
  // The header is sent on this very request, so preferring it makes such a
  // device self-heal on its next poll instead of needing a re-enrolment.
  const firmwareVer = request.headers.get("x-firmware-ver") ?? "0.0.0";
  const headerModel = request.headers.get("x-display-model")?.trim() || null;
  const storedModel = (device?.displayCaps as { model?: string })?.model ?? null;
  const displayModel = headerModel ?? storedModel ?? "unknown";

  // Voucher-enrolled devices can skip /hello entirely. Older self-healing only
  // persisted their model, leaving width/height/format absent forever. Complete
  // any missing/partial record from the central registry on the next ordinary
  // authenticated poll; no re-provisioning or one-off migration is required.
  const storedCapsValid = displayCapsSchema.safeParse(device?.displayCaps).success;
  const completedCaps = headerModel ? completeDisplayCaps(device?.displayCaps, headerModel) : null;
  if (device && completedCaps && (!storedCapsValid || storedModel !== headerModel)) {
    await withDbWrite(
      () =>
        db
          .update(devices)
          .set({ displayCaps: completedCaps })
          .where(eq(devices.mac, validation.data.mac)),
      "config-backfill-display-caps"
    ).catch((error) =>
      log.warn("Failed to persist display capability backfill", {
        mac: validation.data.mac,
        error: String(error),
      })
    );
  }

  const ota = await resolveOta(
    firmwareVer,
    displayModel,
    (device?.firmwareChannel as FirmwareChannel) ?? "stable",
    device?.firmwarePinVersion ?? null,
    validation.data.mac
  );

  // Existing firmware already accepts arbitrary validated HTTPS OTA URLs, so
  // routing through Vellum needs no device-side migration. In local HTTP
  // development, retain the GitHub URL because production firmware correctly
  // refuses plaintext OTA transport.
  const otaOrigin = env.VELLUM_PUBLIC_URL ?? request.nextUrl.origin;
  const otaUrl =
    ota.otaUrl && ota.otaTag && otaOrigin.startsWith("https://")
      ? createOtaDownloadUrl(
          otaOrigin,
          {
            mac: validation.data.mac,
            tag: ota.otaTag,
            model: displayModel,
          },
          token
        )
      : ota.otaUrl;
  const { otaTag: _otaTag, ...publicOta } = ota;

  const t = extractTelemetry(request.headers);
  if (t)
    logTelemetry({ ...t, mac: validation.data.mac, timestamp: new Date() }).catch((error) =>
      log.warn("Config telemetry persistence failed", {
        mac: validation.data.mac,
        error: String(error),
      })
    );

  return Response.json(
    okResponse({
      ...publicOta,
      otaUrl,
      rotation: 0,
    })
  );
}
