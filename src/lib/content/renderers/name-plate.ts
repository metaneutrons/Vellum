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
 * Type is fitted to the longest name on EVERY panel, including the six-colour
 * E1002. An earlier version drew that model from the pre-generated bitmap atlas,
 * on the assumption that vector antialiasing dithers badly on six colours — and
 * the atlas stops at 32 px, so a name plate there used a fraction of its panel.
 * The assumption does not hold for the path this actually goes through:
 * `canvasToPixelBuffer` quantises indexed output with nearestColorQuantize, not
 * Floyd-Steinberg, so an antialiased grey edge snaps hard to black or white
 * instead of dithering. Rendered and quantised at 16, 28, 60 and 96 px, the
 * result is clean at all of them.
 */

import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { TZDate } from "@date-fns/tz";
import { getCalendarProvider } from "@/lib/calendar/registry";
import { getProviderWithCredentials } from "@/lib/providers";
import { TtlCache } from "@/lib/cache";
import { ensureRenderFonts } from "@/lib/render/fonts";
import type { CalendarEvent } from "@/lib/calendar/types";
import type { ContentRenderer, RenderParams, RenderResult } from "../types";
import {
  namePlateConfigSchema,
  resolveRoomName,
  type NamePlateConfig,
  type Seat,
} from "./name-plate-types";
import {
  seatBands,
  bandContent,
  bandLineCount,
  type SeatState,
  fitSharedSize,
  type BandContent,
  type Rect,
} from "./name-plate-layout";

/* ── Occupancy ────────────────────────────────────────────────── */

const BOOKING_CACHE_TTL_MS = 60_000;
const bookingCache = new TtlCache<CalendarEvent[]>(BOOKING_CACHE_TTL_MS);

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
  labels: { free: string; busy: string; unknown: string; until: string }
): Promise<SeatState> {
  if (seat.occupant.kind === "static") {
    /* A fixed name is always the occupant; there is no place label to fall back
     * to and no state to report. */
    return { occupant: seat.occupant.name };
  }

  const { providerId, resourceId, resourceName } = seat.occupant;
  const placeLabel = resourceName ?? resourceId;
  try {
    const events = await fetchDayEvents(providerId, resourceId, resourceName, now, timezone);
    const current = events.find((e) => now >= e.startTime && now < e.endTime);
    if (!current) return { occupant: null, placeLabel };

    const who = current.isPrivate ? labels.busy : current.organizer || current.subject;
    const until = current.endTime.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
    });
    return { occupant: who, placeLabel, detail: `${labels.until} ${until}` };
  } catch {
    return { occupant: null, placeLabel, unreachable: true };
  }
}

/* ── Drawing ──────────────────────────────────────────────────── */

interface TypeCtx {
  ctx: SKRSContext2D;
  ff: string;
}

/**
 * Vertical room one line occupies, as a fraction of its size.
 *
 * Cap height, because vector text is drawn from its alphabetic baseline: centring
 * on the em would push a block down by the descender, which on a single large
 * name is visible.
 */
const CAP_RATIO = 0.72;

