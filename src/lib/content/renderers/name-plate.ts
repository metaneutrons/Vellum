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
import type { Theme } from "@/lib/theme";
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
import { drawQrMatrix, shouldShowBookingQr } from "./booking-qr";
import type { NameRanks } from "./name-split";

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
  labels: StatusLabels
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
    return { ...stateFromEvent(current, placeLabel, timezone, locale, labels), placeLabel };
  } catch {
    return { occupant: null, placeLabel, unreachable: true };
  }
}

/**
 * The seat state a current booking produces.
 *
 * The `labels.busy` fallback on an empty organizer AND subject is load-bearing,
 * not defensive padding: an empty string is falsy, so `bandContent` would have
 * read it as "nobody is here" and drawn "Frei" on a desk that is taken. A public
 * booking with neither field filled is rare but entirely legal in every provider
 * here, and saying the wrong thing is worse than saying nothing.
 */
function stateFromEvent(
  event: CalendarEvent,
  placeLabel: string,
  timezone: string,
  locale: string,
  labels: StatusLabels
): SeatState {
  const who = event.isPrivate ? labels.busy : event.organizer || event.subject || labels.busy;
  const until = event.endTime.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });
  /* Only when the provider separated the two itself, and only for a real person:
   * a private booking shows the word for "busy", and splitting that into a given
   * name and a surname would be nonsense. */
  const ranks =
    !event.isPrivate && event.organizerSurname
      ? { titles: "", given: event.organizerGiven ?? "", surname: event.organizerSurname }
      : undefined;
  return { occupant: who, ranks, placeLabel, detail: `${labels.until} ${until}` };
}

/* ── Drawing ──────────────────────────────────────────────────── */

