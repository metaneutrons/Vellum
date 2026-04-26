/**
 * Room-booking content renderer — Outlook-style day view.
 *
 * Fetches calendar events via the configured provider,
 * applies room policy, renders to canvas at device resolution.
 */

import { z } from "zod";
import { createCanvas, GlobalFonts, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { format } from "date-fns";
import { TZDate } from "@date-fns/tz";
import { eq } from "drizzle-orm";
import path from "path";
import { db } from "@/db";
import { dataProviders } from "@/db/schema";
import { getCalendarProvider } from "@/lib/calendar/registry";
import { applyRoomPolicy } from "@/lib/calendar/policy";
import { decryptCredentials } from "@/lib/encryption";
import { TtlCache } from "@/lib/cache";
import { log } from "@/lib/logger";
import { drawBitmapText, measureBitmapText, type BitmapFontSize } from "@/lib/render/bitmap-text";
import type { CalendarEvent } from "@/lib/calendar/types";
import type { ContentRenderer, RenderParams, RenderResult } from "../types";
import type { Theme } from "@/lib/theme";
import type { DisplayEvent, RoomPolicy } from "@/lib/types";

const WINDOW_BEFORE_H = 1;
const WINDOW_AFTER_H = 7;  /* 8h total: 1h past + 7h future */

/* ── Bitmap font registration for color e-paper ──────────────── */

const FONT_DIR = path.join(process.cwd(), "assets/fonts");
let fontsRegistered = false;

function ensureFonts() {
  if (fontsRegistered) return;
  try {
    GlobalFonts.registerFromPath(path.join(FONT_DIR, "Inter-Regular.ttf"), "Inter");
    GlobalFonts.registerFromPath(path.join(FONT_DIR, "Inter-Bold.ttf"), "Inter");
    GlobalFonts.registerFromPath(path.join(FONT_DIR, "Inter-Medium.ttf"), "Inter");
  } catch { /* fonts not available — fall back to sans-serif */ }
  fontsRegistered = true;
}

/** Returns font family: always Inter (loaded from assets) */
function fontFamily(_colorCount: number): string {
  ensureFonts();
  return "Inter";
}

/** Map our logical font sizes to bitmap atlas keys */
interface TextCtx {
  ctx: SKRSContext2D;
  useBitmap: boolean;
  ff: string;
}

/** Draw text — bitmap for color e-paper, vector for everything else */
function text(
  t: TextCtx, x: number, y: number, str: string, font: BitmapFontSize,
  color: string, align: "left" | "right" = "left", maxWidth?: number
): number {
  if (t.useBitmap) {
    if (align === "right") {
      const w = measureBitmapText(str, font);
      return drawBitmapText(t.ctx, str, x - w, y, font, color, maxWidth);
    }
    return drawBitmapText(t.ctx, str, x, y, font, color, maxWidth);
  }
  const sizeMap: Record<BitmapFontSize, string> = {
    "sm": `16px ${t.ff}`,
    "md": `24px ${t.ff}`,
    "md-bold": `bold 24px ${t.ff}`,
    "lg-bold": `bold 32px ${t.ff}`,
  };
  t.ctx.font = sizeMap[font];
  t.ctx.fillStyle = color;
  t.ctx.textAlign = align;
  t.ctx.fillText(str, x, y, maxWidth);
  t.ctx.textAlign = "left";
  return t.ctx.measureText(str).width;
}

/** Measure text width */
function textWidth(t: TextCtx, str: string, font: BitmapFontSize): number {
  if (t.useBitmap) return measureBitmapText(str, font);
  const sizeMap: Record<BitmapFontSize, string> = {
    "sm": `16px ${t.ff}`,
    "md": `24px ${t.ff}`,
    "md-bold": `bold 24px ${t.ff}`,
    "lg-bold": `bold 32px ${t.ff}`,
  };
  t.ctx.font = sizeMap[font];
  return t.ctx.measureText(str).width;
}

export const roomBookingConfigSchema = z.object({
  providerId: z.string().uuid(),
  roomConfig: z.record(z.string(), z.unknown()),
  roomName: z.string().default("Meeting Room"),
  timezone: z.string().default("UTC"),
  policy: z.enum(["Show All", "Hide Subject", "Hide All"]).default("Show All"),
  cacheTtlS: z.number().int().min(0).default(120),
});

const eventsCache = new TtlCache<CalendarEvent[]>(Infinity); // TTL managed per-entry

export async function fetchEvents(config: z.infer<typeof roomBookingConfigSchema>): Promise<CalendarEvent[]> {
  const cacheKey = `${config.providerId}:${JSON.stringify(config.roomConfig)}`;

  // Skip cache in development for instant feedback
  if (process.env.NODE_ENV !== "development") {
    const cached = eventsCache.get(cacheKey);
    if (cached) return cached;
  }

  const [provider] = await db
    .select()
    .from(dataProviders)
    .where(eq(dataProviders.id, config.providerId))
    .limit(1);

  if (!provider) throw new Error(`Calendar provider ${config.providerId} not found`);

  const impl = getCalendarProvider(provider.type);
  if (!impl) throw new Error(`No implementation for provider type: ${provider.type}`);

  const credentials = decryptCredentials(provider.encryptedCredentials);
  const now = new Date();
  const events = await impl.fetchEvents({
    credentials,
    roomConfig: config.roomConfig,
    windowStart: new Date(now.getTime() - 4 * 3600_000),
    windowEnd: new Date(now.getTime() + 12 * 3600_000),
  });

  eventsCache.set(cacheKey, events, config.cacheTtlS * 1000);
  return events;
}

/* ── Canvas rendering ─────────────────────────────────────────── */

function fmtTime(date: Date, tz: string): string {
  return format(new TZDate(date, tz), "H:mm");
}

function fmtHour(hour: number): string {
  return `${((hour % 24) + 24) % 24}:00`;
}

function timeToY(ts: number, wStart: number, wEnd: number, top: number, h: number): number {
  return Math.round(top + ((ts - wStart) / (wEnd - wStart)) * h);
}

function isBusy(events: DisplayEvent[], now: Date): boolean {
  return events.some(
    (e) => e.startTime.getTime() <= now.getTime() && e.endTime.getTime() > now.getTime()
  );
}

/** Render room-booking day view to canvas. Exported for testing. */
export function renderToCanvas(
  events: DisplayEvent[],
  roomName: string,
  timezone: string,
  now: Date,
  T: Theme,
  width: number,
  height: number,
  colorCount: number,
  quantize: string = "color"
): Canvas {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const headerH = 75;
  const footerH = 44;
  const gutterW = 90;
  const ff = fontFamily(colorCount);
  const areaTop = headerH + 16;
  const areaH = height - headerH - footerH - 8;
  const eventLeft = gutterW + 4;
  const eventW = width - eventLeft - 16;
  const nowMs = now.getTime();
  /* Round to 4-hour blocks — timeline only shifts every 4 hours,
     minimizing unnecessary display refreshes on slow E-Paper */
  const blockMs = 4 * 3600_000;
  const roundedNowMs = Math.floor(nowMs / blockMs) * blockMs;
  const windowStart = roundedNowMs;
  const windowEnd = roundedNowMs + 8 * 3600_000;

  // Background
  ctx.fillStyle = T.background;
  ctx.fillRect(0, 0, width, height);

  // Header
  ctx.fillStyle = T.headerBg;
  ctx.fillRect(0, 0, width, headerH);

  // Badge (measure first to know available space)
  const busy = isBusy(events, new Date(roundedNowMs));
  const badgeText = busy ? "BUSY" : "FREE";
  const tc: TextCtx = { ctx, useBitmap: quantize === "color", ff };

  // Badge
  const bw = textWidth(tc, badgeText, "md-bold");
  const badgeX = width - bw - 32;
  ctx.fillStyle = busy ? T.busyBadge : T.freeBadge;
  ctx.fillRect(badgeX, 20, bw + 16, 34);
  text(tc, badgeX + 8, 46, badgeText, "md-bold", T.badgeText);

  // Date (right-aligned before badge)
  const dateStr = format(new TZDate(now, timezone), "EEE, MMM d, yyyy");
  const dateW = textWidth(tc, dateStr, "md");
  const dateX = badgeX - dateW - 20;
  text(tc, dateX, 46, dateStr, "md", T.headerText);

  // Room name (left, clipped before date)
  text(tc, 16, 48, roomName, "lg-bold", T.headerText, "left", dateX - 28);

  // Hour grid
  const roomNow = new TZDate(new Date(roundedNowMs), timezone);
  const startHour = roomNow.getHours();

  for (let h = 0; h <= 8; h++) {
    const hour = startHour + h;
    const hourDate = new TZDate(new Date(roundedNowMs), timezone);
    hourDate.setHours(hour, 0, 0, 0);
    const y = timeToY(hourDate.getTime(), windowStart, windowEnd, areaTop, areaH);
    if (y < areaTop || y > areaTop + areaH) continue;

    text(tc, gutterW - 8, y + 8, fmtHour(hour), "md", T.slotSecondary, "right");

    ctx.fillStyle = "#000000";
    ctx.fillRect(gutterW, y, width - 8 - gutterW, 2);
  }

  // Event blocks
  const visible = events.filter(
    (e) => e.endTime.getTime() > windowStart && e.startTime.getTime() < windowEnd
  );
  for (const evt of visible) {
    const y1 = Math.max(timeToY(evt.startTime.getTime(), windowStart, windowEnd, areaTop, areaH), areaTop);
    const y2 = Math.min(timeToY(evt.endTime.getTime(), windowStart, windowEnd, areaTop, areaH), areaTop + areaH);
    const blockH = Math.max(y2 - y1, 48);
    const pad = 12;

    ctx.fillStyle = (evt.isPrivate || evt.showLockIcon) ? T.busyBadge : T.slotBg;
    ctx.fillRect(eventLeft, y1, eventW, blockH);

    if (blockH > 20) {
      const timeStr = `${fmtTime(evt.startTime, timezone)} – ${fmtTime(evt.endTime, timezone)}`;
      const timeW = textWidth(tc, timeStr, "md");
      text(tc, eventLeft + eventW - pad, y1 + 30, timeStr, "md", T.slotText, "right");

      const label = evt.showLockIcon ? `🔒 ${evt.displaySubject}` : evt.displaySubject;
      text(tc, eventLeft + pad, y1 + 30, label, "md-bold", T.slotText, "left", eventW - timeW - pad * 3);
    }

    if (blockH > 48 && evt.organizer && evt.organizer.trim() !== evt.displaySubject.trim()) {
      text(tc, eventLeft + pad, y1 + 54, evt.organizer, "md", T.slotText, "left", eventW - pad * 2);
    }
  }

  // Reset alignment
  ctx.textAlign = "left";

  // Footer
  text(tc, width - 12, height - 10, `Updated: ${fmtTime(now, timezone)}`, "sm", T.footerText, "right");

  return canvas;
}

/* ── Offline fallback ─────────────────────────────────────────── */

/** Render offline fallback. Exported for testing. */
export function renderOffline(roomName: string, now: Date, T: Theme, width: number, height: number): Canvas {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = T.background;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = T.headerBg;
  ctx.fillRect(0, 0, width, 60);
  ctx.fillStyle = T.headerText;
  ctx.font = `bold 32px sans-serif`;
  ctx.fillText(roomName, 16, 40);

  ctx.fillStyle = T.busyBadge;
  ctx.font = `bold 32px sans-serif`;
  const msg = "System Offline";
  ctx.fillText(msg, (width - ctx.measureText(msg).width) / 2, height / 2);
  ctx.fillStyle = T.slotSecondary;
  ctx.font = `24px sans-serif`;
  const sub = "Calendar data unavailable";
  ctx.fillText(sub, (width - ctx.measureText(sub).width) / 2, height / 2 + 36);

  ctx.fillStyle = T.footerText;
  ctx.font = `24px sans-serif`;
  ctx.fillText(`Updated: ${format(now, "H:mm")}`, 16, height - 12);
  return canvas;
}

/* ── Exported renderer ────────────────────────────────────────── */

export const roomBookingRenderer: ContentRenderer = {
  slug: "room-booking",
  name: "Raumbelegung",
  configSchema: roomBookingConfigSchema,

  async render({ config, theme, display, now }: RenderParams): Promise<RenderResult> {
    const cfg = roomBookingConfigSchema.parse(config);
    const { width, height, colorCount } = display;

    let events: CalendarEvent[];
    try {
      events = await fetchEvents(cfg);
    } catch (err) {
      log.warn("Room-booking fetch failed", { error: String(err) });
      return { canvas: renderOffline(cfg.roomName, now, theme, width, height) };
    }

    const displayEvents = applyRoomPolicy(events, cfg.policy as RoomPolicy);
    return { canvas: renderToCanvas(displayEvents, cfg.roomName, cfg.timezone, now, theme, width, height, colorCount, display.quantize) };
  },
};
