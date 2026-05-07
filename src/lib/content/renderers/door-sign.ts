// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Door-sign content renderer — configurable name plate for a single room/desk.
 */

import { createCanvas } from "@napi-rs/canvas";
import { TZDate } from "@date-fns/tz";
import { getCalendarProvider } from "@/lib/calendar/registry";
import { getProviderWithCredentials } from "@/lib/providers";
import { TtlCache } from "@/lib/cache";
import type { CalendarEvent } from "@/lib/calendar/types";
import type { ContentRenderer, RenderParams, RenderResult } from "../types";
import { doorSignConfigSchema, type DoorSignConfig } from "./door-sign-types";
import { resolveTemplate, renderTextBoxes, selectDesign, formatTime, drawBackground, type TemplateContext } from "./shared";

/* ── Booking cache ────────────────────────────────────────────── */

const BOOKING_CACHE_TTL_MS = 60_000;
const bookingCache = new TtlCache<CalendarEvent[]>(BOOKING_CACHE_TTL_MS);

async function fetchCurrentBooking(config: DoorSignConfig, now: Date): Promise<CalendarEvent | null> {
  const cacheKey = `door-sign:${config.providerId}:${config.resourceId}`;
  const cached = bookingCache.get(cacheKey);
  const events = cached ?? await fetchEventsFromProvider(config, now);
  if (!cached) bookingCache.set(cacheKey, events);
  return events.find(e => now >= e.startTime && now < e.endTime) ?? null;
}

async function fetchEventsFromProvider(config: DoorSignConfig, now: Date): Promise<CalendarEvent[]> {
  const provider = await getProviderWithCredentials(config.providerId);
  const impl = getCalendarProvider(provider.type);
  if (!impl) throw new Error(`No implementation for provider type: ${provider.type}`);

  const tzNow = new TZDate(now, config.timezone);
  const dayStart = new TZDate(tzNow.getFullYear(), tzNow.getMonth(), tzNow.getDate(), 0, 0, 0, config.timezone);
  const dayEnd = new TZDate(tzNow.getFullYear(), tzNow.getMonth(), tzNow.getDate() + 1, 0, 0, 0, config.timezone);

  return impl.fetchEvents({
    credentials: provider.credentials,
    roomConfig: { resourceId: config.resourceId, resourceName: config.resourceName },
    windowStart: dayStart,
    windowEnd: dayEnd,
  });
}

/* ── Renderer ─────────────────────────────────────────────────── */

export const doorSignRenderer: ContentRenderer = {
  slug: "door-sign",
  name: "Türschild",
  configSchema: doorSignConfigSchema,

  async render(params: RenderParams): Promise<RenderResult> {
    const config = doorSignConfigSchema.parse(params.config);
    const { width, height } = params.display;
    const design = selectDesign(config, width, height);

    const event = await fetchCurrentBooking(config, params.now);
    const isOccupied = event !== null;

    const ctx: TemplateContext = {
      resource_name: config.resourceName ?? "",
      ...config.cachedProperties,
    };

    if (event) {
      ctx.full_name = event.organizer;
      ctx.booking_description = event.subject;
      ctx.start = formatTime(event.startTime, config.locale, config.timezone);
      ctx.end = formatTime(event.endTime, config.locale, config.timezone);
      ctx.date = event.startTime.toLocaleDateString(config.locale, {
        weekday: "short", day: "numeric", month: "short", timeZone: config.timezone,
      });
    }

    const canvas = createCanvas(width, height);
    const c = canvas.getContext("2d");
    await drawBackground(c, design, width, height);

    const boxes = isOccupied
      ? design.textBoxes
      : (design.freeTextBoxes.length > 0 ? design.freeTextBoxes : design.textBoxes);
    renderTextBoxes(c, boxes, ctx, width, height);

    return { canvas };
  },
};

// Re-export shared utilities for use by other renderers
export { resolveTemplate, renderTextBoxes, selectDesign, formatTime, drawBackground } from "./shared";
