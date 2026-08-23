// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Name plate — a door sign the operator does not have to lay out.
 *
 * The operator supplies up to four seats; everything else is computed from the
 * seat count and the panel. There is no editor, no absolute box position and no
 * per-geometry design, which is the whole reason this type exists beside
 * `door-sign`: a fraction-of-width layout cannot survive a change of aspect
 * ratio, and `door-sign`'s answer to that is a hand-made design per display size.
 *
 * Two typography paths, because the panels differ in kind:
 *
 *   VECTOR panels (mono e-paper, 16-gray, LCD) get a size fitted to the longest
 *   name, which is what makes a plate readable across a room.
 *
 *   The INDEXED panel (E1002, six colours) cannot: vector antialiasing dithers
 *   badly on a six-colour palette, so it draws from a pre-generated bitmap atlas
 *   that has four fixed sizes. The plate picks the largest that fits and stops
 *   there. Raising that ceiling means extending the atlas, which has no
 *   generator committed — a separate job, deliberately not done here.
 */

import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { TZDate } from "@date-fns/tz";
import { getCalendarProvider } from "@/lib/calendar/registry";
import { getProviderWithCredentials } from "@/lib/providers";
import { TtlCache } from "@/lib/cache";
import { drawBitmapText, measureBitmapText, type BitmapFontSize } from "@/lib/render/bitmap-text";
import { ensureRenderFonts } from "@/lib/render/fonts";
import type { CalendarEvent } from "@/lib/calendar/types";
import type { ContentRenderer, RenderParams, RenderResult } from "../types";
import { namePlateConfigSchema, type NamePlateConfig, type Seat } from "./name-plate-types";
import {
  seatBands,
  bandContent,
  bandLineCount,
  fitSharedSize,
  type BandContent,
  type Rect,
} from "./name-plate-layout";

/* The atlas sizes, largest last. The plate walks this backwards to find the
 * biggest one that fits, which is the indexed panel's version of fitting. */
const ATLAS_STEPS: readonly { key: BitmapFontSize; px: number }[] = [
  { key: "sm", px: 16 },
  { key: "md", px: 24 },
  { key: "md-bold", px: 24 },
  { key: "lg-bold", px: 32 },
] as const;

/* ── Occupancy ────────────────────────────────────────────────── */

const BOOKING_CACHE_TTL_MS = 60_000;
const bookingCache = new TtlCache<CalendarEvent[]>(BOOKING_CACHE_TTL_MS);

interface ResolvedSeat {
  name: string;
  status: string | null;
}

async function fetchDayEvents(
  providerId: string,
  resourceId: string,
  resourceName: string | undefined,
  now: Date,
  timezone: string
): Promise<CalendarEvent[]> {
  const key = `name-plate:${providerId}:${resourceId}`;
  const cached = bookingCache.get(key);
  if (cached) return cached;

  const provider = await getProviderWithCredentials(providerId);
  const impl = getCalendarProvider(provider.type);
  if (!impl) throw new Error(`No implementation for provider type: ${provider.type}`);

  const zoned = new TZDate(now, timezone);
  const dayStart = new TZDate(
    zoned.getFullYear(),
    zoned.getMonth(),
    zoned.getDate(),
    0,
    0,
    0,
    timezone
  );
  const dayEnd = new TZDate(
    zoned.getFullYear(),
    zoned.getMonth(),
    zoned.getDate() + 1,
    0,
    0,
    0,
    timezone
  );

  const events = await impl.fetchEvents({
    credentials: provider.credentials,
    roomConfig: { resourceId, resourceName },
    windowStart: dayStart,
    windowEnd: dayEnd,
  });
  bookingCache.set(key, events);
  return events;
}

/**
 * Resolve one seat to the two strings a band can draw.
 *
 * A provider that cannot be reached must not blank the plate: the caption and,
 * for a static seat, the name are local knowledge and stay correct regardless.
 * A calendar seat falls back to its own resource name so the band still says
 * WHICH place it is, and reports no occupant rather than claiming it is free.
 */
async function resolveSeat(
  seat: Seat,
  now: Date,
  timezone: string,
  locale: string,
  labels: { free: string; busy: string; unknown: string }
): Promise<ResolvedSeat> {
  if (seat.occupant.kind === "static") {
    return { name: seat.occupant.name, status: null };
  }

  const { providerId, resourceId, resourceName } = seat.occupant;
  try {
    const events = await fetchDayEvents(providerId, resourceId, resourceName, now, timezone);
    const current = events.find((e) => now >= e.startTime && now < e.endTime);
    if (!current) {
      return { name: resourceName ?? resourceId, status: labels.free };
    }
    const who = current.isPrivate ? labels.busy : current.organizer || current.subject;
    const until = current.endTime.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    });
    return { name: who, status: `${labels.busy} · ${until}` };
  } catch {
    return { name: resourceName ?? resourceId, status: labels.unknown };
  }
}

/* ── Drawing ──────────────────────────────────────────────────── */

interface TypeCtx {
  ctx: SKRSContext2D;
  useBitmap: boolean;
  ff: string;
}