export interface TypeCtx {
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
export const CAP_RATIO = 0.72;

/**
 * The surname's share of its band in STACKED mode, by how many lines the fullest
 * band stacks.
 *
 * Derived rather than chosen. A stack of n lines occupies
 * `sum(capHeights) + sum(gaps)`, which with the ratios below comes to 1.18 S for
 * two lines, 1.65 S for three, 2.03 S for four and 2.41 S for five, where S is
 * the surname size. Inverting each and keeping about a tenth in hand gives this
 * table. A first cut used round numbers 30 % under the limit, which cost the
 * four-line case 0.8 m of reading distance for nothing.
 */
const SURNAME_SHARE = [1.0, 0.75, 0.55, 0.44, 0.37];

/** The surname's share of its band in ROW mode, where there is one line. */
const ROW_SHARE = 0.8;

/** Size of the given-name rank, as a fraction of the surname's. */
const GIVEN_RATIO = 0.45;

/** Size of every secondary line (caption, titles, affiliation, pill). */
const SECONDARY_RATIO = 0.34;

/** Space between the surname and the given name beside it, in row mode. */
const ROW_NAME_GAP = 0.24;

export interface BandSizes {
  surname: number;
  given: number;
  secondary: number;
  /** Notices are subordinate to a name but must still be legible. See `planSizes`. */
  notice: number;
}

interface BandColors {
  name: string;
  secondary: string;
  pillBg: string;
  pillText: string;
}

function measureAt(t: TypeCtx, text: string, size: number, bold = true): number {
  t.ctx.font = `${bold ? "bold " : ""}${size}px ${t.ff}`;
  return t.ctx.measureText(text).width;
}

/**
 * Draw one line from its left edge, with `baseline` as its baseline.
 *
 * Left, everywhere, and that is a decision rather than a default. Four centred
 * names are four different line lengths with no shared edge, so the eye has to
 * find the start of each one; against a fixed left axis it returns to the same
 * place every time and the plate reads as a list. The cost is that a single name
 * on a wide panel no longer sits in the middle, which is the price of having one
 * layout instead of two.
 */
function drawLeft(
  t: TypeCtx,
  text: string,
  x: number,
  baseline: number,
  size: number,
  color: string,
  bold: boolean,
  maxWidth: number
): void {
  t.ctx.font = `${bold ? "bold " : ""}${size}px ${t.ff}`;
  t.ctx.fillStyle = color;
  t.ctx.textAlign = "left";
  t.ctx.textBaseline = "alphabetic";
  t.ctx.fillText(text, x, baseline, maxWidth);
}

/**
 * The state, as a filled block with the word inside it.
 *
 * A filled area is the only device that survives the distance at which the word
 * itself has stopped being legible, which is the whole argument for it: from ten
 * metres a person sees THAT the desk is taken, and from two they read until when.
 * Only an occupied seat gets one, so absence means free.
 *
 * Beside the name rather than under it, so it costs width and no height.
 */
function drawPill(
  t: TypeCtx,
  right: number,
  centerY: number,
  text: string,
  size: number,
  colors: BandColors
): void {
  const padX = Math.round(size * 0.55);
  const padY = Math.round(size * 0.34);
  const w = Math.round(measureAt(t, text, size) + padX * 2);
  const h = Math.round(size * CAP_RATIO + padY * 2);
  const x = Math.round(right - w);
  const y = Math.round(centerY - h / 2);

  t.ctx.fillStyle = colors.pillBg;
  t.ctx.fillRect(x, y, w, h);
  drawLeft(
    t,
    text,
    x + padX,
    Math.round(y + padY + size * CAP_RATIO),
    size,
    colors.pillText,
    true,
    w
  );
}

/**
 * A seat as a STACK: up to five lines, smallest ranks outward.
 *
 * Used where there is vertical room, which in practice is one or two seats. The
 * block is centred vertically in the band, so a two-line band and a five-line one
 * both sit optically in the middle of their share, and nothing reserves space for
 * a line it does not draw.
 */
function drawStack(
  t: TypeCtx,
  band: Rect,
  content: BandContent,
  sizes: BandSizes,
  colors: BandColors,
  stackWidth: number
): void {
  const lines: { text: string; size: number; color: string; bold: boolean }[] = [];
  const push = (text: string, size: number, color: string, bold: boolean) =>
    lines.push({ text, size, color, bold });

  if (content.caption) push(content.caption, sizes.secondary, colors.secondary, false);
  if (content.ranks) {
    /* Three ranks, smallest first. The surname is the payload and gets the whole
     * width; the titles and the given name are what used to consume it. */
    if (content.ranks.titles) push(content.ranks.titles, sizes.secondary, colors.secondary, false);
    if (content.ranks.given) push(content.ranks.given, sizes.given, colors.name, false);
    push(content.ranks.surname, sizes.surname, colors.name, true);
  } else if (content.notice) {
    /* Light weight, never bold: a statement about the sign is not a name, and the
     * weight is what says so before the size does. */
    push(content.notice, sizes.notice, colors.secondary, false);
  }
  if (content.affiliation) push(content.affiliation, sizes.secondary, colors.secondary, false);
  if (lines.length === 0) return;

  /* Tight, because the caption, the titles, the given name and the affiliation
   * all belong to the surname they surround rather than to the neighbouring band.
   * Proximity is the only thing grouping them, so these gaps stay clearly smaller
   * than the space between bands.
   *
   * One gap PER PAIR, not one for the block. The base is measured off the surname,
   * which is large enough to clear a caption's descender: laid out in cap heights,
   * a caption ending in ")" or "," hangs below its own box and used to collide
   * with the cap of the line beneath it.
   *
   * That base is not enough UNDER the surname. A descender reaches roughly 0.21 em
   * below its baseline, which at 0.14 of the surname is more than the whole gap,
   * so "Krüger" would have run into the unit line below it. Taking the larger of
   * the two clearances fixes that pair and leaves every other pair exactly where
   * it was, because 0.3 of a caption is smaller than 0.14 of the surname. */
  const baseGap = Math.round(sizes.surname * 0.14);
  const gapAfter = (size: number) => Math.max(baseGap, Math.round(size * 0.3));
  const capHeights = lines.map((l) => l.size * CAP_RATIO);
  const gaps = lines.slice(0, -1).map((l) => gapAfter(l.size));
  const blockH = capHeights.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);

  let y = band.y + (band.h - blockH) / 2;
  lines.forEach((line, i) => {
    /* y is the cap TOP of this line, so the baseline sits one cap height below. */
    drawLeft(
      t,
      line.text,
      band.x,
      Math.round(y + capHeights[i]),
      line.size,
      line.color,
      line.bold,
      stackWidth
    );
    y += capHeights[i] + (gaps[i] ?? 0);
  });
}