function measureAt(t: TypeCtx, text: string, size: number): number {
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
  const lines: { text: string; size: number; color: string; bold: boolean }[] = [];
  const push = (text: string, size: number, color: string, bold: boolean) =>
    lines.push({ text, size, color, bold });

  if (content.caption) push(content.caption, sizes.caption, colors.caption, false);
  if (content.nameIsNotice) {
    /* Small and muted: a note about the sign, not the content of the sign. */
    push(content.name, sizes.status, colors.status, false);
  } else {
    push(content.name, sizes.name, colors.name, true);
  }
  /* Below the name, at caption size and in the caption colour: unit and position
   * describe the occupant the same way the caption describes the place, so they
   * are the same rank of information and are set alike. */
  if (content.affiliation) push(content.affiliation, sizes.caption, colors.caption, false);
  if (content.status) push(content.status, sizes.status, colors.status, false);

  /* Tight, because the caption, the affiliation and the status all belong to the
   * NAME they surround rather than to the neighbouring band. Proximity is the only
   * thing grouping them, so these gaps stay clearly smaller than the space between
   * bands.
   *
   * One gap PER PAIR, not one for the block. The base is measured off the name,
   * which is large enough to clear a caption's descender: laid out in cap heights,
   * a caption ending in ")" or "," hangs below its own box and used to collide
   * with the cap of the name beneath it.
   *
   * That base is not enough UNDER the name. A descender reaches roughly 0.21 em
   * below its baseline, which at 0.14 of the name is more than the whole gap, so a
   * name like "Krüger" would have run into the unit line below it. Taking the
   * larger of the two clearances fixes that pair and leaves every other pair
   * exactly where it was, because 0.3 of a caption is smaller than 0.14 of the
   * name it sits beside. */
  const baseGap = Math.round(sizes.name * 0.14);
  const gapAfter = (size: number) => Math.max(baseGap, Math.round(size * 0.3));
  const capHeights = lines.map((l) => l.size * CAP_RATIO);
  const gaps = lines.slice(0, -1).map((l) => gapAfter(l.size));
  const blockH = capHeights.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);

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
    y += capHeights[i] + (gaps[i] ?? 0);
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
  const contents = config.seats.map((seat, i) =>
    bandContent(seat, resolved[i], config.showStatus, labels)
  );

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  /* Mirrors room-booking. This governs IMAGE scaling, not text antialiasing, and
   * this renderer draws no images -- kept only so the two behave alike if one
   * ever does. */
  ctx.imageSmoothingEnabled = colorMode !== "indexed";

  ctx.fillStyle = T.background;
  ctx.fillRect(0, 0, width, height);

  const shortSide = Math.min(width, height);
  const pad = Math.round(shortSide * 0.06);
  const scale = shortSide / 480;
  const t: TypeCtx = { ctx, ff: ensureRenderFonts() };

  /* A door sign says WHERE it is before it says who is inside, and it says it the
   * way the room-booking display does: same bar, same height, same weight, so a
   * corridor of both kinds looks like one system rather than two products. */
  const room = resolveRoomName(config);
  const headerH = room ? Math.round(75 * scale) : 0;
  if (room) {
    ctx.fillStyle = T.headerBg;
    ctx.fillRect(0, 0, width, headerH);
    const roomSize = fitSharedSize({
      texts: [room],
      maxWidth: width - Math.round(32 * scale),
      maxHeight: Math.round(headerH * 0.42),
      measure: (text, size) => measureAt(t, text, size),
      min: 12,
      max: Math.round(34 * scale),
    });
    drawCentred(
      t,
      room,
      width / 2,
      Math.round(headerH / 2 + roomSize * CAP_RATIO * 0.5),
      roomSize,
      T.headerText,
      true,
      width - Math.round(32 * scale)
    );
  }

  const bands = seatBands(config.seats.length, width, height, pad, headerH);

  /* Every band is the same height, so the tightest constraint is the band with
   * the MOST lines: sizing against the average would clip it. */
  const maxLines = Math.max(...contents.map(bandLineCount));
  const bandH = bands[0]?.h ?? height;
  /* The name's share of its band, by how many lines the FULLEST band draws.
   *
   * A table rather than a chain of ternaries, because a band can now carry four
   * lines: caption, name, affiliation, status. The shares fall away faster than
   * 1/n on purpose — the name keeps more than its arithmetic share, since it is
   * the only line that has to be readable from down the corridor. */
  const NAME_SHARE = [0.72, 0.5, 0.4, 0.34];
  const nameShare = NAME_SHARE[Math.min(maxLines, NAME_SHARE.length) - 1];

  /* Notices are excluded from the fit: "Keine Verbindung" is longer than any name
   * and would otherwise decide the size for every band, so one unreachable seat
   * would shrink the names of the seats that can be reached.
   *
   * When EVERY band is a notice there is nothing left to measure, and an empty
   * list makes the search return its ceiling — which blew the captions up to fill
   * a plate that has nothing to say. Fall back to measuring the notices then. */
  const names = contents.filter((c) => !c.nameIsNotice).map((c) => c.name);
  const nameSize = fitSharedSize({
    texts: names.length ? names : contents.map((c) => c.name),
    /* 0.90, not 0.96: type running to within two percent of the band edge reads
     * as cramped on a physical sign, where the bezel is already right there. */
    maxWidth: (bands[0]?.w ?? width) * 0.9,
    maxHeight: Math.floor(bandH * nameShare),
    measure: (text, size) => measureAt(t, text, size),
    min: Math.max(12, Math.round(shortSide * 0.03)),
    max: Math.round(shortSide * 0.5),
  });

  /* The secondary lines get their own fit, bounded by a fraction of the name.
   *
   * Deriving it from the name alone went wrong in the common single-seat case: a
   * short name like "Frei" allows a huge size, and a caption at a third of that
   * is "Föhr 1 (1J.2.27)" running nearly the full width while the name sits
   * compact in the middle. The longest string on the plate was the subordinate
   * one. Fitting it to the width it actually has, and never letting it past 34 %
   * of the name, keeps the hierarchy the way round it is meant to be.
   *
   * Captions and affiliations are measured TOGETHER because they are drawn at one
   * size. The affiliation is usually the longer of the two, and a line that is
   * drawn without being measured does not overflow — fillText squeezes it to the
   * width it was given, which is worse, because condensed text among normal text
   * looks like a rendering fault. */
  const secondary = contents
    .flatMap((c) => [c.caption, c.affiliation])
    .filter((v): v is string => !!v);
  const captionCeiling = Math.round(nameSize * 0.34);
  const captionSize = secondary.length
    ? Math.min(
        captionCeiling,
        fitSharedSize({
          texts: secondary,
          maxWidth: (bands[0]?.w ?? width) * 0.9,
          maxHeight: captionCeiling,
          measure: (text, size) => measureAt(t, text, size),
          min: 11,
          max: captionCeiling,
        })
      )
    : captionCeiling;

  const sizes = {
    name: nameSize,
    caption: Math.max(11, captionSize),
    status: Math.max(11, captionSize),
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
function statusLabels(locale: string): {
  free: string;
  busy: string;
  unknown: string;
  until: string;
} {
  const lang = locale.slice(0, 2).toLowerCase();
  switch (lang) {
    case "de":
      return { free: "Frei", busy: "Belegt", unknown: "Keine Verbindung", until: "bis" };
    case "fr":
      return { free: "Libre", busy: "Occupé", unknown: "Hors ligne", until: "jusqu'à" };
    case "es":
      return { free: "Libre", busy: "Ocupado", unknown: "Sin conexión", until: "hasta" };
    case "it":
      return { free: "Libero", busy: "Occupato", unknown: "Non connesso", until: "fino a" };
    default:
      return { free: "Free", busy: "Busy", unknown: "Offline", until: "until" };
  }
}

export const namePlateRenderer: ContentRenderer = {
  slug: "name-plate",
  name: "Name plate",
  configSchema: namePlateConfigSchema,
  render,
};
