// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, withDbRead, withDbWrite } from "@/db";
import { devices, contentInstances, themes, refreshProfiles } from "@/db/schema";
import { renderQuerySchema } from "@/lib/validation";
import { validateRequest, errorResponse } from "@/lib/api-response";
import { validateToken } from "@/lib/auth";
import { extractTelemetry, logTelemetry } from "@/lib/telemetry";
import { canvasToPixelBuffer } from "@/lib/render";
import { computeSleep, parseRefreshProfile, applyJitter, type RefreshProfile } from "@/lib/sleep";
import { apiLimiter, getClientIp, applyRateLimit } from "@/lib/rate-limit";
import { log } from "@/lib/logger";
import { resolveDisplayCaps } from "@/lib/display";
import { getContentRenderer } from "@/lib/content";
import { resolveTheme, parseTheme, snapThemeToPalette, type Theme } from "@/lib/theme";

/**
 * Resolve the refresh profile for a device: its own assignment, else the profile
 * an operator designated as the default, else null (which computeSleep turns into
 * the built-in constants).
 *
 * Mirrors how the theme is resolved further down this file. The middle step is
 * new: the device picker has always offered a "Default" option, but it resolved
 * straight to hard-coded constants, so nobody could see or change it.
 */
async function resolveRefreshProfile(refreshProfileId: string | null) {
  if (refreshProfileId) {
    const [rp] = await withDbRead(() => db.select().from(refreshProfiles)
      .where(eq(refreshProfiles.id, refreshProfileId)).limit(1), "render-get-refresh-profile");
    if (rp) return parseRefreshProfile(rp.config);
  }
  const [fallback] = await withDbRead(() => db.select().from(refreshProfiles)
    .where(eq(refreshProfiles.isDefault, true)).limit(1), "render-get-default-refresh-profile");
  return fallback ? parseRefreshProfile(fallback.config) : null;
}

/**
 * The cadence headers every response carries — including 204 and 304, which are
 * the states a device spends most of its life in. Shared so a new response path
 * cannot silently omit them: a 204 without X-Sleep-Duration sent displays back to
 * their 900s firmware fallback, ignoring the profile entirely.
 */
function sleepHeaders(
  durationS: number,
  mode: string,
  profile: RefreshProfile | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Sleep-Duration": String(Math.round(applyJitter(durationS))),
    "X-Sleep-Mode": mode,
  };
  // Omitted when the profile defines no ladder; the device then keeps its normal
  // cadence on failure. See errorBackoffS in @/lib/sleep.
  const ladder = profile?.errorBackoffS ?? [];
  if (ladder.length > 0) headers["X-Error-Backoff"] = ladder.join(",");
  return headers;
}

/**
 * Record the cadence just handed to this device so the admin UI can judge
 * connectivity against its own schedule (src/lib/connectivity.ts) rather than a
 * fixed window. Only writes on change — skips a round-trip on the steady-state
 * render path — and is non-fatal.
 */
