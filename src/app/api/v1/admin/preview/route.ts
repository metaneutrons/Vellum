// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db, withDbRead } from "@/db";
import { contentInstances, devices, sites, themes } from "@/db/schema";
import { getContentRenderer, renderContent } from "@/lib/content";
import { resolveTheme, parseTheme, snapThemeToPalette } from "@/lib/theme";
import { previewImage } from "@/lib/render";
import { resolveDisplayCaps, DISPLAY_REGISTRY, type ResolvedDisplay } from "@/lib/display";
import { requestHasPermission } from "@/lib/access";

const _defaultModel = DISPLAY_REGISTRY.e1002;
const _defaultReserved = _defaultModel.reservedPaletteIndices ?? [];
const DEFAULT_PREVIEW_DISPLAY: ResolvedDisplay = {
  width: _defaultModel.width,
  height: _defaultModel.height,
  palette: _defaultModel.palette,
  // Reserved positions are pixel codes, not colors: a preview that used them
  // would show the operator a color the panel cannot print.
  reservedPaletteIndices: _defaultReserved,
  format: _defaultModel.format,
  colorMode: _defaultModel.colorMode,
  colorCount: _defaultModel.palette.length - _defaultReserved.length,
  orientation: "landscape",
};

export async function GET(request: NextRequest) {
  if (!(await requestHasPermission(request, "content.read")))
    return new Response("Forbidden", { status: 403 });
  const instanceId = request.nextUrl.searchParams.get("instanceId");
  const themeId = request.nextUrl.searchParams.get("themeId");
  if (!instanceId) return new Response("Missing instanceId", { status: 400 });

  const [instance] = await withDbRead(
    () => db.select().from(contentInstances).where(eq(contentInstances.id, instanceId)).limit(1),
    "preview-get-content-instance"
  );
  if (!instance) return new Response("Not found", { status: 404 });

  const renderer = getContentRenderer(instance.typeSlug);
  if (!renderer) return new Response("No renderer", { status: 500 });

  /* Which display does this preview stand for?
   *
   * An explicit `mac` wins. Otherwise the instance is looked up across BOTH ways a
   * device can come to show it: assigned directly, or inherited from its site. The
   * old query read `devices.contentInstanceId` alone, so a display that got its
   * content through a site was invisible here and the preview silently fell back
   * to a panel nobody owns.
   *
   * The ordering is the second half of the fix. `.limit(1)` with no ORDER BY meant
   * Postgres chose; on the development estate it chose a test device with a
   * different panel AND a different orientation than the one on the wall, so the
   * preview was rendered for a display that does not exist in the room. Approved
   * and recently seen first, then the address, so the answer is both sensible and
   * the same on every request.
   */
  const mac = request.nextUrl.searchParams.get("mac");
  const [device] = await withDbRead(
    () =>
      db
        .select({
          mac: devices.mac,
          displayCaps: devices.displayCaps,
          orientationOverride: devices.orientationOverride,
        })
        .from(devices)
        .leftJoin(sites, eq(devices.siteId, sites.id))
        .where(
          mac
            ? eq(devices.mac, mac)
            : or(
                eq(devices.contentInstanceId, instanceId),
                and(isNull(devices.contentInstanceId), eq(sites.contentInstanceId, instanceId))
              )
        )
        .orderBy(
          sql`case when ${devices.status} = 'approved' then 0 else 1 end`,
          sql`${devices.lastSeen} desc nulls last`,
          devices.mac
        )
        .limit(1),
    "preview-resolve-device"
  );

  let display: ResolvedDisplay = DEFAULT_PREVIEW_DISPLAY;
  if (device?.displayCaps) {
    display = resolveDisplayCaps(
      device.displayCaps,
      device.orientationOverride as "portrait" | "landscape" | undefined
    );
  }

  /* Theme resolution, mirroring the render route step for step: an explicit theme,
   * else the one an operator designated as the default, else the built-in. Only
   * the first of the three was here, so designating a default made every preview
   * show a theme no device uses. The query parameter stays, because the theme
   * editor's live preview is exactly the case for overriding. */
  let theme = resolveTheme(display.colorCount);
  const [themeRow] = await withDbRead(
    () =>
      themeId
        ? db.select().from(themes).where(eq(themes.id, themeId)).limit(1)
        : db.select().from(themes).where(eq(themes.isDefault, true)).limit(1),
    "preview-resolve-theme"
  );
  const parsedTheme = parseTheme(themeRow?.config);
  if (parsedTheme) theme = parsedTheme;

  /* Same snap as the render route: a theme colour the panel cannot produce is
   * resolved to one it can, so the renderers get exact palette entries rather than
   * values the quantiser will move underneath them. */
  theme = snapThemeToPalette(theme, display.palette);

  const result = await renderContent(renderer, {
    config: instance.config,
    theme,
    display,
    now: new Date(),
  });

  /* The panel's own pixels, not the renderer's. Quantising here is what makes this
   * a preview of the DISPLAY rather than of the drawing: on a six-colour or a
   * two-colour panel those are different pictures, and the difference is where the
   * interesting defects live. */
  const image = previewImage(
    result.canvas,
    display.palette,
    display.format,
    display.colorMode,
    display.reservedPaletteIndices
  );

  return new Response(new Uint8Array(image.body), {
    headers: {
      "Content-Type": image.contentType,
      /* Which display this preview stands for. An <img> cannot read a header, so
       * this is for the operator debugging a mismatch and for whoever writes the
       * caption into the UI next. */
      "X-Preview-Panel": `${display.width}x${display.height} ${display.colorMode}${
        device?.mac ? ` (${device.mac})` : " (no device)"
      }`,
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}
