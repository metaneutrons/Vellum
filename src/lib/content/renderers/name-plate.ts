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

import { TZDate } from "@date-fns/tz";
import { getCalendarProvider } from "@/lib/calendar/registry";
import { getProviderWithCredentials } from "@/lib/providers";
import { TtlCache } from "@/lib/cache";
import { ensureRenderFonts, narrowFontFamily } from "@/lib/render/fonts";
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
  type SeatState,
  type BandContent,
  type Rect,
} from "./name-plate-layout";
import { shouldShowBookingQr } from "./booking-qr";
import type { BandColors, TypeCtx } from "./name-plate-scale";
import {
  ACCENTS,
  drawFooter,
  drawHeader,
  drawPill,
  drawQrPanel,
  drawRow,
  drawSeparators,
  drawStack,
  newPlateCanvas,
} from "./name-plate-draw";
import { choosePlan, type ChosenPlan } from "./name-plate-sizes";

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
 * What takes width away from the name before anything is measured.
 *
 * Both reserves are fixed here rather than derived from the type sizes, so the
 * arithmetic stays acyclic: the sizes depend on the available width, and if the
 * width depended on the sizes there would be no order to compute them in. The QR
 * reserve is a square; the pill reserve is a fraction, generous enough for
 * "bis 12:00" at the secondary size, and charged only on plates that show pills.
 */
interface WidthBudget {
  /** The booking link to encode, or null for no code. */
  qrUrl: string | null;
  /** Side of the square the code gets, or 0. */
  qrBox: number;
  usesPills: boolean;
  /** Total width the name may not use. */
  reserved: number;
}

function widthBudget(
  config: NamePlateConfig,
  contents: BandContent[],
  labels: StatusLabels,
  bands: Rect[],
  scale: number
): WidthBudget {
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
): void {
  const room = resolveRoomName(config);
  if (!room) return;
  const headerH = Math.round(75 * geom.scale);
  const accent = accentable ? ACCENTS[config.accentColor] : undefined;
  drawHeader(t, room, { ...geom, headerH }, accent?.bg ?? T.headerBg, accent?.fg ?? T.headerText);
}

/** Every band, in whichever composition the plan chose, plus its state pill. */
function drawBands(
  t: TypeCtx,
  bands: Rect[],
  contents: BandContent[],
  plan: ChosenPlan,
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

/**
 * Which theme colour each rank is drawn in.
 *
 * The filled areas take the HEADER pair rather than the body's, because that is
 * the one combination every palette holds exactly, so a pill or a footer strip
 * keeps its contrast on every panel including the two-colour one.
 */
function plateColors(T: Theme): BandColors {
  return {
    name: T.footerText,
    secondary: T.slotSecondary,
    pillBg: T.headerBg,
    pillText: T.headerText,
  };
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
  /* The bar's HEIGHT never depended on the face, so it can be settled before the
   * face is chosen; the drawing has to wait until it is. */
  const headerH = resolveRoomName(config) ? Math.round(75 * scale) : 0;

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

  /* The normal cut first, so it wins a tie: the narrow one is then used only where
   * it buys the surname something, which is exactly where the type ran out of width
   * before it ran out of height. */
  const narrow = narrowFontFamily();
  const families = narrow ? [ensureRenderFonts(), narrow] : [ensureRenderFonts()];
  const plan = choosePlan(ctx, families, contents, {
    bandW,
    bandH,
    shortSide,
    reserved: budget.reserved,
    scale,
  });

  /* One face per sign. Everything from the room name to the freshness mark is set
   * in whichever cut the plan chose, because two faces on one plate would read as
   * a mistake rather than as a decision. */
  const t: TypeCtx = { ctx, ff: plan.family };
  const accentable = colorCount > 2 && colorMode !== "grayscale";
  drawPlateHeader(t, config, T, { width, pad, scale }, accentable);

  const colors = plateColors(T);

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
