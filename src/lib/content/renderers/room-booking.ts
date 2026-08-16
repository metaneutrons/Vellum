// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
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
import { de, fr, it, es, enUS } from "date-fns/locale";
import type { Locale as DateLocale } from "date-fns";

const DATE_LOCALES: Record<string, DateLocale> = { en: enUS, de, fr, it, es };

const BADGE_TEXT: Record<string, { free: string; busy: string }> = {
  en: { free: "FREE", busy: "BUSY" },
  de: { free: "FREI", busy: "BELEGT" },
  fr: { free: "LIBRE", busy: "OCCUPÉ" },
  it: { free: "LIBERO", busy: "OCCUPATO" },
  es: { free: "LIBRE", busy: "OCUPADO" },
};

const UPDATED_TEXT: Record<string, string> = {
  en: "updated",
  de: "aktualisiert",
  fr: "mis à jour",
  it: "aggiornato",
  es: "actualizado",
};
import { eq } from "drizzle-orm";
import path from "path";
import { db, withDbRead } from "@/db";
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
import QRCode from "qrcode";
import {
  BOOKING_QR_VISIBILITIES,
  normalizeBookingUrl,
  shouldShowBookingQr,
  type BookingQrVisibility,
} from "./booking-qr";

/* ── Bitmap font registration for color e-paper ──────────────── */

const FONT_DIR = path.join(process.cwd(), "assets/fonts");
let fontsRegistered = false;

function ensureFonts() {
  if (fontsRegistered) return;
  try {
    GlobalFonts.registerFromPath(path.join(FONT_DIR, "Inter-Regular.ttf"), "Inter");
    GlobalFonts.registerFromPath(path.join(FONT_DIR, "Inter-Bold.ttf"), "Inter");
    GlobalFonts.registerFromPath(path.join(FONT_DIR, "Inter-Medium.ttf"), "Inter");
  } catch {
    /* fonts not available — fall back to sans-serif */
  }
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
  scale: number;
}

/** Draw text — bitmap for color e-paper, vector for everything else */
function text(
  t: TextCtx,
  x: number,
  y: number,
  str: string,
  font: BitmapFontSize,
  color: string,
  align: "left" | "right" = "left",
  maxWidth?: number
): number {
  if (t.useBitmap) {
    if (align === "right") {
      const w = measureBitmapText(str, font);
      return drawBitmapText(t.ctx, str, x - w, y, font, color, maxWidth);
    }
    return drawBitmapText(t.ctx, str, x, y, font, color, maxWidth);
  }
  const sizeMap: Record<BitmapFontSize, string> = {
    sm: `${Math.round(16 * t.scale)}px ${t.ff}`,
    md: `${Math.round(24 * t.scale)}px ${t.ff}`,
    "md-bold": `bold ${Math.round(24 * t.scale)}px ${t.ff}`,
    "lg-bold": `bold ${Math.round(32 * t.scale)}px ${t.ff}`,
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
    sm: `${Math.round(16 * t.scale)}px ${t.ff}`,
    md: `${Math.round(24 * t.scale)}px ${t.ff}`,
    "md-bold": `bold ${Math.round(24 * t.scale)}px ${t.ff}`,
    "lg-bold": `bold ${Math.round(32 * t.scale)}px ${t.ff}`,
  };
  t.ctx.font = sizeMap[font];
  return t.ctx.measureText(str).width;
}

/** Draw text with word-wrap. Returns number of lines drawn. */
function textWrap(
  t: TextCtx,
  x: number,
  y: number,
  str: string,
  font: BitmapFontSize,
  color: string,
  maxWidth: number,
  lineH: number,
  maxLines: number
): number {
  const words = str.split(" ");
  let line = "";
  let lineNum = 0;

  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (textWidth(t, test, font) > maxWidth && line) {
      text(t, x, y + lineNum * lineH, line, font, color);
      lineNum++;
      if (lineNum >= maxLines) return lineNum;
      line = word;
    } else {
      line = test;
    }
  }
  if (line && lineNum < maxLines) {
    text(t, x, y + lineNum * lineH, line, font, color, "left", maxWidth);
    lineNum++;
  }
  return lineNum;
}