async function recordExpectedInterval(mac: string, current: number | null, durationS: number) {
  const rounded = Math.round(durationS);
  if (current === rounded) return;
  await withDbWrite(
    () => db.update(devices).set({ expectedIntervalS: rounded }).where(eq(devices.mac, mac)),
    "render-update-expected-interval",
  ).catch((err) => log.warn("expectedIntervalS update failed", { mac, error: String(err) }));
}

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

  // Telemetry (best-effort, fire-and-forget — keep it off the render hot path)
  const telemetryData = extractTelemetry(request.headers);
  if (telemetryData) {
    void logTelemetry({ ...telemetryData, mac: validation.data.mac, timestamp: new Date() }).catch(
      (err) => log.warn("Telemetry logging failed", { mac: validation.data.mac, error: String(err) }),
    );
  }

  // Fetch device with content instance and theme
  const [device] = await withDbRead(() => db
    .select()
    .from(devices)
    .where(eq(devices.mac, validation.data.mac))
    .limit(1), "render-get-device");

  if (!device) {
    return Response.json(errorResponse("Device not found"), { status: 404 });
  }

  /* Battery voltage is the cell voltage (max ~4.2 V), never USB VBUS. The old
   * >4.5 V heuristic therefore classified every real display as battery-powered.
   * New firmware reports the hardware-detected source explicitly; legacy
   * firmware falls back conservatively to battery behavior. */
  const powerSource = telemetryData?.powerSource ?? "battery";
  const profile = await resolveRefreshProfile(device.refreshProfileId);

  if (!device.contentInstanceId) {
    /* Enrolled, healthy, nothing assigned yet — the commissioning state. This used
     * to return bare, so the device fell back to its 900s firmware default and an
     * operator assigning content could wait a quarter of an hour to see it. The
     * profile's unassignedIntervalS caps it instead. */
    const idle = computeSleep({
      powerSource,
      batteryLevel: telemetryData?.batteryLevel ?? 100,
      nextEventStart: null,
      now: new Date(),
      profile,
      hasContent: false,
    });
    await recordExpectedInterval(validation.data.mac, device.expectedIntervalS, idle.durationS);
    return new Response(null, {
      status: 204,
      headers: sleepHeaders(idle.durationS, idle.mode, profile),
    });
  }

  // Load content instance
  const contentInstanceId = device.contentInstanceId;
  const [instance] = await withDbRead(() => db
    .select()
    .from(contentInstances)
    .where(eq(contentInstances.id, contentInstanceId))
    .limit(1), "render-get-content-instance");

  if (!instance) {
    return Response.json(errorResponse("Content instance not found"), { status: 404 });
  }

  // Resolve renderer
  const renderer = getContentRenderer(instance.typeSlug);
  if (!renderer) {
    return Response.json(errorResponse(`No renderer for type: ${instance.typeSlug}`), { status: 500 });
  }

  // Resolve display capabilities
  const display = resolveDisplayCaps(device.displayCaps, device.orientationOverride as "portrait" | "landscape" | undefined);

  // Resolve theme: device-specific → DB default → hardcoded fallback
  let theme: Theme = resolveTheme(display.colorCount);
  if (device.themeId) {
    const themeId = device.themeId;
    const [dbTheme] = await withDbRead(() => db
      .select()
      .from(themes)
      .where(eq(themes.id, themeId))
      .limit(1), "render-get-device-theme");
    const parsed = parseTheme(dbTheme?.config);
    if (parsed) theme = parsed;
  } else {
    const [defaultTheme] = await withDbRead(() => db
      .select()
      .from(themes)
      .where(eq(themes.isDefault, true))
      .limit(1), "render-get-default-theme");
    const parsed = parseTheme(defaultTheme?.config);
    if (parsed) theme = parsed;
  }

  // Snap theme colors to display palette — ensures exact color matches, no dithering artifacts
  theme = snapThemeToPalette(theme, display.palette);

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

  const pixelBuffer = canvasToPixelBuffer(
    renderResult.canvas,
    display.palette,
    display.format,
    display.colorMode,
    display.reservedPaletteIndices,
  );
  log.info("Render output", { mac: validation.data.mac, format: display.format, colorMode: display.colorMode, canvasW: renderResult.canvas.width, canvasH: renderResult.canvas.height, bufferSize: pixelBuffer.length });

  // Sleep duration. powerSource and profile were resolved before the no-content
  // check above; only the renderer's own override needs the finished render.
  const { durationS: sleepDuration, mode: sleepMode } = computeSleep({
    powerSource,
    batteryLevel: telemetryData?.batteryLevel ?? 100,
    nextEventStart: null,
    now,
    profile,
    rendererOverrideS: renderResult.sleepOverrideS ?? null,
  });

  await recordExpectedInterval(validation.data.mac, device.expectedIntervalS, sleepDuration);

  // Compute content hash for client-side caching (skip refresh if unchanged)
  const { createHash } = await import("crypto");
  const contentHash = createHash("sha256").update(new Uint8Array(pixelBuffer)).digest("hex").slice(0, 16);

  // Check If-None-Match — device sends last hash, skip render if unchanged
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch === contentHash) {
    return new Response(null, {
      status: 304,
      headers: sleepHeaders(sleepDuration, sleepMode, profile),
    });
  }

  return new Response(new Uint8Array(pixelBuffer), {
    status: 200,
    headers: {
      "Content-Type": display.format === "jpeg" ? "image/jpeg" : (display.colorMode === "fullcolor" ? "image/png" : "application/octet-stream"),
      ...sleepHeaders(sleepDuration, sleepMode, profile),
      "ETag": contentHash,
    },
  });
}