/**
 * A seat as a ROW: the seat label in a gutter, the name on one line beside it.
 *
 * Used from three seats up, where the stack stops working. The arithmetic is
 * blunt about why. On a 7.5" panel four bands are 61 px tall, a five-line stack
 * needs 2.41 surname-sizes, and the surname therefore lands at 22 px, or 3,2 mm of
 * cap height: a sign readable from 65 cm. One line at the same height reaches
 * three times that, because a short surname leaves horizontal room exactly where
 * the vertical room has run out.
 *
 * What is dropped is dropped deliberately, not for lack of a place to put it: the
 * titles and the affiliation. Fitting them in would halve the surname, which is
 * the one trade this whole design refuses. An operator who needs a unit or a
 * position on the sign is describing a plate with one or two seats.
 */
function drawRow(
  t: TypeCtx,
  band: Rect,
  content: BandContent,
  sizes: BandSizes,
  colors: BandColors,
  gutterW: number,
  nameWidth: number
): void {
  const centerY = band.y + band.h / 2;
  if (content.caption && gutterW > 0) {
    drawLeft(
      t,
      content.caption,
      band.x,
      Math.round(centerY + sizes.secondary * CAP_RATIO * 0.5),
      sizes.secondary,
      colors.secondary,
      false,
      gutterW
    );
  }

  const x = band.x + gutterW;
  if (content.ranks) {
    drawRowName(t, content.ranks, x, centerY, sizes, colors, nameWidth);
  } else if (content.notice) {
    drawLeft(
      t,
      content.notice,
      x,
      Math.round(centerY + sizes.notice * CAP_RATIO * 0.5),
      sizes.notice,
      colors.secondary,
      false,
      nameWidth
    );
  }
}

/** The surname, and the given name baseline-aligned beside it. */
function drawRowName(
  t: TypeCtx,
  ranks: NameRanks,
  x: number,
  centerY: number,
  sizes: BandSizes,
  colors: BandColors,
  nameWidth: number
): void {
  const baseline = Math.round(centerY + sizes.surname * CAP_RATIO * 0.5);
  drawLeft(t, ranks.surname, x, baseline, sizes.surname, colors.name, true, nameWidth);
  if (!ranks.given) return;
  /* The size search measured exactly this composition, surname plus gap plus
   * given name at its fraction, so the two cannot collide. */
  const gx =
    x + measureAt(t, ranks.surname, sizes.surname) + Math.round(sizes.surname * ROW_NAME_GAP);
  drawLeft(
    t,
    ranks.given,
    gx,
    baseline,
    sizes.given,
    colors.name,
    false,
    Math.max(0, x + nameWidth - gx)
  );
}

/**
 * A rule between bands.
 *
 * Without it a four-seat plate is a dozen lines whose grouping the reader has to
 * infer from spacing alone, and spacing alone was not enough: a caption sat about
 * as far from its own name as from the name above it.
 *
 * Two pixels minimum, not one. A 1-bit e-paper panel reaches roughly ten to one
 * in contrast rather than twenty-one, so a single-pixel rule is materially
 * fainter on the wall than in any preview, and on the two 7-inch panels the old
 * `scale` arithmetic rounded to exactly one.
 */
function drawSeparators(ctx: SKRSContext2D, bands: Rect[], color: string, scale: number): void {
  if (bands.length < 2) return;
  const thickness = Math.max(2, Math.round(2 * scale));
  ctx.fillStyle = color;
  for (let i = 1; i < bands.length; i++) {
    const y = Math.round((bands[i - 1].y + bands[i - 1].h + bands[i].y) / 2);
    ctx.fillRect(bands[i].x, y, bands[i].w, thickness);
  }
}

/* ── Type sizes ───────────────────────────────────────────────── */

/**
 * The largest surname size at which every band still fits.
 *
 * Notices are excluded, because "Keine Verbindung" is longer than any surname and
 * would otherwise decide the size for every band: one unreachable seat would
 * shrink the names of the seats that can be reached.
 *
 * Unless EVERY band is a notice, when there is nothing else to measure. The
 * notices are then fitted on their own but to a smaller share, because a plate
 * with nothing to say must not set "Frei" larger than any real name would be.
 *
 * In row mode the measurement is a COMPOSITION, not a string: the surname plus a
 * gap plus the given name at a fraction of the surname's size. The two are handed
 * to the search joined by a character that cannot occur in a name and split again
 * inside the measure, so the fit is exact. The alternative was to fit the surname
 * against a guessed fraction of the width and hope the given name fitted in what
 * was left.
 */