/** Room privacy policies — SSOT for schema + UI */
export { ROOM_POLICIES } from "./room-booking-types";
import { ROOM_POLICIES } from "./room-booking-types";

const bookingQrConfigSchema = z
  .object({
    visibility: z.enum(BOOKING_QR_VISIBILITIES).default("never"),
    source: z.enum(["provider", "custom"]).default("provider"),
    customUrl: z.string().max(256).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.source === "custom" && !normalizeBookingUrl(value.customUrl)) {
      ctx.addIssue({
        code: "custom",
        path: ["customUrl"],
        message: "A valid HTTP(S) booking URL is required.",
      });
    }
  });

export const roomBookingConfigSchema = z.object({
  providerId: z.string().uuid(),
  roomConfig: z.record(z.string(), z.unknown()),
  roomName: z.string().default("Meeting Room"),
  timezone: z.string().default("UTC"),
  locale: z.string().default("en"),
  dateFormat: z.enum(["PPPP", "PPP", "PP", "P"]).default("PPPP"),
  layout: z.enum(["timeline", "stacked"]).default("timeline"),
  policy: z.enum(ROOM_POLICIES).default("Show All"),
  cacheTtlS: z.number().int().min(0).default(120),
  timelineShiftH: z.number().int().min(1).max(8).default(2),
  bookingQr: bookingQrConfigSchema.default({ visibility: "never", source: "provider" }),
});

const eventsCache = new TtlCache<CalendarEvent[]>(Infinity); // TTL managed per-entry

