// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Room-booking content renderer — Outlook-style day view.
 *
 * Fetches calendar events via the configured provider,
 * applies room policy, renders to canvas at device resolution.
 */

import { z } from "zod";
import { type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { format } from "date-fns";
import { TZDate } from "@date-fns/tz";
import { de, fr, it, es, enUS } from "date-fns/locale";
import type { Locale as DateLocale } from "date-fns";

/* `en` is the fallback for both lookups, so the type carries that guarantee. */
const DATE_LOCALES: Record<string, DateLocale> & { en: DateLocale } = {
  en: enUS,
  de,
  fr,
  it,
  es,
};

interface BadgeText {
  free: string;
  busy: string;
}
const BADGE_TEXT: Record<string, BadgeText> & { en: BadgeText } = {
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
import { applyRoomPolicy } from "@/lib/calendar/policy";
import { fetchResourceEvents } from "@/lib/calendar/source";
import { getCalendarProvider } from "@/lib/calendar/registry";
import { getProviderWithCredentials } from "@/lib/providers";
import { log } from "@/lib/logger";
import { ensureRenderFonts } from "@/lib/render/fonts";

/**
 * The renderer's size vocabulary.
 *
 * Was the key set of a pre-rasterised bitmap atlas, which is gone: it covered 105
 * characters, so "Françoise" drew as "Fran?oise" on the six-colour E1002, and its
 * wider advances truncated a room name that fits perfectly in vector type. The
 * atlas existed to avoid dithered edges, but `canvasToPixelBuffer` quantises
 * indexed output with nearestColorQuantize rather than Floyd-Steinberg, so an
 * antialiased edge snaps hard to black or white and there was nothing to avoid.
 * Verified by rendering the same timeline both ways and quantising both.
 *
 * The four steps are kept as they were so nothing about the layout moves.
 */
type FontSize = "sm" | "md" | "md-bold" | "lg-bold";
import type { CalendarEvent } from "@/lib/calendar/types";
import type { ContentRenderer, DrawParams, DrawResult, LoadParams } from "../types";
import { readableOn, type Theme } from "@/lib/theme";
import type { DisplayEvent, RoomPolicy } from "@/lib/types";
import QRCode from "qrcode";
import {
  BOOKING_QR_VISIBILITIES,
  normalizeBookingUrl,
  shouldShowBookingQr,
  type BookingQrVisibility,
} from "./booking-qr";
import { blockCapacity, planBlockText } from "./room-booking-blocks";
import { canvasSurface, type SurfaceFactory } from "@/lib/render/surface";

/* ── Bitmap font registration for color e-paper ──────────────── */

/** Returns font family: always Inter (loaded from assets). */
function fontFamily(_colorCount: number): string {
  return ensureRenderFonts();
}

/** Everything the renderer needs to set a line of text. */
interface TextCtx {
  ctx: SKRSContext2D;
  ff: string;
  scale: number;
}

/** Draw text. One path now, for every panel. */
function text(
  t: TextCtx,
  x: number,
  y: number,
  str: string,
  font: FontSize,
  color: string,
  align: "left" | "right" = "left",
  maxWidth?: number
): number {
  const sizeMap: Record<FontSize, string> = {
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
function textWidth(t: TextCtx, str: string, font: FontSize): number {
  const sizeMap: Record<FontSize, string> = {
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
  font: FontSize,
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
  providerId: z.uuid(),
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

export type RoomBookingConfig = z.infer<typeof roomBookingConfigSchema>;

/**
 * The room's bookings for the window a day view shows.
 *
 * Four hours back so that a booking already running is still there, twelve hours
 * forward because the timeline shows eight and the stacked layout wants a few
 * more. The cache and the provider dispatch live in `calendar/source.ts`, shared
 * with every other renderer that asks about the same room.
 */
export async function fetchEvents(
  config: z.infer<typeof roomBookingConfigSchema>
): Promise<CalendarEvent[]> {
  const now = Date.now();
  return fetchResourceEvents({
    providerId: config.providerId,
    roomConfig: config.roomConfig,
    windowStart: new Date(now - 4 * 3600_000),
    windowEnd: new Date(now + 12 * 3600_000),
    ttlS: config.cacheTtlS,
  });
}

/** Resolve an optional booking URL without coupling it to calendar events. */
export async function resolveBookingUrl(
  config: z.infer<typeof roomBookingConfigSchema>
): Promise<string | null> {
  if (config.bookingQr.source === "custom") return normalizeBookingUrl(config.bookingQr.customUrl);

  /* Same loader the event source uses, rather than a second hand-rolled read and
   * decrypt in this file. A missing provider is not an error here: a room whose
   * booking link cannot be resolved still shows its bookings. */
  const provider = await getProviderWithCredentials(config.providerId).catch(() => null);
  const impl = provider ? getCalendarProvider(provider.type) : null;
  if (!provider || !impl?.getBookingUrl) return null;
  return normalizeBookingUrl(
    await impl.getBookingUrl({ credentials: provider.credentials, roomConfig: config.roomConfig })
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
      /* col stays inside the loop bound, so the column is always there. */
      if ((columns[col]?.end ?? 0) <= y1) break;
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
  const badgeBg = busy ? T.busyBadge : T.freeBadge;
  ctx.fillStyle = badgeBg;
  ctx.fillRect(badgeX, Math.round(20 * scale), bw + Math.round(16 * scale), Math.round(34 * scale));
  text(
    tc,
    badgeX + Math.round(8 * scale),
    Math.round(46 * scale),
    badgeText,
    "md-bold",
    /* One `badgeText` serves two grounds: on the two-colour panel the free badge is
     * white and the busy one black, so whichever value the theme holds, one of the
     * two states would draw its text on its own colour. */
    readableOn(badgeBg, T.badgeText)
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

interface EventBlockCtx {
  tc: TextCtx;
  T: Theme;
  evt: DisplayEvent;
  timezone: string;
  scale: number;
  ex: number;
  ew: number;
  y1: number;
  blockH: number;
}

/** The type a block of a given height is set in. */
interface BlockType {
  plain: FontSize;
  bold: FontSize;
  lineH: number;
}

/** Short blocks step down one size so that two lines still fit. */
function blockType(blockH: number, scale: number): BlockType {
  const small = blockH < Math.round(28 * scale);
  return {
    plain: small ? "sm" : "md",
    bold: small ? "sm" : "md-bold",
    lineH: small ? Math.round(16 * scale) : Math.round(24 * scale),
  };
}

/**
 * One booking: the filled block and whatever text fits in it.
 *
 * Which text that is comes from `planBlockText` rather than from a fixed stack,
 * so a block the window has clipped keeps naming the occupant instead of keeping
 * the time range. See room-booking-blocks.ts for the case that forced this.
 */
function drawEventBlock(b: EventBlockCtx): void {
  const { tc, T, evt, ex, ew, y1, blockH, scale } = b;
  const ctx = tc.ctx;
  const pad = 8;

  const blockBg = evt.isPrivate || evt.showLockIcon ? T.busyBadge : T.eventBg;
  /* Same problem as the badge: the block's ground is one of two colours while
   * `slotText` is one value. On the mono panel both grounds are black, so an
   * unguarded black `slotText` drew every booking as a featureless bar. */
  const blockText = readableOn(blockBg, T.slotText);
  ctx.fillStyle = blockBg;
  /* Extend block 2px at bottom to fully cover the end grid line */
  ctx.fillRect(ex, y1, ew, blockH + 2);
  if (blockH < Math.round(16 * scale)) return; /* block drawn, but too small for text */

  const { plain: fontSize, bold: fontSizeBold, lineH } = blockType(blockH, scale);
  const capacity = blockCapacity(blockH, lineH);
  const subject = evt.showLockIcon ? `🔒 ${evt.displaySubject}` : evt.displaySubject;
  const plan = planBlockText(subject, evt.organizer, capacity);
  if (!plan.primary) return;

  const timeStr = `${fmtTime(evt.startTime, b.timezone)} – ${fmtTime(evt.endTime, b.timezone)}`;
  const timeW = textWidth(tc, timeStr, fontSize);
  const besideTime = ew - timeW - pad * 3;
  const primaryW = textWidth(tc, plan.primary, fontSizeBold);
  /* The time shares line one and so costs no line. It gives way only on a
   * single-line block whose one line would otherwise be cut short, because the
   * hour grid behind the block already says when the booking runs. */
  const withTime = capacity > 1 || primaryW <= besideTime;
  const textY = y1 + Math.min(lineH, blockH - 4);
  if (withTime) text(tc, ex + ew - pad, textY, timeStr, fontSize, blockText, "right");

  const primaryMaxW = withTime ? besideTime : ew - pad * 2;
  /* Wrapping is allowed only when no occupant line has to be placed below,
   * which is also the only case where the lines below are free. Wrapping into
   * them regardless is what used to draw the subject over the occupant. */
  if (!plan.secondary && capacity > 1 && primaryW > primaryMaxW) {
    textWrap(
      tc,
      ex + pad,
      textY,
      plan.primary,
      fontSizeBold,
      blockText,
      ew - pad * 2,
      lineH,
      capacity
    );
  } else {
    text(tc, ex + pad, textY, plan.primary, fontSizeBold, blockText, "left", primaryMaxW);
  }
  if (plan.secondary) {
    text(tc, ex + pad, y1 + lineH * 2, plan.secondary, fontSize, blockText, "left", ew - pad * 2);
  }
}

/* ── The frame both layouts share ─────────────────────────────── */

/**
 * One room frame's inputs.
 *
 * An object rather than the fourteen and thirteen positional arguments the two
 * layouts used to take. That was not merely ugly: `colorMode`, `timelineShiftH`,
 * `locale` and `dateFormat` all sat in the middle with defaults, so adding one
 * meant counting commas at every call site, and the two signatures had drifted
 * apart by one parameter for no reason anybody could name.
 */
export interface FrameSpec {
  events: DisplayEvent[];
  roomName: string;
  timezone: string;
  /** The instant the frame depicts. */
  now: Date;
  theme: Theme;
  width: number;
  height: number;
  colorCount: number;
  colorMode?: string;
  locale?: string;
  dateFormat?: string;
  /** Hours the timeline window steps by. Ignored by the stacked layout. */
  timelineShiftH?: number;
  bookingQr?: BookingQrRenderOptions | undefined;
  surface?: SurfaceFactory | undefined;
}

/** What `openFrame` settles once, so neither layout settles it twice. */
interface Frame {
  canvas: Canvas;
  ctx: SKRSContext2D;
  tc: TextCtx;
  scale: number;
  headerH: number;
  locale: string;
  dateLocale: DateLocale;
}

/**
 * The surface, the metrics, the ground and the header.
 *
 * Both layouts opened with the same twenty lines, and one of them had drifted:
 * the timeline computed a `footerH` the stacked layout did not, and the stacked
 * layout skipped the alignment reset before its footer. Neither difference was
 * intended.
 */
function openFrame(spec: FrameSpec): Frame {
  const { width, height, theme: T } = spec;
  const { canvas, ctx } = (spec.surface ?? canvasSurface)(width, height);

  /* Anti-aliasing everywhere except the indexed panel, whose quantiser snaps a
   * grey edge hard to black or white. */
  ctx.imageSmoothingEnabled = (spec.colorMode ?? "indexed") !== "indexed";

  /* Scale from the shorter dimension (480px reference) so that proportions hold
   * on every panel. This is why the timeline's clipping cliff lands at the same
   * fraction of a booking everywhere. */
  const scale = Math.min(width, height) / 480;
  const headerH = Math.round(75 * scale);
  const locale = spec.locale ?? "en";
  const tc: TextCtx = { ctx, ff: fontFamily(spec.colorCount), scale };

  ctx.fillStyle = T.background;
  ctx.fillRect(0, 0, width, height);

  renderHeader({
    ctx,
    tc,
    width,
    headerH,
    scale,
    T,
    roomName: spec.roomName,
    timezone: spec.timezone,
    now: spec.now,
    locale,
    dateFormat: spec.dateFormat ?? "PPPP",
    events: spec.events,
  });

  return {
    canvas,
    ctx,
    tc,
    scale,
    headerH,
    locale,
    dateLocale: DATE_LOCALES[locale] ?? DATE_LOCALES.en,
  };
}

/** The freshness line and the booking QR, over whatever the layout drew. */
function closeFrame(spec: FrameSpec, f: Frame): Canvas {
  f.ctx.textAlign = "left";
  const updatedLabel = UPDATED_TEXT[f.locale] ?? UPDATED_TEXT.en;
  const stamp = fmtTime(spec.now, spec.timezone);
  /* Two statements rather than a template literal nested inside a template
   * literal: Lizard's TypeScript tokenizer loses the function boundary at nested
   * backticks and then attributes the next 200 lines to this function, which trips
   * the complexity gate on code that is fifteen lines long. Second instance of the
   * same class of parser confusion; see CLAUDE.md. */
  const stampText = f.locale === "de" ? `${stamp} Uhr` : stamp;
  text(
    f.tc,
    spec.width - Math.round(12 * f.scale),
    spec.height - Math.round(10 * f.scale),
    `${updatedLabel}: ${stampText}`,
    "sm",
    spec.theme.footerText,
    "right"
  );
  renderBookingQr(
    f.ctx,
    f.tc,
    spec.theme,
    spec.width,
    spec.height,
    f.scale,
    f.locale,
    spec.bookingQr
  );
  return f.canvas;
}

/** Whether the booking QR will be drawn, and therefore has to be made room for. */
function qrShown(spec: FrameSpec): boolean {
  const qr = spec.bookingQr;
  return !!qr && shouldShowBookingQr(qr.visibility, qr.isRoomFree, qr.url);
}

/* ── Offline fallback ─────────────────────────────────────────── */

export interface OfflineSpec {
  roomName: string;
  now: Date;
  theme: Theme;
  width: number;
  height: number;
  locale?: string;
  surface?: SurfaceFactory | undefined;
}

/**
 * What a display shows when the provider could not be reached.
 *
 * Deliberately NOT built on `openFrame`: this screen must work when nothing else
 * does, so it carries its own minimal drawing and asks nothing of the calendar.
 * It also ignores `scale` entirely, which is a defect rather than a decision, and
 * is recorded in the ROADMAP: on an E1003 the room name sits at 32 px in the
 * corner of a 1872 px panel.
 */
export function renderOffline(spec: OfflineSpec): Canvas {
  const { roomName, now, theme: T, width, height } = spec;
  const locale = spec.locale ?? "en";
  const { canvas, ctx } = (spec.surface ?? canvasSurface)(width, height);
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

/* ── Timeline layout ──────────────────────────────────────────── */

interface TimelineWindow {
  startMs: number;
  endMs: number;
  areaTop: number;
  areaH: number;
}

/**
 * The eight hours on screen, and where they land.
 *
 * The start is rounded down to `timelineShiftH`, so the view shifts every N hours
 * rather than sliding continuously and redrawing an e-paper panel for nothing.
 * The consequence to keep in mind is that a RUNNING booking gets clipped at the
 * top as the day passes; `room-booking-blocks.ts` records what that cost once.
 */
function timelineWindow(spec: FrameSpec, f: Frame): TimelineWindow {
  const blockMs = (spec.timelineShiftH ?? 2) * 3600_000;
  const startMs = Math.floor(spec.now.getTime() / blockMs) * blockMs;
  const footerH = Math.round(44 * f.scale);
  return {
    startMs,
    endMs: startMs + 8 * 3600_000,
    areaTop: f.headerH + Math.round(24 * f.scale),
    areaH: spec.height - f.headerH - footerH - Math.round(8 * f.scale),
  };
}

/** The hour rules, their labels, and a separator where a new day begins. */
function drawHourGrid(spec: FrameSpec, f: Frame, w: TimelineWindow, gutterW: number): void {
  const { ctx, tc, scale } = f;
  const T = spec.theme;
  const right = spec.width - Math.round(8 * scale) - gutterW;

  for (let h = 0; h <= 8; h++) {
    const hourMs = w.startMs + h * 3600_000;
    const hourDate = new TZDate(new Date(hourMs), spec.timezone);
    const hour = hourDate.getHours();
    const y = timeToY(hourMs, w.startMs, w.endMs, w.areaTop, w.areaH);
    if (y < w.areaTop || y > w.areaTop + w.areaH) continue;

    /* Midnight separator: show next day label only if hours follow after 0:00 */
    if (hour === 0 && h > 0 && h < 8) {
      const dayLabel = format(hourDate, "EEEE, d. MMM", { locale: f.dateLocale });
      ctx.fillStyle = T.slotSecondary;
      ctx.fillRect(gutterW, y - 1, right, 1);
      const labelW = textWidth(tc, dayLabel, "sm");
      text(
        tc,
        gutterW + (right - labelW) / 2,
        y - Math.round(4 * scale),
        dayLabel,
        "sm",
        T.slotSecondary
      );
      ctx.fillRect(gutterW, y + 1, right, 1);
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
    ctx.fillRect(gutterW, y, right, Math.round(2 * scale));
  }
}

/** The day view: an hour grid with bookings placed on it. */
export function renderTimeline(spec: FrameSpec): Canvas {
  const f = openFrame(spec);
  const { scale } = f;
  const gutterW = Math.round(90 * scale);
  const w = timelineWindow(spec, f);

  drawHourGrid(spec, f, w, gutterW);

  const eventLeft = gutterW + Math.round(4 * scale);
  const reserved = qrShown(spec) ? Math.max(Math.round(206 * scale), 138) : 0;
  const eventW = spec.width - eventLeft - Math.round(16 * scale) - reserved;

  // Event blocks — detect overlaps and arrange side by side
  const visible = spec.events.filter(
    (e) => e.endTime.getTime() > w.startMs && e.startTime.getTime() < w.endMs
  );
  for (const { evt, y1, y2, col, totalCols } of computeTimelineLayout(
    visible,
    w.startMs,
    w.endMs,
    w.areaTop,
    w.areaH
  )) {
    const colW = eventW / Math.max(totalCols, 1);
    drawEventBlock({
      tc: f.tc,
      T: spec.theme,
      evt,
      timezone: spec.timezone,
      scale,
      ex: eventLeft + col * colW,
      ew: colW - 2 /* 2px gap between columns */,
      y1,
      blockH: Math.max(y2 - y1, 5) /* minimum 5px visible */,
    });
  }

  return closeFrame(spec, f);
}

/* ── Stacked layout ───────────────────────────────────────────── */

/** The rule at the head of a run of cards on a new day. Returns the new y. */
function drawDaySeparator(
  spec: FrameSpec,
  f: Frame,
  evt: DisplayEvent,
  y: number,
  pad: number
): number {
  const { ctx, tc, scale } = f;
  const label = format(new TZDate(evt.startTime, spec.timezone), "EEEE, d. MMM", {
    locale: f.dateLocale,
  });
  const labelW = textWidth(tc, label, "sm");
  text(tc, pad, y + Math.round(12 * scale), label, "sm", spec.theme.slotSecondary);
  ctx.fillStyle = spec.theme.slotSecondary;
  ctx.fillRect(
    pad + labelW + Math.round(8 * scale),
    y + Math.round(8 * scale),
    spec.width - 2 * pad - labelW - Math.round(8 * scale),
    1
  );
  return y + Math.round(30 * scale);
}

/**
 * One booking as a card.
 *
 * Two lines, filled by the SAME rule the timeline block uses, which is the point
 * of this change. Before it, a card drew the time on line one and the subject on
 * line two and never named the occupant at all, so on a stacked room display the
 * person was visible only when the provider happened to put the name in the
 * subject: anny does, Microsoft 365 does not, because there the subject is the
 * meeting's title.
 *
 * The time therefore moves to the right end of line one, where the timeline block
 * has always kept it, and costs no line of its own.
 */
function drawCard(spec: FrameSpec, f: Frame, evt: DisplayEvent, y: number, pad: number): void {
  const { ctx, tc, scale } = f;
  const T = spec.theme;
  const cardH = Math.round(70 * scale);
  const inner = pad + Math.round(12 * scale);

  const isNow =
    evt.startTime.getTime() <= spec.now.getTime() && evt.endTime.getTime() > spec.now.getTime();
  const cardBg = isNow ? T.busyBadge : T.eventBg;
  const cardText = readableOn(cardBg, isNow ? T.badgeText : T.slotText);
  const cardSecondary = readableOn(cardBg, isNow ? T.badgeText : T.slotSecondary);
  ctx.fillStyle = cardBg;
  ctx.fillRect(pad, y, spec.width - 2 * pad, cardH);

  const timeStr = `${fmtTime(evt.startTime, spec.timezone)} – ${fmtTime(evt.endTime, spec.timezone)}`;
  const timeW = textWidth(tc, timeStr, "md");
  const firstLine = y + Math.round(26 * scale);
  text(tc, spec.width - inner, firstLine, timeStr, "md", cardText, "right");

  const plan = planBlockText(evt.displaySubject, evt.organizer, 2);
  const primaryMaxW = spec.width - 2 * inner - timeW - Math.round(12 * scale);
  text(tc, inner, firstLine, plan.primary, "md-bold", cardText, "left", primaryMaxW);
  if (plan.secondary) {
    text(
      tc,
      inner,
      y + Math.round(52 * scale),
      plan.secondary,
      "sm",
      cardSecondary,
      "left",
      spec.width - 2 * inner
    );
  }
}

/** The agenda view: the next bookings as cards, newest first. */
export function renderStacked(spec: FrameSpec): Canvas {
  const f = openFrame(spec);
  const { scale } = f;
  const pad = Math.round(16 * scale);
  const cardH = Math.round(70 * scale);
  const reserved = qrShown(spec) ? Math.max(Math.round(234 * scale), 158) : 0;
  const bottom = spec.height - Math.round(40 * scale) - reserved;

  const upcoming = spec.events
    .filter((e) => e.endTime.getTime() > spec.now.getTime())
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  let y = f.headerH + Math.round(24 * scale);
  let lastDay = "";
  for (const evt of upcoming) {
    if (y + cardH > bottom) break;
    const day = format(new TZDate(evt.startTime, spec.timezone), "yyyy-MM-dd");
    if (day !== lastDay && lastDay !== "") y = drawDaySeparator(spec, f, evt, y, pad);
    lastDay = day;
    drawCard(spec, f, evt, y, pad);
    y += cardH + Math.round(10 * scale);
  }

  return closeFrame(spec, f);
}

/**
 * Everything a room display needs in order to be drawn.
 *
 * Two fields are here because they are facts about the MOMENT rather than about
 * the panel, and resolving them needs the raw fetch that `draw` no longer has.
 * `isRoomFree` cannot be recovered from `events`, because the "Hide All" policy
 * returns an empty list for a room that is fully booked. `offline` records that
 * the provider could not be reached, which used to be an early return in the
 * middle of the render.
 */
export interface RoomModel {
  config: RoomBookingConfig;
  /** The room's own zone if it names one, else the display's. */
  timezone: string;
  /** The instant the frame depicts. Data, not a clock read. */
  now: Date;
  events: DisplayEvent[];
  bookingUrl: string | null;
  isRoomFree: boolean;
  offline: boolean;
  /** Derived from raw events before privacy policy filtering. */
  nextEventStart?: Date | null;
}

export async function loadRoomModel(params: LoadParams): Promise<RoomModel> {
  const cfg = roomBookingConfigSchema.parse(params.config);

  /* The room's own zone wins when it is set; otherwise the display's zone, from
   * its device override or its site. Read from the RAW config rather than the
   * parsed one, because the schema defaults timezone to "UTC" and a parsed value
   * can no longer tell "unset" from "explicitly UTC". Without this the clock on
   * screen could disagree with the schedule that decided when to draw it. */
  const rawTimezone = (params.config as { timezone?: unknown } | null)?.timezone;
  const timezone =
    typeof rawTimezone === "string" && rawTimezone.trim()
      ? rawTimezone
      : (params.timezone ?? cfg.timezone);

  const base = {
    config: cfg,
    timezone,
    now: params.now,
    bookingUrl: null,
    nextEventStart: null,
  };

  let events: CalendarEvent[];
  try {
    events = await fetchEvents(cfg);
  } catch (err) {
    log.warn("Room-booking fetch failed", { error: String(err) });
    return { ...base, events: [], isRoomFree: false, offline: true };
  }

  let bookingUrl: string | null = null;
  try {
    bookingUrl = await resolveBookingUrl(cfg);
  } catch (err) {
    // A missing public booking link must never take the room display offline.
    log.warn("Room-booking QR URL resolution failed", { error: String(err) });
  }

  return {
    ...base,
    bookingUrl,
    events: applyRoomPolicy(events, cfg.policy as RoomPolicy, cfg.locale),
    isRoomFree: !events.some(
      (e) =>
        e.startTime.getTime() <= params.now.getTime() && e.endTime.getTime() > params.now.getTime()
    ),
    nextEventStart:
      events
        .filter((event) => event.startTime.getTime() > params.now.getTime())
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())[0]?.startTime ?? null,
    offline: false,
  };
}

/** The model, arranged as a frame the layouts understand. */
function frameSpecOf(
  model: RoomModel,
  params: DrawParams,
  bookingQr: BookingQrRenderOptions | undefined
): FrameSpec {
  const { config: cfg } = model;
  return {
    events: model.events,
    roomName: cfg.roomName,
    timezone: model.timezone,
    now: model.now,
    theme: params.theme,
    width: params.display.width,
    height: params.display.height,
    colorCount: params.display.colorCount,
    colorMode: params.display.colorMode,
    locale: cfg.locale,
    dateFormat: cfg.dateFormat,
    timelineShiftH: cfg.timelineShiftH,
    bookingQr,
    surface: params.surface,
  };
}

export function drawRoom(model: RoomModel, params: DrawParams): DrawResult {
  const { config: cfg } = model;

  if (model.offline) {
    return {
      canvas: renderOffline({
        roomName: cfg.roomName,
        now: model.now,
        theme: params.theme,
        width: params.display.width,
        height: params.display.height,
        locale: cfg.locale,
        surface: params.surface,
      }),
    };
  }

  const bookingQr: BookingQrRenderOptions | undefined = model.bookingUrl
    ? {
        url: model.bookingUrl,
        visibility: cfg.bookingQr.visibility,
        isRoomFree: model.isRoomFree,
      }
    : undefined;

  const spec = frameSpecOf(model, params, bookingQr);
  return {
    canvas: cfg.layout === "stacked" ? renderStacked(spec) : renderTimeline(spec),
    nextEventStart: model.nextEventStart ?? null,
  };
}

export const roomBookingRenderer: ContentRenderer<RoomModel> = {
  slug: "room-booking",
  name: "Room Booking",
  configSchema: roomBookingConfigSchema,

  load: loadRoomModel,
  draw: drawRoom,
};