function fitSurname(
  t: TypeCtx,
  texts: {
    named: (BandContent & { ranks: NameRanks })[];
    notices: string[];
    contents: BandContent[];
  },
  opts: { rowMode: boolean; bandH: number; shortSide: number; nameWidth: number }
): number {
  const { named, notices, contents } = texts;
  const { rowMode, bandH, shortSide, nameWidth } = opts;
  const hasNames = named.length > 0;

  const measurePair = (text: string, size: number): number => {
    const [surname, given] = text.split(PAIR_SEP);
    let w = measureAt(t, surname, size);
    if (given) {
      w += Math.round(size * ROW_NAME_GAP) + measureAt(t, given, size * GIVEN_RATIO, false);
    }
    return w;
  };

  const share = rowMode
    ? ROW_SHARE
    : SURNAME_SHARE[Math.min(Math.max(...contents.map(bandLineCount)), SURNAME_SHARE.length) - 1];

  return fitSharedSize({
    texts: hasNames
      ? named.map((c) =>
          rowMode && c.ranks.given
            ? `${c.ranks.surname}${PAIR_SEP}${c.ranks.given}`
            : c.ranks.surname
        )
      : notices,
    maxWidth: nameWidth,
    maxHeight: Math.floor(bandH * (hasNames ? share : Math.min(share, 0.45))),
    measure: rowMode ? measurePair : (text, size) => measureAt(t, text, size),
    min: Math.max(12, Math.round(shortSide * 0.03)),
    max: Math.round(shortSide * 0.5),
  });
}

/**
 * The subordinate ranks, each fitted to the width it actually has and capped as a
 * fraction of the surname.
 *
 * Deriving them from the surname ALONE went wrong in the single-seat case: a short
 * surname allows a huge size, and a caption at a third of that is
 * "Föhr 1 (1J.2.27)" running the full width while the name sits compact beside it.
 * The longest string on the plate was the subordinate one.
 *
 * In row mode the caption lives in the gutter and is measured against IT, so it
 * never has to be squeezed, and the given name needs no fit of its own because
 * `fitSurname` already measured it as part of the composition. In stack mode
 * captions, titles and affiliations share one size and are measured together: a
 * line drawn without being measured does not overflow, it gets condensed by
 * fillText, which among normal text reads as a rendering fault.
 */
function fitSubordinates(
  t: TypeCtx,
  contents: BandContent[],
  opts: {
    rowMode: boolean;
    surnameSize: number;
    bandH: number;
    nameWidth: number;
    gutterW: number;
    scale: number;
  }
): { given: number; secondary: number } {
  const { rowMode, surnameSize, bandH, nameWidth, gutterW, scale } = opts;

  const fitUnder = (texts: string[], ceiling: number, maxWidth: number): number =>
    texts.length
      ? Math.min(
          ceiling,
          fitSharedSize({
            texts,
            maxWidth,
            maxHeight: ceiling,
            measure: (text, size) => measureAt(t, text, size, false),
            min: 10,
            max: ceiling,
          })
        )
      : ceiling;

  const givenCeiling = Math.max(12, Math.round(surnameSize * GIVEN_RATIO));
  const given = rowMode
    ? givenCeiling
    : fitUnder(contents.map((c) => c.ranks?.given ?? "").filter(Boolean), givenCeiling, nameWidth);

  const secondary = rowMode
    ? fitUnder(
        contents.map((c) => c.caption ?? "").filter(Boolean),
        Math.max(11, Math.round(bandH * 0.3)),
        Math.max(1, gutterW - Math.round(8 * scale))
      )
    : fitUnder(
        contents
          .flatMap((c) => [c.caption, c.affiliation, c.ranks?.titles ?? null])
          .filter((v): v is string => !!v),
        Math.max(11, Math.round(surnameSize * SECONDARY_RATIO)),
        nameWidth
      );

  return { given, secondary };
}

/**
 * `fitSharedSize` measures ONE string, and a row measures a composition.
 *
 * The row's width is the surname plus a gap plus the given name at a fraction of
 * the surname's size, so the two are handed to the search joined by a character
 * that cannot occur in a name and split again inside the measure. The alternative
 * was to fit the surname against a guessed fraction of the width and hope the
 * given name fitted in the rest.
 */
const PAIR_SEP = " ";

export interface SizePlan {
  sizes: BandSizes;
  /** Width available to the name itself, after gutter, pill and QR reserves. */
  nameWidth: number;
  gutterW: number;
}