export async function fetchEvents(
  config: z.infer<typeof roomBookingConfigSchema>
): Promise<CalendarEvent[]> {
  const cacheKey = `${config.providerId}:${JSON.stringify(config.roomConfig)}`;

  // Skip cache in development for instant feedback
  if (process.env.NODE_ENV !== "development") {
    const cached = eventsCache.get(cacheKey);
    if (cached) return cached;
  }

  const [provider] = await withDbRead(
    () => db.select().from(dataProviders).where(eq(dataProviders.id, config.providerId)).limit(1),
    "room-booking-provider"
  );

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

/** Resolve an optional booking URL without coupling it to calendar events. */
export async function resolveBookingUrl(
  config: z.infer<typeof roomBookingConfigSchema>
): Promise<string | null> {
  if (config.bookingQr.source === "custom") return normalizeBookingUrl(config.bookingQr.customUrl);

  const [provider] = await withDbRead(
    () => db.select().from(dataProviders).where(eq(dataProviders.id, config.providerId)).limit(1),
    "room-booking-url-provider"
  );
  if (!provider) return null;

  const impl = getCalendarProvider(provider.type);
  if (!impl?.getBookingUrl) return null;
  return normalizeBookingUrl(
    impl.getBookingUrl({
      credentials: decryptCredentials(provider.encryptedCredentials),
      roomConfig: config.roomConfig,
    })
  );
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

export interface TimelineBlock<T extends DisplayEvent = DisplayEvent> {
  evt: T;
  y1: number;
  y2: number;
  /** 0-based column index within its overlap group. */
  col: number;
  /** Number of side-by-side columns the overlap group needs (block width = 1/totalCols). */
  totalCols: number;
}

/**
 * Assign timeline events to side-by-side columns for overlap-free layout.
 *
 * This is a greedy sweep-line: each event takes the first column whose previous
 * occupant has already ended. That is only correct when events are processed in
 * start-time order — otherwise a later-starting event can grab column 0 and its
 * (larger) end-Y never frees the column for an earlier event, which then gets
 * bumped into a phantom extra column and rendered at half width. Calendar
 * providers do NOT guarantee ordering, so we sort a copy by start time here
 * before packing. (Regression: two reverse-ordered, non-overlapping events were
 * rendering as one full-width + one half-width-right block.)
 */
export function computeTimelineLayout<T extends DisplayEvent>(
  visible: T[],
  windowStart: number,
  windowEnd: number,
  areaTop: number,
  areaH: number
): TimelineBlock<T>[] {
  const sorted = [...visible].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  const columns: { end: number }[] = [];
  const layout: TimelineBlock<T>[] = [];
  for (const evt of sorted) {
    const y1 = Math.max(
      timeToY(evt.startTime.getTime(), windowStart, windowEnd, areaTop, areaH),
      areaTop
    );
    const y2 = Math.min(
      timeToY(evt.endTime.getTime(), windowStart, windowEnd, areaTop, areaH),
      areaTop + areaH
    );

    // First column free by the time this event starts (touching ends may share).
    let col = 0;
    for (col = 0; col < columns.length; col++) {
      if (columns[col].end <= y1) break;
    }
    if (col === columns.length) columns.push({ end: 0 });
    columns[col] = { end: y2 };

    layout.push({ evt, y1, y2, col, totalCols: 0 });
  }

  // Group width = the widest column index reached by any event overlapping this one.
  for (const item of layout) {
    const overlapping = layout.filter((o) => o.y1 < item.y2 && o.y2 > item.y1);
    item.totalCols = Math.max(...overlapping.map((o) => o.col + 1));
  }

  return layout;
}

function isBusy(events: DisplayEvent[], now: Date): boolean {
  return events.some(
    (e) => e.startTime.getTime() <= now.getTime() && e.endTime.getTime() > now.getTime()
  );
}

export interface BookingQrRenderOptions {
  url: string;
  visibility: BookingQrVisibility;
  /** Must be calculated from raw provider events, before privacy filtering. */
  isRoomFree: boolean;
}

function bookingLabel(locale: string): string {
  return (
    { en: "Book room", de: "Jetzt buchen", fr: "Réserver", it: "Prenota", es: "Reservar" }[
      locale
    ] ?? "Book room"
  );
}

/** Draw a crisp, scanner-safe QR panel. Matrix modules are never interpolated. */
function renderBookingQr(
  ctx: SKRSContext2D,
  tc: TextCtx,
  T: Theme,
  width: number,
  height: number,
  scale: number,
  locale: string,
  options: BookingQrRenderOptions | undefined
): { visible: boolean; reservedWidth: number; reservedHeight: number } {
  if (!options || !shouldShowBookingQr(options.visibility, options.isRoomFree, options.url)) {
    return { visible: false, reservedWidth: 0, reservedHeight: 0 };
  }

  const panelSize = Math.max(Math.round(182 * scale), 120);
  const labelH = Math.max(Math.round(22 * scale), 15);
  const panelX = width - panelSize - Math.round(12 * scale);
  const panelY = height - panelSize - labelH - Math.round(22 * scale);
  const qr = QRCode.create(options.url, { errorCorrectionLevel: "M" });
  const quietZone = 4;
  const modules = qr.modules.size + quietZone * 2;
  const moduleSize = Math.max(1, Math.floor(panelSize / modules));
  const qrSize = moduleSize * modules;
  const qrX = panelX + Math.floor((panelSize - qrSize) / 2);
  const qrY = panelY + Math.floor((panelSize - qrSize) / 2);

  // The white quiet zone is part of the QR code, not a decorative card.
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(panelX, panelY, panelSize, panelSize);
  ctx.fillStyle = "#000000";
  for (let row = 0; row < qr.modules.size; row++) {
    for (let col = 0; col < qr.modules.size; col++) {
      if (qr.modules.get(row, col)) {
        ctx.fillRect(
          qrX + (col + quietZone) * moduleSize,
          qrY + (row + quietZone) * moduleSize,
          moduleSize,
          moduleSize
        );
      }
    }
  }
  // text() only supports left/right alignment; center the label manually.
  const label = bookingLabel(locale);
  const labelWidth = textWidth(tc, label, "sm");
  ctx.fillStyle = T.background;
  ctx.fillRect(panelX, panelY + panelSize, panelSize, labelH + 2);
  text(
    tc,
    panelX + (panelSize - labelWidth) / 2,
    panelY + panelSize + labelH,
    label,
    "sm",
    T.footerText
  );

  return {
    visible: true,
    reservedWidth: panelSize + Math.round(24 * scale),
    reservedHeight: panelSize + labelH + Math.round(28 * scale),
  };
}

/** Render room-booking day view to canvas. Exported for testing. */
/* ── Shared Header ─────────────────────────────────────────────── */

interface HeaderCtx {
  ctx: SKRSContext2D;
  tc: TextCtx;
  width: number;
  headerH: number;
  scale: number;
  T: Theme;
  roomName: string;
  timezone: string;
  now: Date;
  locale: string;
  dateFormat: string;
  events: DisplayEvent[];
}

function renderHeader(h: HeaderCtx): void {
  const { ctx, tc, width, headerH, scale, T, roomName, timezone, now, locale, dateFormat, events } =
    h;

  ctx.fillStyle = T.headerBg;
  ctx.fillRect(0, 0, width, headerH);

  const busy = isBusy(events, now);
  const badge = BADGE_TEXT[locale] ?? BADGE_TEXT.en;
  const badgeText = busy ? badge.busy : badge.free;

  const bw = textWidth(tc, badgeText, "md-bold");
  const badgeX = width - bw - Math.round(32 * scale);
  ctx.fillStyle = busy ? T.busyBadge : T.freeBadge;
  ctx.fillRect(badgeX, Math.round(20 * scale), bw + Math.round(16 * scale), Math.round(34 * scale));
  text(
    tc,
    badgeX + Math.round(8 * scale),
    Math.round(46 * scale),
    badgeText,
    "md-bold",
    T.badgeText
  );

  const dfLocale = DATE_LOCALES[locale] ?? DATE_LOCALES.en;
  const dateStr = format(new TZDate(now, timezone), dateFormat, { locale: dfLocale });
  const dateW = textWidth(tc, dateStr, "md");
  const dateX = badgeX - dateW - Math.round(20 * scale);
  text(tc, dateX, Math.round(46 * scale), dateStr, "md", T.headerText);

  text(
    tc,
    Math.round(16 * scale),
    Math.round(48 * scale),
    roomName,
    "lg-bold",
    T.headerText,
    "left",
    dateX - Math.round(28 * scale)
  );
}

export function renderToCanvas(
  events: DisplayEvent[],
  roomName: string,
  timezone: string,
  now: Date,
  T: Theme,
  width: number,
  height: number,
  colorCount: number,
  colorMode: string = "indexed",
  timelineShiftH: number = 2,
  locale: string = "en",
  dateFormat: string = "PPPP",
  bookingQr?: BookingQrRenderOptions
): Canvas {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  /* Enable anti-aliasing for grayscale displays (smooth fonts) */
  ctx.imageSmoothingEnabled = colorMode !== "indexed";

  /* Scale based on shorter dimension (480px reference) for consistent proportions */
  const shortSide = Math.min(width, height);
  const scale = shortSide / 480;

  const headerH = Math.round(75 * scale);
  const footerH = Math.round(44 * scale);
  const gutterW = Math.round(90 * scale);
  const ff = fontFamily(colorCount);
  const areaTop = headerH + Math.round(24 * scale);
  const areaH = height - headerH - footerH - Math.round(8 * scale);
  const eventLeft = gutterW + Math.round(4 * scale);
  const qrReservation =
    bookingQr && shouldShowBookingQr(bookingQr.visibility, bookingQr.isRoomFree, bookingQr.url)
      ? Math.max(Math.round(206 * scale), 138)
      : 0;
  const eventW = width - eventLeft - Math.round(16 * scale) - qrReservation;
  const nowMs = now.getTime();
  /* Round to timelineShiftH blocks — timeline only shifts every N hours */
  const blockMs = timelineShiftH * 3600_000;
  const roundedNowMs = Math.floor(nowMs / blockMs) * blockMs;
  const windowStart = roundedNowMs;
  const windowEnd = roundedNowMs + 8 * 3600_000;

  // Background
  ctx.fillStyle = T.background;
  ctx.fillRect(0, 0, width, height);

  // Header (shared with stacked layout)
  const tc: TextCtx = { ctx, useBitmap: colorMode === "indexed", ff, scale };
  renderHeader({
    ctx,
    tc,
    width,
    headerH,
    scale,
    T,
    roomName,
    timezone,
    now,
    locale,
    dateFormat,
    events,
  });

  // Date locale for midnight separator
  const dfLocale = DATE_LOCALES[locale] ?? DATE_LOCALES.en;

  // Hour grid
  // Hour grid — iterate over each hour in the window
  for (let h = 0; h <= 8; h++) {
    const hourMs = windowStart + h * 3600_000;
    const hourDate = new TZDate(new Date(hourMs), timezone);
    const hour = hourDate.getHours();
    const y = timeToY(hourMs, windowStart, windowEnd, areaTop, areaH);
    if (y < areaTop || y > areaTop + areaH) continue;

    /* Midnight separator: show next day label only if hours follow after 0:00 */
    if (hour === 0 && h > 0 && h < 8) {
      const dayLabel = format(hourDate, "EEEE, d. MMM", { locale: dfLocale });
      ctx.fillStyle = T.slotSecondary;
      ctx.fillRect(gutterW, y - 1, width - Math.round(8 * scale) - gutterW, 1);
      const labelW = textWidth(tc, dayLabel, "sm");
      const labelX = gutterW + (width - Math.round(8 * scale) - gutterW - labelW) / 2;
      text(tc, labelX, y - Math.round(4 * scale), dayLabel, "sm", T.slotSecondary);
      ctx.fillRect(gutterW, y + 1, width - Math.round(8 * scale) - gutterW, 1);
    }

    text(
      tc,
      gutterW - Math.round(8 * scale),
      y + Math.round(8 * scale),
      fmtHour(hour),
      "md",
      T.slotSecondary,
      "right"
    );

    ctx.fillStyle = "#000000";
    ctx.fillRect(gutterW, y, width - Math.round(8 * scale) - gutterW, Math.round(2 * scale));
  }

  // Event blocks — detect overlaps and arrange side by side
  const visible = events.filter(
    (e) => e.endTime.getTime() > windowStart && e.startTime.getTime() < windowEnd
  );
  const eventLayout = computeTimelineLayout(visible, windowStart, windowEnd, areaTop, areaH);

  for (const { evt, y1, y2, col, totalCols } of eventLayout) {
    const blockH = Math.max(y2 - y1, 5); /* minimum 5px visible */
    const colW = eventW / Math.max(totalCols, 1);
    const ex = eventLeft + col * colW;
    const ew = colW - 2; /* 2px gap between columns */
    const pad = 8;

    ctx.fillStyle = evt.isPrivate || evt.showLockIcon ? T.busyBadge : T.eventBg;
    /* Extend block 2px at bottom to fully cover the end grid line */
    ctx.fillRect(ex, y1, ew, blockH + 2);

    /* Dynamic font size based on block height */
    if (blockH < Math.round(16 * scale)) continue; /* block drawn, but too small for text */
    const fontSize: "sm" | "md" | "md-bold" = blockH < Math.round(28 * scale) ? "sm" : "md";
    const fontSizeBold: "sm" | "md-bold" = blockH < Math.round(28 * scale) ? "sm" : "md-bold";
    const lineH = blockH < Math.round(28 * scale) ? Math.round(16 * scale) : Math.round(24 * scale);

    if (blockH >= 16) {
      const timeStr = `${fmtTime(evt.startTime, timezone)} – ${fmtTime(evt.endTime, timezone)}`;
      const timeW = textWidth(tc, timeStr, fontSize);
      const textY = y1 + Math.min(lineH, blockH - 4);
      text(tc, ex + ew - pad, textY, timeStr, fontSize, T.slotText, "right");

      const label = evt.showLockIcon ? `🔒 ${evt.displaySubject}` : evt.displaySubject;
      const labelMaxW = ew - timeW - pad * 3;
      const availLines = Math.floor((blockH - lineH) / lineH);

      if (availLines >= 1 && textWidth(tc, label, fontSizeBold) > labelMaxW) {
        /* Wrap subject across available lines */
        textWrap(
          tc,
          ex + pad,
          textY,
          label,
          fontSizeBold,
          T.slotText,
          ew - pad * 2,
          lineH,
          availLines + 1
        );
      } else {
        text(tc, ex + pad, textY, label, fontSizeBold, T.slotText, "left", labelMaxW);
      }
    }

    const usedLines = blockH >= 16 ? 1 : 0;
    if (
      blockH > lineH * (usedLines + 1) &&
      evt.organizer &&
      evt.organizer.trim() !== evt.displaySubject.trim()
    ) {
      text(tc, ex + pad, y1 + lineH * 2, evt.organizer, fontSize, T.slotText, "left", ew - pad * 2);
    }
  }

  // Reset alignment
  ctx.textAlign = "left";

  // Footer
  const updatedLabel = UPDATED_TEXT[locale] ?? UPDATED_TEXT.en;
  const timeStr = locale === "de" ? `${fmtTime(now, timezone)} Uhr` : fmtTime(now, timezone);
  text(
    tc,
    width - Math.round(12 * scale),
    height - Math.round(10 * scale),
    `${updatedLabel}: ${timeStr}`,
    "sm",
    T.footerText,
    "right"
  );
  renderBookingQr(ctx, tc, T, width, height, scale, locale, bookingQr);

  return canvas;
}

/* ── Offline fallback ─────────────────────────────────────────── */

/** Render offline fallback. Exported for testing. */
export function renderOffline(
  roomName: string,
  now: Date,
  T: Theme,
  width: number,
  height: number,
  locale: string = "en"
): Canvas {
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
  const msg =
    {
      en: "System Offline",
      de: "System Offline",
      fr: "Système hors ligne",
      it: "Sistema offline",
      es: "Sistema fuera de línea",
    }[locale] ?? "System Offline";
  ctx.fillText(msg, (width - ctx.measureText(msg).width) / 2, height / 2);
  ctx.fillStyle = T.slotSecondary;
  ctx.font = `24px sans-serif`;
  const sub =
    {
      en: "Calendar data unavailable",
      de: "Kalenderdaten nicht verfügbar",
      fr: "Données calendrier indisponibles",
      it: "Dati calendario non disponibili",
      es: "Datos del calendario no disponibles",
    }[locale] ?? "Calendar data unavailable";
  ctx.fillText(sub, (width - ctx.measureText(sub).width) / 2, height / 2 + 36);

  ctx.fillStyle = T.footerText;
  ctx.font = `24px sans-serif`;
  ctx.fillText(`Updated: ${format(now, "H:mm")}`, 16, height - 12);
  return canvas;
}

/* ── Exported renderer ────────────────────────────────────────── */

/* ── Stacked Layout ────────────────────────────────────────────── */

function renderStacked(
  events: DisplayEvent[],
  roomName: string,
  timezone: string,
  now: Date,
  T: Theme,
  width: number,
  height: number,
  colorCount: number,
  colorMode: string = "indexed",
  locale: string = "en",
  dateFormat: string = "PPPP",
  bookingQr?: BookingQrRenderOptions
): Canvas {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = colorMode !== "indexed";

  const shortSide = Math.min(width, height);
  const scale = shortSide / 480;
  const ff = fontFamily(colorCount);
  const dfLocale = DATE_LOCALES[locale] ?? DATE_LOCALES.en;

  const headerH = Math.round(75 * scale);
  const padding = Math.round(16 * scale);
  const cardH = Math.round(70 * scale);
  const cardGap = Math.round(10 * scale);
  const sepH = Math.round(30 * scale);

  // Background
  ctx.fillStyle = T.background;
  ctx.fillRect(0, 0, width, height);

  // Shared header (same as timeline)
  const tc: TextCtx = { ctx, useBitmap: colorMode === "indexed", ff, scale };
  renderHeader({
    ctx,
    tc,
    width,
    headerH,
    scale,
    T,
    roomName,
    timezone,
    now,
    locale,
    dateFormat,
    events,
  });

  // Filter upcoming events
  const upcoming = events
    .filter((e) => e.endTime.getTime() > now.getTime())
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  let y = headerH + Math.round(24 * scale);
  let lastDateStr = "";

  const qrReservedHeight =
    bookingQr && shouldShowBookingQr(bookingQr.visibility, bookingQr.isRoomFree, bookingQr.url)
      ? Math.max(Math.round(234 * scale), 158)
      : 0;
  for (const evt of upcoming) {
    if (y + cardH > height - Math.round(40 * scale) - qrReservedHeight) break;

    // Day separator
    const evtDate = format(new TZDate(evt.startTime, timezone), "yyyy-MM-dd");
    if (evtDate !== lastDateStr && lastDateStr !== "") {
      const dayLabel = format(new TZDate(evt.startTime, timezone), "EEEE, d. MMM", {
        locale: dfLocale,
      });
      ctx.fillStyle = T.slotSecondary;
      const labelW = textWidth(tc, dayLabel, "sm");
      text(tc, padding, y + Math.round(12 * scale), dayLabel, "sm", T.slotSecondary);
      ctx.fillRect(
        padding + labelW + Math.round(8 * scale),
        y + Math.round(8 * scale),
        width - 2 * padding - labelW - Math.round(8 * scale),
        1
      );
      y += sepH;
    }
    lastDateStr = evtDate;

    // Event card
    const isNow = evt.startTime.getTime() <= now.getTime() && evt.endTime.getTime() > now.getTime();
    ctx.fillStyle = isNow ? T.busyBadge : T.eventBg;
    ctx.fillRect(padding, y, width - 2 * padding, cardH);

    // Time
    const timeStr = `${fmtTime(evt.startTime, timezone)} – ${fmtTime(evt.endTime, timezone)}`;
    text(
      tc,
      padding + Math.round(12 * scale),
      y + Math.round(26 * scale),
      timeStr,
      "md-bold",
      isNow ? T.badgeText : T.slotText
    );

    // Subject
    const maxSubW = width - 2 * padding - Math.round(24 * scale);
    text(
      tc,
      padding + Math.round(12 * scale),
      y + Math.round(52 * scale),
      evt.displaySubject,
      "sm",
      isNow ? T.badgeText : T.slotSecondary,
      "left",
      maxSubW
    );

    y += cardH + cardGap;
  }

  // Footer
  const updatedLabel = UPDATED_TEXT[locale] ?? UPDATED_TEXT.en;
  const footerTime = locale === "de" ? `${fmtTime(now, timezone)} Uhr` : fmtTime(now, timezone);
  text(
    tc,
    width - Math.round(12 * scale),
    height - Math.round(10 * scale),
    `${updatedLabel}: ${footerTime}`,
    "sm",
    T.footerText,
    "right"
  );
  renderBookingQr(ctx, tc, T, width, height, scale, locale, bookingQr);

  return canvas;
}

export const roomBookingRenderer: ContentRenderer = {
  slug: "room-booking",
  name: "Room Booking",
  configSchema: roomBookingConfigSchema,

  async render({ config, theme, display, now }: RenderParams): Promise<RenderResult> {
    const cfg = roomBookingConfigSchema.parse(config);
    const { width, height, colorCount } = display;

    let events: CalendarEvent[];
    try {
      events = await fetchEvents(cfg);
    } catch (err) {
      log.warn("Room-booking fetch failed", { error: String(err) });
      return { canvas: renderOffline(cfg.roomName, now, theme, width, height, cfg.locale) };
    }

    const displayEvents = applyRoomPolicy(events, cfg.policy as RoomPolicy, cfg.locale);
    let bookingUrl: string | null = null;
    try {
      bookingUrl = await resolveBookingUrl(cfg);
    } catch (err) {
      // A missing public booking link must never take the room display offline.
      log.warn("Room-booking QR URL resolution failed", { error: String(err) });
    }
    const bookingQr: BookingQrRenderOptions | undefined = bookingUrl
      ? {
          url: bookingUrl,
          visibility: cfg.bookingQr.visibility,
          isRoomFree: !events.some(
            (event) =>
              event.startTime.getTime() <= now.getTime() && event.endTime.getTime() > now.getTime()
          ),
        }
      : undefined;
    if (cfg.layout === "stacked") {
      return {
        canvas: renderStacked(
          displayEvents,
          cfg.roomName,
          cfg.timezone,
          now,
          theme,
          width,
          height,
          colorCount,
          display.colorMode,
          cfg.locale,
          cfg.dateFormat,
          bookingQr
        ),
      };
    }
    return {
      canvas: renderToCanvas(
        displayEvents,
        cfg.roomName,
        cfg.timezone,
        now,
        theme,
        width,
        height,
        colorCount,
        display.colorMode,
        cfg.timelineShiftH,
        cfg.locale,
        cfg.dateFormat,
        bookingQr
      ),
    };
  },
};
