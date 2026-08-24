// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Door-sign-multi renderer — multi-resource name plate.
 *
 * Renders a header area (free TextBoxes) plus one row per resource,
 * each using the same row template with resource-specific data.
 */

import { canvasSurface } from "@/lib/render/surface";
import { TZDate } from "@date-fns/tz";
import { fetchResourceEvents } from "@/lib/calendar/source";
import type { CalendarEvent } from "@/lib/calendar/types";
import type { Image } from "@napi-rs/canvas";
import type { ContentRenderer, DrawParams, DrawResult, LoadParams } from "../types";
import {
  doorSignMultiConfigSchema,
  type DoorSignMultiConfig,
  type ResourceEntry,
} from "./door-sign-multi-types";
import {
  renderTextBoxes,
  selectDesign,
  formatTime,
  loadBackgroundImage,
  paintBackground,
  type TemplateContext,
} from "./shared";

/* ── Booking cache ────────────────────────────────────────────── */

/** One resource's whole day, in the sign's own zone. */
async function fetchEventsForResource(
  resource: ResourceEntry,
  timezone: string,
  now: Date
): Promise<CalendarEvent[]> {
  const tzNow = new TZDate(now, timezone);
  const dayStart = new TZDate(
    tzNow.getFullYear(),
    tzNow.getMonth(),
    tzNow.getDate(),
    0,
    0,
    0,
    timezone
  );
  const dayEnd = new TZDate(
    tzNow.getFullYear(),
    tzNow.getMonth(),
    tzNow.getDate() + 1,
    0,
    0,
    0,
    timezone
  );

  /* Never throws: a multi-resource sign with one unreachable row still shows the
   * others, which is what its own caller assumed when it had a cache of its own. */
  return fetchResourceEvents({
    providerId: resource.providerId,
    roomConfig: { resourceId: resource.resourceId, resourceName: resource.resourceName },
    windowStart: dayStart,
    windowEnd: dayEnd,
    ttlS: 60,
  }).catch(() => []);
}

/* ── Renderer ─────────────────────────────────────────────────── */

/**
 * One row of a multi-resource sign, with its bookings already resolved.
 *
 * Everything time-dependent is settled here rather than while painting: which
 * boxes apply, and what goes into them.
 */
interface MultiRow {
  context: TemplateContext;
  occupied: boolean;
}

export interface DoorSignMultiModel {
  config: DoorSignMultiConfig;
  rows: MultiRow[];
  background: Image | null;
}

async function loadMultiModel(params: LoadParams): Promise<DoorSignMultiModel> {
  const config = doorSignMultiConfigSchema.parse(params.config);
  const allEvents = await Promise.all(
    config.resources.map((r) => fetchEventsForResource(r, config.timezone, params.now))
  );

  const rows: MultiRow[] = config.resources.map((resource, i) => {
    const current =
      allEvents[i].find((e) => params.now >= e.startTime && params.now < e.endTime) ?? null;
    const context: TemplateContext = {
      resource_name: resource.resourceName ?? "",
      status: current ? "Belegt" : "Frei",
      ...(config.cachedProperties[resource.resourceId] ?? {}),
    };
    if (current) {
      context.full_name = current.organizer;
      context.booking_description = current.subject;
      context.start = formatTime(current.startTime, config.locale, config.timezone);
      context.end = formatTime(current.endTime, config.locale, config.timezone);
    }
    return { context, occupied: current !== null };
  });

  return { config, rows, background: await loadBackgroundImage(config.design) };
}

export function drawDoorSignMulti(model: DoorSignMultiModel, params: DrawParams): DrawResult {
  const { config, rows } = model;
  const { width, height } = params.display;
  const design = selectDesign(config, width, height);
  const { headerHeight, rowTemplate } = config;

  const { canvas, ctx: c } = (params.surface ?? canvasSurface)(width, height);
  paintBackground(c, design, width, height, model.background);

  // Render header TextBoxes (positions relative to full canvas, but within header area)
  renderTextBoxes(c, design.textBoxes, { resource_count: String(rows.length) }, width, height);

  // Render resource rows in the remaining space below header
  const rowAreaTop = Math.round(headerHeight * height);
  const rowH = Math.round((height - rowAreaTop) / rows.length);

  for (let i = 0; i < rows.length; i++) {
    const { context, occupied } = rows[i];
    const rowY = rowAreaTop + i * rowH;

    // Render row template TextBoxes — positions are relative to the row
    const boxes = occupied
      ? rowTemplate.textBoxes
      : rowTemplate.freeTextBoxes.length > 0
        ? rowTemplate.freeTextBoxes
        : rowTemplate.textBoxes;

    // Transform box positions from row-relative (0-1) to absolute pixels
    for (const box of boxes) {
      const text = resolveTemplate(box.template, context);
      if (!text) continue;

      const px = Math.round(box.x * width);
      const py = rowY + Math.round(box.y * rowH);
      const pw = Math.round(box.w * width);
      const ph = Math.round(box.h * rowH);
      const fs = Math.round(box.fontSize * rowH);

      c.fillStyle = box.color;
      c.font = `${box.bold ? "bold " : ""}${fs}px sans-serif`;
      c.textBaseline = "top";
      c.textAlign = box.align === "center" ? "center" : box.align === "right" ? "right" : "left";

      const tx = box.align === "center" ? px + pw / 2 : box.align === "right" ? px + pw : px;

      // Simple single-line render (rows are compact)
      c.fillText(text, tx, py + (ph - fs) / 2, pw);
    }

    // Draw separator line between rows
    if (i < rows.length - 1) {
      c.strokeStyle = design.backgroundColor === "#FFFFFF" ? "#E0E0E0" : "#444444";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(width * 0.05, rowY + rowH);
      c.lineTo(width * 0.95, rowY + rowH);
      c.stroke();
    }
  }

  return { canvas };
}

export const doorSignMultiRenderer: ContentRenderer<DoorSignMultiModel> = {
  slug: "door-sign-multi",
  /* Retired in favour of `name-plate`, which lays a multi-seat plate out by itself.
   * No instance of this type was ever created. See `docs/door-sign-retirement.md`. */
  deprecated: true,
  name: "Türschild (Multi)",
  configSchema: doorSignMultiConfigSchema,

  load: loadMultiModel,
  draw: drawDoorSignMulti,
};

// Inline resolveTemplate for row rendering (avoids re-import complexity)
function resolveTemplate(template: string, ctx: TemplateContext): string {
  return template
    .replace(/\{([^}]+)\}/g, (_, key: string) => ctx[key] ?? "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