/**
 * How much vertical room one line occupies, as a fraction of its size.
 *
 * This is not one number, because the two drawing paths place a glyph
 * differently and laying out in the wrong unit makes lines collide.
 *
 * VECTOR text is drawn from its alphabetic baseline, so a line occupies about
 * its cap height and centring on the em would push the block down by the
 * descender — visible on a single large name.
 *
 * BITMAP text takes `y` as a baseline too, but `drawBitmapText` then positions
 * the glyph box by the FULL em (`baseY = y - variant.size`). A cap-height layout
 * therefore reserves less than the atlas actually draws, and on a two-line band
 * the name climbed into the caption above it. Measured, not reasoned: the first
 * indexed render showed the two overlapping.
 */
function lineRatio(t: TypeCtx): number {
  return t.useBitmap ? 1 : 0.72;
}

/**
 * The atlas step a requested size actually becomes on the indexed panel.
 *
 * The layout must then use `px`, not what it asked for: the atlas has four sizes,
 * so a request for 13 px is DRAWN at 16, and spacing computed from 13 leaves the
 * lines too close. Returns the largest step not exceeding the request, or the
 * smallest step when even that is too big — a name has to be drawn somehow.
 */
function atlasStep(size: number, bold: boolean): { key: BitmapFontSize; px: number } {
  const fitting = (pool: readonly { key: BitmapFontSize; px: number }[]) =>
    pool.filter((s) => s.px <= size).sort((a, b) => b.px - a.px)[0];

  if (bold) {
    const boldFit = fitting(ATLAS_STEPS.filter((s) => s.key.endsWith("bold")));
    if (boldFit) return boldFit;
    /* No bold step is small enough. Prefer a LIGHTER weight at a size that fits
     * over a bold one that gets clipped: the name is the payload, and the
     * smallest bold variant is 24 px, so insisting on weight would cut long
     * names on the indexed panel outright. */
    const anyFit = fitting(ATLAS_STEPS);
    if (anyFit) return anyFit;
  } else {
    const fit = fitting(ATLAS_STEPS);
    if (fit) return fit;
  }
  /* Nothing fits at all; draw at the smallest the atlas has and let the width
   * limit clip, which is still more legible than nothing. */
  return ATLAS_STEPS.reduce((a, b) => (a.px <= b.px ? a : b));
}

/** Size a line will really be drawn at, which is what the layout must use. */
function effectiveSize(t: TypeCtx, size: number, bold: boolean): number {
  return t.useBitmap ? atlasStep(size, bold).px : size;
}

function measureAt(t: TypeCtx, text: string, size: number): number {
  if (t.useBitmap) return measureBitmapText(text, atlasStep(size, true).key);
  t.ctx.font = `bold ${size}px ${t.ff}`;
  return t.ctx.measureText(text).width;
}

/** Draw one line centred horizontally, with `baseline` as its baseline. */
function drawCentred(
  t: TypeCtx,
  text: string,
  cx: number,
  baseline: number,
  size: number,
  color: string,
  bold: boolean,
  maxWidth: number
): void {
  if (t.useBitmap) {
    const step = atlasStep(size, bold);
    const w = measureBitmapText(text, step.key);
    drawBitmapText(t.ctx, text, cx - w / 2, baseline, step.key, color, maxWidth);
    return;
  }
  t.ctx.font = `${bold ? "bold " : ""}${size}px ${t.ff}`;
  t.ctx.fillStyle = color;
  t.ctx.textAlign = "center";
  t.ctx.textBaseline = "alphabetic";
  t.ctx.fillText(text, cx, baseline, maxWidth);
  t.ctx.textAlign = "left";
}

/**
 * Compose one band from whatever it has.
 *
 * The lines are stacked and the block is centred in the band, so a one-line band
 * and a three-line band both sit optically in the middle of their share. Nothing
 * reserves space for a line it does not draw — which is the rule for a static
 * seat's missing status: it gets a bigger share of its band, not a gap.
 */
function drawBand(
  t: TypeCtx,
  band: Rect,
  content: BandContent,
  sizes: { name: number; caption: number; status: number },
  colors: { name: string; caption: string; status: string }
): void {
  const lines: { text: string; size: number; drawn: number; color: string; bold: boolean }[] = [];
  const push = (text: string, size: number, color: string, bold: boolean) =>
    lines.push({ text, size, drawn: effectiveSize(t, size, bold), color, bold });

  if (content.caption) push(content.caption, sizes.caption, colors.caption, false);
  push(content.name, sizes.name, colors.name, true);
  if (content.status) push(content.status, sizes.status, colors.status, false);

  /* Tight, because the caption and the status belong to the NAME between them,
   * not to the neighbouring band. Proximity is the only thing grouping them, so
   * this gap has to stay clearly smaller than the space between bands. */
  const gap = Math.round(sizes.caption * 0.22);
  /* Whatever unit this drawing path actually consumes; see lineRatio(). */
  const ratio = lineRatio(t);
  const capHeights = lines.map((l) => l.drawn * ratio);
  const blockH = capHeights.reduce((a, b) => a + b, 0) + gap * Math.max(0, lines.length - 1);

  let y = band.y + (band.h - blockH) / 2;
  const cx = band.x + band.w / 2;

  lines.forEach((line, i) => {
    /* y is the cap TOP of this line, so the baseline sits one cap height below. */
    drawCentred(
      t,
      line.text,
      cx,
      Math.round(y + capHeights[i]),
      line.size,
      line.color,
      line.bold,
      band.w
    );
    y += capHeights[i] + gap;
  });
}