/**
 * Exported for one test, which recomputes the reading distances the editor shows
 * and asserts they still match `READING_DISTANCE_M`. A table of metres copied by
 * hand into the UI would drift away from the renderer silently, and the number is
 * the only thing telling an operator what a fourth seat costs.
 */
export function planSizes(
  t: TypeCtx,
  contents: BandContent[],
  opts: {
    rowMode: boolean;
    bandW: number;
    bandH: number;
    shortSide: number;
    reserved: number;
    scale: number;
  }
): SizePlan {
  const { rowMode, bandW, bandH, shortSide, reserved, scale } = opts;
  const anyCaption = contents.some((c) => c.caption);
  /* A fixed fraction rather than the measured caption width, because the caption
   * size depends on the surname size which would then depend on the gutter. */
  const gutterW = rowMode && anyCaption ? Math.round(bandW * 0.14) : 0;
  const nameWidth = bandW - reserved - gutterW - Math.round(8 * scale);

  /* A predicate rather than a filter plus assertions: `ranks` is null exactly
   * when the band shows a notice, and the compiler cannot see that through a
   * truthiness filter. */
  const named = contents.filter((c): c is BandContent & { ranks: NameRanks } => c.ranks !== null);
  const hasNames = named.length > 0;
  const notices = contents.map((c) => c.notice ?? "").filter(Boolean);

  const surnameSize = fitSurname(
    t,
    { named, notices, contents },
    {
      rowMode,
      bandH,
      shortSide,
      nameWidth,
    }
  );

  const sub = fitSubordinates(t, contents, {
    rowMode,
    surnameSize,
    bandH,
    nameWidth,
    gutterW,
    scale,
  });

  return {
    sizes: {
      surname: surnameSize,
      given: Math.max(11, sub.given),
      secondary: Math.max(11, sub.secondary),
      /* Subordinate to a name but still legible from a step away, and always in
       * the light weight, which is what marks it as a statement about the sign. */
      notice: hasNames ? Math.max(12, Math.round(surnameSize * GIVEN_RATIO)) : surnameSize,
    },
    nameWidth,
    gutterW,
  };
}

/* ── Renderer ─────────────────────────────────────────────────── */

/**
 * Header accents, as exact palette entries plus the text colour that survives on
 * each.
 *
 * The values are the panel's pixel codes, not what the eye sees: a Spectra 6
 * panel renders "green" as a mid-dark pigment and "red" as a brick, so white text
 * holds on both even though `#00FF00` in a preview suggests otherwise. Yellow is
 * light as a code AND as a pigment, so it is the one accent that takes dark text.
 */
const ACCENTS: Record<string, { bg: string; fg: string }> = {
  red: { bg: "#FF0000", fg: "#FFFFFF" },
  blue: { bg: "#0000FF", fg: "#FFFFFF" },
  green: { bg: "#00FF00", fg: "#FFFFFF" },
  yellow: { bg: "#FFFF00", fg: "#000000" },
};

/**
 * The booking link to offer, or null.
 *
 * A single-seat plate, or nothing. One code on a four-desk plate cannot say which
 * desk it books, and a scan that books the wrong desk is worse than no code.
 */
function plateBookingUrl(config: NamePlateConfig, isFree: boolean): string | null {
  if (config.seats.length !== 1) return null;
  const occupant = config.seats[0].occupant;
  const url = occupant.kind === "calendar" ? (occupant.bookingUrl ?? null) : null;
  return shouldShowBookingQr(config.bookingQr, isFree, url) ? url : null;
}

/** The header bar: the place, and optionally its class as a colour. */
function drawHeader(
  t: TypeCtx,
  room: string,
  geom: { width: number; headerH: number; pad: number; scale: number },
  bg: string,
  fg: string
): void {
  const { width, headerH, pad, scale } = geom;
  t.ctx.fillStyle = bg;
  t.ctx.fillRect(0, 0, width, headerH);
  const roomWidth = width - pad * 2;
  const roomSize = fitSharedSize({
    texts: [room],
    maxWidth: roomWidth,
    maxHeight: Math.round(headerH * 0.42),
    measure: (text, size) => measureAt(t, text, size),
    min: 12,
    max: Math.round(34 * scale),
  });
  drawLeft(
    t,
    room,
    pad,
    Math.round(headerH / 2 + roomSize * CAP_RATIO * 0.5),
    roomSize,
    fg,
    true,
    roomWidth
  );
}

