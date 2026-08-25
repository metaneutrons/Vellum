// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Door-sign content renderer — configurable name plate for a single room/desk.
 */

import type { Image } from "@napi-rs/canvas";
import { canvasSurface } from "@/lib/render/surface";
import { TZDate } from "@date-fns/tz";
import { fetchResourceEvents } from "@/lib/calendar/source";
import type { CalendarEvent } from "@/lib/calendar/types";
import type { ContentRenderer, DrawParams, DrawResult, LoadParams } from "../types";
import { doorSignConfigSchema, type DoorSignConfig } from "./door-sign-types";
import {
  renderTextBoxes,
  selectDesign,
  formatTime,
  loadBackgroundImage,
  paintBackground,
  type TemplateContext,
} from "./shared";

/* ── Booking cache ────────────────────────────────────────────── */

async function fetchCurrentBooking(
  config: DoorSignConfig,
  now: Date
): Promise<CalendarEvent | null> {
  const events = await fetchEventsFromProvider(config, now);
  return events.find((e) => now >= e.startTime && now < e.endTime) ?? null;
}

/** The whole of the sign's day, in the sign's own zone. */
async function fetchEventsFromProvider(
  config: DoorSignConfig,
  now: Date
): Promise<CalendarEvent[]> {
  const tzNow = new TZDate(now, config.timezone);
  const dayStart = new TZDate(
    tzNow.getFullYear(),
    tzNow.getMonth(),
    tzNow.getDate(),
    0,
    0,
    0,
    config.timezone
  );
  const dayEnd = new TZDate(
    tzNow.getFullYear(),
    tzNow.getMonth(),
    tzNow.getDate() + 1,
    0,
    0,
    0,
    config.timezone
  );

  return fetchResourceEvents({
    providerId: config.providerId,
    roomConfig: { resourceId: config.resourceId, resourceName: config.resourceName },
    windowStart: dayStart,
    windowEnd: dayEnd,
    /* The minute this renderer has always used. Unchanged deliberately: it is
     * retired, and a behaviour change here buys nothing. */
    ttlS: 60,
  });
}

/* ── Renderer ─────────────────────────────────────────────────── */

/**
 * A door sign's frame: which boxes to draw, with what substituted into them.
 *
 * The template context is built by `load` because filling it needs the booking and
 * the clock. `occupied` decides which set of boxes applies, and the background is
 * carried as a decoded image so that painting needs no database.
 */
export interface DoorSignModel {
  config: DoorSignConfig;
  context: TemplateContext;
  occupied: boolean;
  background: Image | null;
}

async function loadDoorSignModel(params: LoadParams): Promise<DoorSignModel> {
  const config = doorSignConfigSchema.parse(params.config);
  const event = await fetchCurrentBooking(config, params.now);

  const context: TemplateContext = {
    resource_name: config.resourceName ?? "",
    ...config.cachedProperties,
  };
  if (event) {
    context.full_name = event.organizer;
    context.booking_description = event.subject;
    context.start = formatTime(event.startTime, config.locale, config.timezone);
    context.end = formatTime(event.endTime, config.locale, config.timezone);
    context.date = event.startTime.toLocaleDateString(config.locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: config.timezone,
    });
  }

  /* Resolved against the DEFAULT design's asset. A per-geometry override may name
   * a different one, which this does not follow; the one live instance overrides
   * only box positions, and the type is on its way out. Recorded rather than
   * fixed. */
  const background = await loadBackgroundImage(config.design);
  return { config, context, occupied: event !== null, background };
}

export function drawDoorSign(model: DoorSignModel, params: DrawParams): DrawResult {
  const { config, context, occupied } = model;
  const { width, height } = params.display;
  const design = selectDesign(config, width, height);

  const { canvas, ctx: c } = (params.surface ?? canvasSurface)(width, height);
  paintBackground(c, design, width, height, model.background);

  const boxes = occupied
    ? design.textBoxes
    : design.freeTextBoxes.length > 0
      ? design.freeTextBoxes
      : design.textBoxes;
  renderTextBoxes(c, boxes, context, width, height);

  return { canvas };
}

export const doorSignRenderer: ContentRenderer<DoorSignModel> = {
  slug: "door-sign",
  /* Retired in favour of `name-plate`, and kept rather than deleted because the
   * free-positioning editor is the obvious starting point for a future free-form
   * sign. See `docs/door-sign-retirement.md`. */
  deprecated: true,
  name: "Türschild",
  configSchema: doorSignConfigSchema,

  load: loadDoorSignModel,
  draw: drawDoorSign,
};

// Re-export shared utilities for use by other renderers
export {
  resolveTemplate,
  renderTextBoxes,
  selectDesign,
  formatTime,
  loadBackgroundImage,
  paintBackground,
} from "./shared";