/**
 * A hairline between bands.
 *
 * Without it a four-seat plate is eight centred lines whose grouping the reader
 * has to infer from spacing alone, and spacing alone was not enough: a caption
 * sat about as far from its own name as from the name above it. The rule costs
 * one pixel row and removes the ambiguity outright, which matters more on a
 * 1-bit panel than any amount of extra white space would.
 */
function drawSeparators(ctx: SKRSContext2D, bands: Rect[], color: string, scale: number): void {
  if (bands.length < 2) return;
  const thickness = Math.max(1, Math.round(scale));
  ctx.fillStyle = color;
  for (let i = 1; i < bands.length; i++) {
    const y = Math.round((bands[i - 1].y + bands[i - 1].h + bands[i].y) / 2);
    /* Inset so the rule reads as a divider between entries rather than a frame. */
    const inset = Math.round(bands[i].w * 0.08);
    ctx.fillRect(bands[i].x + inset, y, bands[i].w - inset * 2, thickness);
  }
}

/* ── Renderer ─────────────────────────────────────────────────── */

async function render(params: RenderParams): Promise<RenderResult> {
  const config: NamePlateConfig = namePlateConfigSchema.parse(params.config);
  const { width, height, colorMode } = params.display;
  const T = params.theme;
  const timezone = config.timezone ?? params.timezone ?? "UTC";
  const locale = config.locale;

  const labels = statusLabels(locale);
  const resolved = await Promise.all(
    config.seats.map((s) => resolveSeat(s, params.now, timezone, locale, labels))
  );
  const contents = config.seats.map((seat, i) => bandContent(seat, resolved[i], config.showStatus));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const useBitmap = colorMode === "indexed";
  ctx.imageSmoothingEnabled = !useBitmap;

  ctx.fillStyle = T.background;
  ctx.fillRect(0, 0, width, height);

  const shortSide = Math.min(width, height);
  const pad = Math.round(shortSide * 0.06);
  const bands = seatBands(config.seats.length, width, height, pad);
  const t: TypeCtx = { ctx, useBitmap, ff: ensureRenderFonts() };

  /* Every band is the same height, so the tightest constraint is the band with
   * the MOST lines: sizing against the average would clip it. */
  const maxLines = Math.max(...contents.map(bandLineCount));
  const bandH = bands[0]?.h ?? height;
  /* Caption and status are secondary and sized off the name, so only one search
   * is needed. 0.62 keeps them clearly subordinate while staying legible. */
  const nameShare = maxLines === 1 ? 0.72 : maxLines === 2 ? 0.5 : 0.4;

  const nameSize = fitSharedSize({
    texts: contents.map((c) => c.name),
    /* 0.90, not 0.96: type running to within two percent of the band edge reads
     * as cramped on a physical sign, where the bezel is already right there. */
    maxWidth: (bands[0]?.w ?? width) * 0.9,
    maxHeight: Math.floor(bandH * nameShare),
    measure: (text, size) => measureAt(t, text, size),
    min: Math.max(12, Math.round(shortSide * 0.03)),
    max: useBitmap ? 32 : Math.round(shortSide * 0.5),
  });

  const sizes = {
    name: nameSize,
    caption: Math.max(11, Math.round(nameSize * 0.36)),
    status: Math.max(11, Math.round(nameSize * 0.36)),
  };
  const colors = {
    name: T.footerText,
    caption: T.slotSecondary,
    status: T.footerText,
  };

  drawSeparators(ctx, bands, T.slotSecondary, shortSide / 480);
  bands.forEach((band, i) => drawBand(t, band, contents[i], sizes, colors));

  return { canvas };
}

/**
 * Status wording, kept here rather than in the shared i18n messages.
 *
 * Those messages are for the admin UI and are loaded by a React provider; a
 * renderer runs on the server for a device whose locale is its own config field.
 * Three strings do not justify wiring a second loader, and the room-booking
 * renderer already carries its labels the same way.
 */
function statusLabels(locale: string): { free: string; busy: string; unknown: string } {
  const lang = locale.slice(0, 2).toLowerCase();
  switch (lang) {
    case "de":
      return { free: "Frei", busy: "Belegt", unknown: "Keine Verbindung" };
    case "fr":
      return { free: "Libre", busy: "Occupé", unknown: "Hors ligne" };
    case "es":
      return { free: "Libre", busy: "Ocupado", unknown: "Sin conexión" };
    case "it":
      return { free: "Libero", busy: "Occupato", unknown: "Non connesso" };
    default:
      return { free: "Free", busy: "Busy", unknown: "Offline" };
  }
}

export const namePlateRenderer: ContentRenderer = {
  slug: "name-plate",
  name: "Name plate",
  configSchema: namePlateConfigSchema,
  render,
};