/**
 * The booking code and its label, bottom right of the band area.
 *
 * Inside the width `render` already reserved for it, so nothing has to move. The
 * label is centred under the MATRIX rather than under the reserved box: the matrix
 * is the box rounded down to whole modules, so the two differ by up to a module
 * and a left-aligned label reads as misplaced.
 */
function drawQrPanel(
  t: TypeCtx,
  url: string,
  label: string,
  labelColor: string,
  geom: {
    width: number;
    height: number;
    pad: number;
    footerH: number;
    qrBox: number;
    scale: number;
  }
): void {
  const { width, height, pad, footerH, qrBox, scale } = geom;
  const labelSize = Math.max(11, Math.round(20 * scale));
  const x = width - pad - qrBox;
  const drawn = drawQrMatrix(
    t.ctx,
    url,
    x,
    height - footerH - pad - qrBox - Math.round(labelSize * 1.4),
    qrBox
  );
  t.ctx.font = `${labelSize}px ${t.ff}`;
  const labelW = t.ctx.measureText(label).width;
  drawLeft(
    t,
    label,
    x + Math.round((drawn - labelW) / 2),
    height - footerH - pad,
    labelSize,
    labelColor,
    false,
    drawn
  );
}

/** "aktualisiert 13:42", in the display's own zone. */
function freshnessMark(now: Date, timezone: string, locale: string, labels: StatusLabels): string {
  const stamp = now.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });
  return `${labels.updated} ${stamp}`;
}

/**
 * The footer strip: the plate's state on the left, the freshness mark on the
 * right.
 *
 * Filled when a state is passed, which happens only on a single-seat plate whose
 * seat is occupied; otherwise a rule. The filled form uses the header colour pair
 * for the same reason the state pill does, namely that it is the one combination
 * every palette holds exactly.
 */
function drawFooter(
  t: TypeCtx,
  geom: { width: number; height: number; pad: number; footerH: number; scale: number },
  state: string | null,
  mark: string,
  T: Theme
): void {
  const { width, height, pad, footerH, scale } = geom;
  const y = height - footerH;
  if (state) {
    t.ctx.fillStyle = T.headerBg;
    t.ctx.fillRect(0, y, width, footerH);
  } else {
    t.ctx.fillStyle = T.slotSecondary;
    t.ctx.fillRect(pad, y, width - pad * 2, Math.max(2, Math.round(2 * scale)));
  }

  const color = state ? T.headerText : T.footerText;
  const baseline = (size: number) => Math.round(y + footerH / 2 + size * CAP_RATIO * 0.5);
  if (state) {
    const size = Math.max(11, Math.round(26 * scale));
    drawLeft(t, state, pad, baseline(size), size, color, true, width / 2);
  }

  const markSize = Math.max(11, Math.round(20 * scale));
  t.ctx.font = `${markSize}px ${t.ff}`;
  drawLeft(
    t,
    mark,
    width - pad - t.ctx.measureText(mark).width,
    baseline(markSize),
    markSize,
    color,
    false,
    width / 2
  );
}

/**
 * A blank panel of the right size, painted with the theme's ground.
 *
 * Image smoothing is off unconditionally: the only image this renderer draws is a
 * QR matrix, and a scanner reading an e-paper panel at an angle has no margin for
 * interpolated module edges.
 */
function newPlateCanvas(width: number, height: number, background: string) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

/**
 * What takes width away from the name before anything is measured.
 *
 * Both reserves are fixed here rather than derived from the type sizes, so the
 * arithmetic stays acyclic: the sizes depend on the available width, and if the
 * width depended on the sizes there would be no order to compute them in. The QR
 * reserve is a square; the pill reserve is a fraction, generous enough for
 * "bis 12:00" at the secondary size, and charged only on plates that show pills.
 */
function widthBudget(
  config: NamePlateConfig,
  contents: BandContent[],
  labels: StatusLabels,
  bands: Rect[],
  scale: number
): { qrUrl: string | null; qrBox: number; usesPills: boolean; reserved: number } {
  const anyFree = contents.some((c) => c.notice === labels.free);
  const qrUrl = plateBookingUrl(config, anyFree);
  const qrBox = qrUrl ? Math.round(170 * scale) : 0;
  const qrGutter = qrBox ? Math.round(24 * scale) : 0;
  const usesPills = bands.length > 1 && contents.some((c) => c.pill);
  const pillReserve = usesPills ? Math.round((bands[0]?.w ?? 0) * 0.24) : 0;
  return { qrUrl, qrBox, usesPills, reserved: qrBox + qrGutter + pillReserve };
}

