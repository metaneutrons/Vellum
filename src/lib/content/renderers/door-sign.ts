// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Door-sign content renderer — configurable name plate for rooms/desks.
 *
 * Provider-agnostic: uses the calendar provider interface to fetch bookings.
 * Background images are cached in memory. Resource properties are cached
 * at config time (stored in content instance config), not fetched per render.
 */

import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assets, dataProviders } from "@/db/schema";
import { decryptCredentials } from "@/lib/encryption";
import { getCalendarProvider } from "@/lib/calendar/registry";
import { TtlCache } from "@/lib/cache";
import { log } from "@/lib/logger";
import type { CalendarEvent } from "@/lib/calendar/types";
import type { ContentRenderer, RenderParams, RenderResult } from "../types";
import { doorSignConfigSchema, type DoorSignConfig, type Design, type TextBox } from "./door-sign-types";

/* ── Caches ───────────────────────────────────────────────────── */

const ASSET_CACHE_TTL_MS = 5 * 60_000; // 5 min
const assetCache = new TtlCache<Buffer>(ASSET_CACHE_TTL_MS);

const BOOKING_CACHE_TTL_MS = 60_000; // 1 min
const bookingCache = new TtlCache<CalendarEvent[]>(BOOKING_CACHE_TTL_MS);

/* ── Template variable resolution ─────────────────────────────── */

interface TemplateContext {
  [key: string]: string | undefined;
}

function resolveTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{([^}]+)\}/g, (_, key: string) => ctx[key] ?? "")
    .replace(/\s{2,}/g, " ").trim();
}

/* ── Fetch current booking via provider interface ─────────────── */

async function fetchCurrentBooking(
  config: DoorSignConfig,
  now: Date,
): Promise<CalendarEvent | null> {
  const cacheKey = `door-sign:${config.providerId}:${config.resourceId}`;
  const cached = bookingCache.get(cacheKey);
  const events = cached ?? await fetchEventsFromProvider(config, now);

  if (!cached) bookingCache.set(cacheKey, events);

  // Find event covering "now"
  return events.find(e => now >= e.startTime && now < e.endTime) ?? null;
}

async function fetchEventsFromProvider(config: DoorSignConfig, now: Date): Promise<CalendarEvent[]> {
  const [provider] = await db.select().from(dataProviders)
    .where(eq(dataProviders.id, config.providerId)).limit(1);
  if (!provider) throw new Error(`Provider ${config.providerId} not found`);

  const impl = getCalendarProvider(provider.type);
  if (!impl) throw new Error(`No implementation for provider type: ${provider.type}`);

  const credentials = decryptCredentials(provider.encryptedCredentials);

  // Window: today (midnight to midnight in configured timezone)
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  return impl.fetchEvents({
    credentials,
    roomConfig: { resourceId: config.resourceId, resourceName: config.resourceName },
    windowStart: dayStart,
    windowEnd: dayEnd,
  });
}

/* ── Load background asset (cached) ──────────────────────────── */

async function loadBackgroundAsset(assetId: string): Promise<Buffer | null> {
  const cached = assetCache.get(assetId);
  if (cached) return cached;

  const [asset] = await db.select({ data: assets.data }).from(assets)
    .where(eq(assets.id, assetId)).limit(1);
  if (!asset) return null;

  assetCache.set(assetId, asset.data);
  return asset.data;
}

/* ── Render ───────────────────────────────────────────────────── */

function selectDesign(config: DoorSignConfig, width: number, height: number): Design {
  return config.designOverrides[`${width}x${height}`] ?? config.design;
}

function formatTime(date: Date, locale: string, timezone: string): string {
  return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", timeZone: timezone });
}

function renderTextBoxes(
  c: CanvasRenderingContext2D,
  boxes: TextBox[],
  ctx: TemplateContext,
  width: number,
  height: number,
): void {
  for (const box of boxes) {
    const text = resolveTemplate(box.template, ctx);
    if (!text) continue;

    const px = Math.round(box.x * width);
    const py = Math.round(box.y * height);
    const pw = Math.round(box.w * width);
    const ph = Math.round(box.h * height);
    const fs = Math.round(box.fontSize * height);

    c.fillStyle = box.color;
    c.font = `${box.bold ? "bold " : ""}${fs}px sans-serif`;
    c.textBaseline = "top";

    if (box.align === "center") { c.textAlign = "center"; }
    else if (box.align === "right") { c.textAlign = "right"; }
    else { c.textAlign = "left"; }

    const tx = box.align === "center" ? px + pw / 2
      : box.align === "right" ? px + pw
      : px;

    // Word wrap
    const words = text.split(" ");
    let line = "";
    let lineY = py;
    const lineHeight = fs * 1.2;

    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (c.measureText(test).width > pw && line) {
        c.fillText(line, tx, lineY);
        line = word;
        lineY += lineHeight;
        if (lineY + fs > py + ph) break;
      } else {
        line = test;
      }
    }
    if (line && lineY + fs <= py + ph) {
      c.fillText(line, tx, lineY);
    }
  }
}

/* ── Renderer export ──────────────────────────────────────────── */

export const doorSignRenderer: ContentRenderer = {
  slug: "door-sign",
  name: "Door Sign (Türschild)",
  configSchema: doorSignConfigSchema,

  async render(params: RenderParams): Promise<RenderResult> {
    const config = doorSignConfigSchema.parse(params.config);
    const { width, height } = params.display;
    const design = selectDesign(config, width, height);

    // Fetch current booking via provider interface
    const event = await fetchCurrentBooking(config, params.now);
    const isOccupied = event !== null;

    // Build template context
    const ctx: TemplateContext = {
      resource_name: config.resourceName ?? "",
      ...config.cachedProperties, // pre-resolved at config time
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

    // Create canvas
    const canvas = createCanvas(width, height);
    const c = canvas.getContext("2d");

    // Background
    if (design.backgroundAssetId) {
      const buf = await loadBackgroundAsset(design.backgroundAssetId);
      if (buf) {
        const img = await loadImage(buf);
        c.drawImage(img, 0, 0, width, height);
      } else {
        c.fillStyle = design.backgroundColor;
        c.fillRect(0, 0, width, height);
      }
    } else {
      c.fillStyle = design.backgroundColor;
      c.fillRect(0, 0, width, height);
    }

    // Render text boxes
    const boxes = isOccupied ? design.textBoxes : design.freeTextBoxes;
    renderTextBoxes(c as unknown as CanvasRenderingContext2D, boxes, ctx, width, height);

    return { canvas };
  },
};
