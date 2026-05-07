// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Door-sign-multi renderer — multi-resource name plate.
 *
 * Renders a header area (free TextBoxes) plus one row per resource,
 * each using the same row template with resource-specific data.
 */

import { createCanvas } from "@napi-rs/canvas";
import { TZDate } from "@date-fns/tz";
import { getCalendarProvider } from "@/lib/calendar/registry";
import { getProviderWithCredentials } from "@/lib/providers";
import { TtlCache } from "@/lib/cache";
import type { CalendarEvent } from "@/lib/calendar/types";
import type { ContentRenderer, RenderParams, RenderResult } from "../types";
import { doorSignMultiConfigSchema, type DoorSignMultiConfig, type ResourceEntry } from "./door-sign-multi-types";
import { renderTextBoxes, selectDesign, formatTime, drawBackground, type TemplateContext } from "./shared";

/* ── Booking cache ────────────────────────────────────────────── */

const BOOKING_CACHE_TTL_MS = 60_000;
const bookingCache = new TtlCache<CalendarEvent[]>(BOOKING_CACHE_TTL_MS);

async function fetchEventsForResource(resource: ResourceEntry, timezone: string, now: Date): Promise<CalendarEvent[]> {
  const cacheKey = `door-sign-multi:${resource.providerId}:${resource.resourceId}`;
  const cached = bookingCache.get(cacheKey);
  if (cached) return cached;

  const provider = await getProviderWithCredentials(resource.providerId);
  const impl = getCalendarProvider(provider.type);
  if (!impl) return [];

  const tzNow = new TZDate(now, timezone);
  const dayStart = new TZDate(tzNow.getFullYear(), tzNow.getMonth(), tzNow.getDate(), 0, 0, 0, timezone);
  const dayEnd = new TZDate(tzNow.getFullYear(), tzNow.getMonth(), tzNow.getDate() + 1, 0, 0, 0, timezone);

  const events = await impl.fetchEvents({
    credentials: provider.credentials,
    roomConfig: { resourceId: resource.resourceId, resourceName: resource.resourceName },
    windowStart: dayStart,
    windowEnd: dayEnd,
  });

  bookingCache.set(cacheKey, events);
  return events;
}

/* ── Renderer ─────────────────────────────────────────────────── */

export const doorSignMultiRenderer: ContentRenderer = {
  slug: "door-sign-multi",
  name: "Türschild (Multi)",
  configSchema: doorSignMultiConfigSchema,

  async render(params: RenderParams): Promise<RenderResult> {
    const config = doorSignMultiConfigSchema.parse(params.config);
    const { width, height } = params.display;
    const design = selectDesign(config, width, height);
    const { headerHeight, rowTemplate, resources } = config;

    const canvas = createCanvas(width, height);
    const c = canvas.getContext("2d");
    await drawBackground(c, design, width, height);

    // Render header TextBoxes (positions relative to full canvas, but within header area)
    const headerCtx: TemplateContext = {
      resource_count: String(resources.length),
    };
    renderTextBoxes(c, design.textBoxes, headerCtx, width, height);

    // Render resource rows in the remaining space below header
    const rowAreaTop = Math.round(headerHeight * height);
    const rowAreaHeight = height - rowAreaTop;
    const rowH = Math.round(rowAreaHeight / resources.length);

    const allEvents = await Promise.all(
      resources.map(r => fetchEventsForResource(r, config.timezone, params.now))
    );

    for (let i = 0; i < resources.length; i++) {
      const resource = resources[i];
      const events = allEvents[i];
      const currentEvent = events.find(e => params.now >= e.startTime && params.now < e.endTime) ?? null;
      const isOccupied = currentEvent !== null;

      const rowY = rowAreaTop + i * rowH;

      // Build context for this resource
      const ctx: TemplateContext = {
        resource_name: resource.resourceName ?? "",
        status: isOccupied ? "Belegt" : "Frei",
        ...(config.cachedProperties[resource.resourceId] ?? {}),
      };

      if (currentEvent) {
        ctx.full_name = currentEvent.organizer;
        ctx.booking_description = currentEvent.subject;
        ctx.start = formatTime(currentEvent.startTime, config.locale, config.timezone);
        ctx.end = formatTime(currentEvent.endTime, config.locale, config.timezone);
      }

      // Render row template TextBoxes — positions are relative to the row
      const boxes = isOccupied
        ? rowTemplate.textBoxes
        : (rowTemplate.freeTextBoxes.length > 0 ? rowTemplate.freeTextBoxes : rowTemplate.textBoxes);

      // Transform box positions from row-relative (0-1) to absolute pixels
      for (const box of boxes) {
        const text = resolveTemplate(box.template, ctx);
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
      if (i < resources.length - 1) {
        c.strokeStyle = design.backgroundColor === "#FFFFFF" ? "#E0E0E0" : "#444444";
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(width * 0.05, rowY + rowH);
        c.lineTo(width * 0.95, rowY + rowH);
        c.stroke();
      }
    }

    return { canvas };
  },
};

// Inline resolveTemplate for row rendering (avoids re-import complexity)
function resolveTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => ctx[key] ?? "")
    .replace(/\s{2,}/g, " ").trim();
}