/**
 * Every seat resolved to what its band will show.
 *
 * The caption falls back to the provider's own name for the seat, but only on a
 * plate with more than one seat: with one seat the header already names the place,
 * and repeating it puts "Besprechungsraum" twice on the same sign.
 */
async function resolveContents(
  config: NamePlateConfig,
  now: Date,
  timezone: string,
  locale: string,
  labels: StatusLabels
): Promise<BandContent[]> {
  const resolved = await Promise.all(
    config.seats.map((s) => resolveSeat(s, now, timezone, locale, labels))
  );
  return config.seats.map((seat, i) =>
    bandContent(seat, resolved[i], config.showStatus, labels, config.seats.length > 1)
  );
}

/**
 * The header bar, and the height it took.
 *
 * A door sign says WHERE it is before it says who is inside, in the same bar and
 * at the same height as the room-booking display, so a corridor of both kinds
 * looks like one system rather than two products. No room name means no bar, and
 * a height of zero.
 *
 * The accent colour is a CLASS marker and is honoured only where the panel has
 * real pigments. On a greyscale panel every accent would snap to some grey and put
 * text on an unpredictable ground; on a two-colour panel there is nothing to say
 * it with.
 */
function drawPlateHeader(
  t: TypeCtx,
  config: NamePlateConfig,
  T: Theme,
  geom: { width: number; pad: number; scale: number },
  accentable: boolean
): number {
  const room = resolveRoomName(config);
  if (!room) return 0;
  const headerH = Math.round(75 * geom.scale);
  const accent = accentable ? ACCENTS[config.accentColor] : undefined;
  drawHeader(t, room, { ...geom, headerH }, accent?.bg ?? T.headerBg, accent?.fg ?? T.headerText);
  return headerH;
}

/**
 * Stack or rows, decided by measuring both rather than by a seat count.
 *
 * A fixed threshold produced an anomaly an operator would meet head-on: with the
 * switch at three seats, a two-seat plate stacked four lines and reached a 59 px
 * surname while a THREE-seat plate rowed one line and reached 68 px, so adding a
 * seat made the sign easier to read. Choosing whichever composition gives the
 * larger surname removes that by construction and needs no magic number.
 *
 * It also lands where the design wants it. One seat keeps the full stack, because
 * the stack wins there: the titles and the affiliation cost height a single band
 * has to spare, and the surname is width-bound anyway. From two seats up the rows
 * win, and what they drop (titles, affiliation) is bought back as roughly double
 * the surname.
 *
 * Ties go to the stack, since it shows more.
 */
function choosePlan(
  t: TypeCtx,
  contents: BandContent[],
  geom: { bandW: number; bandH: number; shortSide: number; reserved: number; scale: number }
): SizePlan & { rowMode: boolean } {
  const stacked = planSizes(t, contents, { ...geom, rowMode: false });
  const rowed = planSizes(t, contents, { ...geom, rowMode: true });
  const rowMode = rowed.sizes.surname > stacked.sizes.surname;
  return { ...(rowMode ? rowed : stacked), rowMode };
}

/** Every band, in whichever composition the plan chose, plus its state pill. */
function drawBands(
  t: TypeCtx,
  bands: Rect[],
  contents: BandContent[],
  plan: SizePlan & { rowMode: boolean },
  colors: BandColors,
  usesPills: boolean
): void {
  const { sizes, nameWidth, gutterW, rowMode } = plan;
  bands.forEach((band, i) => {
    const content = contents[i];
    if (rowMode) drawRow(t, band, content, sizes, colors, gutterW, nameWidth);
    else drawStack(t, band, content, sizes, colors, nameWidth);
    if (usesPills && content.pill) {
      drawPill(t, band.x + band.w, band.y + band.h / 2, content.pill, sizes.secondary, colors);
    }
  });
}

