import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { devices, contentInstances, themes, refreshProfiles } from "@/db/schema";
import { renderQuerySchema } from "@/lib/validation";
import { validateRequest, errorResponse } from "@/lib/api-response";
import { validateToken } from "@/lib/auth";
import { extractTelemetry, logTelemetry } from "@/lib/telemetry";
import { canvasToPixelBuffer } from "@/lib/render";
import { computeSleepDuration, applyJitter } from "@/lib/sleep";
import { parseRefreshProfile } from "@/lib/sleep";
import { apiLimiter, getClientIp, applyRateLimit } from "@/lib/rate-limit";
import { log } from "@/lib/logger";
import { resolveDisplayCaps } from "@/lib/display";
import { getContentRenderer } from "@/lib/content";
import { resolveTheme, parseTheme, type Theme } from "@/lib/theme";

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

  // Telemetry (best-effort)
  const telemetryData = extractTelemetry(request.headers);
  if (telemetryData) {
    try {
      await logTelemetry({ ...telemetryData, mac: validation.data.mac, timestamp: new Date() });
    } catch (err) {
      log.warn("Telemetry logging failed", { mac: validation.data.mac, error: String(err) });
    }
  }

  // Fetch device with content instance and theme
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.mac, validation.data.mac))
    .limit(1);

  if (!device) {
    return Response.json(errorResponse("Device not found"), { status: 404 });
  }

  if (!device.contentInstanceId) {
    return new Response(null, { status: 204 });
  }

  // Load content instance
  const [instance] = await db
    .select()
    .from(contentInstances)
    .where(eq(contentInstances.id, device.contentInstanceId))
    .limit(1);

  if (!instance) {
    return Response.json(errorResponse("Content instance not found"), { status: 404 });
  }

  // Resolve renderer
  const renderer = getContentRenderer(instance.typeSlug);
  if (!renderer) {
    return Response.json(errorResponse(`No renderer for type: ${instance.typeSlug}`), { status: 500 });
  }

  // Resolve display capabilities
  const display = resolveDisplayCaps(device.displayCaps);

  // Resolve theme: device-specific → DB default → hardcoded fallback
  let theme: Theme = resolveTheme(display.colorCount);
  if (device.themeId) {
    const [dbTheme] = await db
      .select()
      .from(themes)
      .where(eq(themes.id, device.themeId))
      .limit(1);
    const parsed = parseTheme(dbTheme?.config);
    if (parsed) theme = parsed;
  } else {
    const [defaultTheme] = await db
      .select()
      .from(themes)
      .where(eq(themes.isDefault, true))
      .limit(1);
    const parsed = parseTheme(defaultTheme?.config);
    if (parsed) theme = parsed;
  }

  // Render
  const now = new Date();
  let renderResult;
  try {
    renderResult = await renderer.render({
      config: instance.config,
      theme,
      display,
      now,
    });
  } catch (err) {
    log.error("Render failed", { mac: validation.data.mac, renderer: instance.typeSlug, error: String(err) });
    return Response.json(errorResponse("Render failed"), { status: 500 });
  }

  const pixelBuffer = canvasToPixelBuffer(renderResult.canvas, display.palette, display.quantize);

  // Sleep duration
  const USB_VOLTAGE_THRESHOLD = 4.5;
  const powerSource =
    telemetryData && telemetryData.batteryVoltage > USB_VOLTAGE_THRESHOLD ? "usb" : "battery";

  // Load refresh profile if assigned
  let profile = null;
  if (device.refreshProfileId) {
    const [rp] = await db.select().from(refreshProfiles)
      .where(eq(refreshProfiles.id, device.refreshProfileId)).limit(1);
    if (rp) profile = parseRefreshProfile(rp.config);
  }

  const sleepDuration = computeSleepDuration({
    powerSource,
    batteryLevel: telemetryData?.batteryLevel ?? 100,
    nextEventStart: null,
    now,
    profile,
    rendererOverrideS: renderResult.sleepOverrideS ?? null,
  });

  // Compute content hash for client-side caching (skip refresh if unchanged)
  const { createHash } = await import("crypto");
  const contentHash = createHash("sha256").update(new Uint8Array(pixelBuffer)).digest("hex").slice(0, 16);

  // Check If-None-Match — device sends last hash, skip render if unchanged
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch === contentHash) {
    return new Response(null, {
      status: 304,
      headers: { "X-Sleep-Duration": String(Math.round(applyJitter(sleepDuration))) },
    });
  }

  return new Response(new Uint8Array(pixelBuffer), {
    status: 200,
    headers: {
      "Content-Type": display.quantize === "none" ? "image/png" : "application/octet-stream",
      "X-Sleep-Duration": String(Math.round(applyJitter(sleepDuration))),
      "ETag": contentHash,
    },
  });
}
