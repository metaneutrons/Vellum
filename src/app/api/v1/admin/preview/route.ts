// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { contentInstances, devices, themes } from "@/db/schema";
import { getContentRenderer } from "@/lib/content";
import { resolveTheme, parseTheme } from "@/lib/theme";
import { resolveDisplayCaps, type ResolvedDisplay } from "@/lib/display";

const DEFAULT_PREVIEW_DISPLAY: ResolvedDisplay = {
  width: 800, height: 480,
  palette: [[0,0,0],[255,255,255],[0,128,0],[0,0,255],[255,0,0],[255,255,0],[255,128,0]],
  format: "raw",
  colorMode: "fullcolor",
  colorCount: 7,
  orientation: "landscape",
};

export async function GET(request: NextRequest) {
  const instanceId = request.nextUrl.searchParams.get("instanceId");
  const themeId = request.nextUrl.searchParams.get("themeId");
  if (!instanceId) return new Response("Missing instanceId", { status: 400 });

  const [instance] = await db.select().from(contentInstances).where(eq(contentInstances.id, instanceId)).limit(1);
  if (!instance) return new Response("Not found", { status: 404 });

  const renderer = getContentRenderer(instance.typeSlug);
  if (!renderer) return new Response("No renderer", { status: 500 });

  // Find device display caps — prefer explicit mac, fall back to any device using this content
  let display: ResolvedDisplay = DEFAULT_PREVIEW_DISPLAY;
  const mac = request.nextUrl.searchParams.get("mac");
  if (mac) {
    const [device] = await db.select({ displayCaps: devices.displayCaps, orientationOverride: devices.orientationOverride })
      .from(devices).where(eq(devices.mac, mac)).limit(1);
    if (device?.displayCaps) {
      display = resolveDisplayCaps(device.displayCaps, device.orientationOverride as "portrait" | "landscape" | undefined);
    }
  } else {
    const [device] = await db.select({ displayCaps: devices.displayCaps, orientationOverride: devices.orientationOverride })
      .from(devices).where(eq(devices.contentInstanceId, instanceId)).limit(1);
    if (device?.displayCaps) {
      display = resolveDisplayCaps(device.displayCaps, device.orientationOverride as "portrait" | "landscape" | undefined);
    }
  }

  let theme = resolveTheme(display.colorCount);
  if (themeId) {
    const [dbTheme] = await db.select().from(themes).where(eq(themes.id, themeId)).limit(1);
    const parsed = parseTheme(dbTheme?.config);
    if (parsed) theme = parsed;
  }

  const result = await renderer.render({
    config: instance.config,
    theme,
    display,
    now: new Date(),
  });

  const png = result.canvas.toBuffer("image/png");
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } });
}