async function render(params: RenderParams): Promise<RenderResult> {
  const config: NamePlateConfig = namePlateConfigSchema.parse(params.config);
  const { width, height, colorMode, colorCount } = params.display;
  const T = params.theme;
  const timezone = config.timezone ?? params.timezone ?? "UTC";
  const locale = config.locale;

  const labels = statusLabels(locale);
  const contents = await resolveContents(config, params.now, timezone, locale, labels);

  const canvas = newPlateCanvas(width, height, T.background);
  const ctx = canvas.getContext("2d");

  const shortSide = Math.min(width, height);
  const pad = Math.round(shortSide * 0.06);
  const scale = shortSide / 480;
  const t: TypeCtx = { ctx, ff: ensureRenderFonts() };

  const accentable = colorCount > 2 && colorMode !== "grayscale";
  const headerH = drawPlateHeader(t, config, T, { width, pad, scale }, accentable);

  /* The footer is always present, because the freshness mark is not optional.
   * E-paper holds its image without power, so a frozen panel is indistinguishable
   * from a current one, and that is the one hazard peculiar to this medium:
   * without a time on the sign nobody can decide whether to trust it.
   *
   * On a single-seat plate the footer also carries that seat's state, which is
   * where a filled area pays best: the strip spans the panel and the name keeps
   * the whole width it would otherwise share with a pill. */
  const footerH = Math.round(60 * scale);
  const soleState = config.seats.length === 1 ? contents[0].pill : null;

  const bands = seatBands(config.seats.length, width, height - footerH, pad, headerH);
  const bandW = bands[0]?.w ?? width;
  const bandH = bands[0]?.h ?? height;

  const budget = widthBudget(config, contents, labels, bands, scale);

  const plan = choosePlan(t, contents, {
    bandW,
    bandH,
    shortSide,
    reserved: budget.reserved,
    scale,
  });
  const colors: BandColors = {
    name: T.footerText,
    secondary: T.slotSecondary,
    /* The header's pair, not the body's: it is the one combination every palette
     * holds exactly, so a filled block keeps its contrast on every panel. */
    pillBg: T.headerBg,
    pillText: T.headerText,
  };

  drawSeparators(ctx, bands, T.slotSecondary, scale);
  drawBands(t, bands, contents, plan, colors, budget.usesPills);

  if (budget.qrUrl) {
    const qr = { width, height, pad, footerH, qrBox: budget.qrBox, scale };
    drawQrPanel(t, budget.qrUrl, labels.book, T.footerText, qr);
  }
  drawFooter(
    t,
    { width, height, pad, footerH, scale },
    soleState,
    freshnessMark(params.now, timezone, locale, labels),
    T
  );

  return { canvas };
}

/**
 * Status wording, kept here rather than in the shared i18n messages.
 *
 * Those messages are for the admin UI and are loaded by a React provider; a
 * renderer runs on the server for a device whose locale is its own config field.
 * A handful of strings does not justify wiring a second loader, and the
 * room-booking renderer already carries its labels the same way.
 *
 * A table rather than a switch: the switch was five nearly identical return
 * statements, which is a lot of lines and one place to forget a key.
 */
interface StatusLabels {
  free: string;
  busy: string;
  unknown: string;
  until: string;
  updated: string;
  book: string;
}

const LABELS_BY_LANG: Record<string, StatusLabels> = {
  de: {
    free: "Frei",
    busy: "Belegt",
    unknown: "Keine Verbindung",
    until: "bis",
    updated: "aktualisiert",
    book: "buchen",
  },
  fr: {
    free: "Libre",
    busy: "Occupé",
    unknown: "Hors ligne",
    until: "jusqu'à",
    updated: "mis à jour",
    book: "réserver",
  },
  es: {
    free: "Libre",
    busy: "Ocupado",
    unknown: "Sin conexión",
    until: "hasta",
    updated: "actualizado",
    book: "reservar",
  },
  it: {
    free: "Libero",
    busy: "Occupato",
    unknown: "Non connesso",
    until: "fino a",
    updated: "aggiornato",
    book: "prenota",
  },
  en: {
    free: "Free",
    busy: "Busy",
    unknown: "Offline",
    until: "until",
    updated: "updated",
    book: "book",
  },
};

function statusLabels(locale: string): StatusLabels {
  return LABELS_BY_LANG[locale.slice(0, 2).toLowerCase()] ?? LABELS_BY_LANG.en;
}

export const namePlateRenderer: ContentRenderer = {
  slug: "name-plate",
  name: "Name plate",
  configSchema: namePlateConfigSchema,
  render,
};
