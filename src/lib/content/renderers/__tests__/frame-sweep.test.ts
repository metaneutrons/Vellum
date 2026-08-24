// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The five invariants, swept over renderers, panels, clocks and booking shapes.
 *
 * The sweep is factored rather than exhaustive, and the factorisation is a claim
 * worth stating. Layout rules that depend on the CLOCK are panel-independent,
 * because `scale = shortSide / 480` moves line height and drawing area together,
 * so the clipping cliff lands at about 1.08 h of visible booking on every panel.
 * Rules that depend on GEOMETRY do not depend on the clock. So the clock is swept
 * on the two cheap 800x480 panels and the geometry on all four at three times,
 * instead of multiplying to 500 renders of a 1872x1404 surface for a suite that
 * has to stay fast enough to run on every commit.
 */

import { describe, it, expect } from "vitest";
import { renderToCanvas, drawRoom, type RoomModel } from "../room-booking";
import { drawPlate, type PlateModel } from "../name-plate";
import { bandContent, type SeatState } from "../name-plate-layout";
import { namePlateConfigSchema, type Seat } from "../name-plate-types";
import { applyRoomPolicy } from "@/lib/calendar/policy";
import { resolveTheme, snapThemeToPalette, type Theme } from "@/lib/theme";
import { DISPLAY_REGISTRY, type ResolvedDisplay } from "@/lib/display";
import { recordingFactory, type Recording, type SurfaceFactory } from "@/lib/render/surface";
import { checkFrame, type FrameExpectation } from "@/lib/render/frame-invariants";
import type { CalendarEvent, DisplayEvent } from "@/lib/types";

/* ── Panels ───────────────────────────────────────────────────── */

type PanelName = "e1001" | "e1002" | "e1003" | "d1001";

function panel(name: PanelName): ResolvedDisplay {
  const reg = DISPLAY_REGISTRY[name];
  const reserved = reg.reservedPaletteIndices ?? [];
  /* Landscape for every panel, which is how all four are mounted for these two
   * content types, and what the device rows in the estate report. */
  const [width, height] =
    reg.width < reg.height ? [reg.height, reg.width] : [reg.width, reg.height];
  return {
    width,
    height,
    palette: reg.palette,
    reservedPaletteIndices: reserved,
    format: reg.format,
    colorMode: reg.colorMode,
    colorCount: reg.palette.length - reserved.length,
    orientation: "landscape",
  };
}

const ALL_PANELS: PanelName[] = ["e1001", "e1002", "e1003", "d1001"];
/* The two 800x480 panels carry the clock sweep. One is six-colour indexed, the
 * other two-colour mono, so the sweep also crosses the two colour modes whose
 * themes differ most. */
const CHEAP_PANELS: PanelName[] = ["e1001", "e1002"];

function themeFor(display: ResolvedDisplay): Theme {
  return snapThemeToPalette(resolveTheme(display.colorCount), display.palette);
}

/* ── Booking shapes ───────────────────────────────────────────── */

const DAY = "2026-08-24";
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00.000Z`);

interface Shape {
  name: string;
  events: CalendarEvent[];
}

const ev = (
  from: string,
  to: string,
  subject: string,
  organizer: string,
  isPrivate = false
): CalendarEvent => ({
  subject,
  organizer,
  startTime: at(from),
  endTime: at(to),
  isPrivate,
});

const SHAPES: Shape[] = [
  { name: "empty day", events: [] },
  {
    name: "one long booking",
    events: [ev("08:00", "11:00", "Projektbesprechung", "Maria Warnking")],
  },
  { name: "one short booking", events: [ev("09:00", "09:30", "Standup", "Lukas Thiele")] },
  {
    name: "two overlapping bookings",
    events: [
      ev("08:00", "10:00", "Jour fixe", "Maria Warnking"),
      ev("08:30", "10:30", "Vergabegespräch", "Prof. Dr. Fabian Schmieder"),
    ],
  },
  {
    /* Under "Show All" a private booking still names who booked it, only the
     * subject is replaced. So the name is owed here too, and this case asserts
     * the policy's promise rather than exempting itself from it. */
    name: "a private booking",
    events: [ev("08:00", "10:00", "Personalgespräch", "Maria Warnking", true)],
  },
];

/**
 * The names the frame owes at this moment.
 *
 * A booking outside the eight-hour window is legitimately absent, and a sliver of
 * one cannot hold a line of type: one line needs `16 * scale` px, which is about
 * 22 minutes of the window on every panel. Thirty minutes is therefore a safe
 * floor and, unlike restating the renderer's own arithmetic, it does not make the
 * assertion circular.
 */
function owed(events: CalendarEvent[], now: Date, shiftH = 2): string[] {
  const blockMs = shiftH * 3600_000;
  const wStart = Math.floor(now.getTime() / blockMs) * blockMs;
  const wEnd = wStart + 8 * 3600_000;
  return events
    .filter((e) => {
      const from = Math.max(e.startTime.getTime(), wStart);
      const to = Math.min(e.endTime.getTime(), wEnd);
      return to - from >= 30 * 60_000;
    })
    .map((e) => e.organizer);
}

/* Every two hours of the working day, which is also every position a booking can
 * take relative to the eight-hour window at a two-hour shift. */
const CLOCK = ["06:30", "08:30", "10:30", "12:30", "14:30", "16:30"];

const ROOM = "1J.1.18";
const STATE_LABELS = ["FREI", "BELEGT"];

function timelineFrame(events: DisplayEvent[], display: ResolvedDisplay, now: Date): Recording {
  const { factory, recordings } = recordingFactory();
  renderToCanvas(
    events,
    ROOM,
    "Europe/Berlin",
    now,
    themeFor(display),
    display.width,
    display.height,
    display.colorCount,
    display.colorMode,
    2,
    "de",
    "PPP",
    undefined,
    factory
  );
  expect(recordings).toHaveLength(1);
  return recordings[0];
}

function expectSound(recording: Recording, expectation: FrameExpectation, where: string) {
  expect(checkFrame(recording, expectation), where).toEqual([]);
}

/* ── The sweep ────────────────────────────────────────────────── */

describe("room booking, timeline: the clock cannot cost information", () => {
  for (const p of CHEAP_PANELS)
    for (const shape of SHAPES)
      for (const hhmm of CLOCK)
        it(`${p} / ${shape.name} / ${hhmm}Z`, () => {
          const display = panel(p);
          const now = at(hhmm);
          expectSound(
            timelineFrame(applyRoomPolicy(shape.events, "Show All", "de"), display, now),
            { mustRead: [ROOM, ...owed(shape.events, now)], exactlyOneOf: STATE_LABELS },
            `${p} ${shape.name} at ${hhmm}Z`
          );
        });
});

describe("room booking, timeline: every panel", () => {
  for (const p of ALL_PANELS)
    /* Three positions of one booking relative to the window: fully inside, still
     * fully inside after the clock moves, and clipped to its last hour once the
     * window start has passed it. The third is the case that used to lose the
     * name. */
    for (const hhmm of ["08:30", "09:30", "10:30"])
      it(`${p} / long booking / ${hhmm}Z`, () => {
        const display = panel(p);
        const shape = SHAPES[1];
        const now = at(hhmm);
        expectSound(
          timelineFrame(applyRoomPolicy(shape.events, "Show All", "de"), display, now),
          { mustRead: [ROOM, ...owed(shape.events, now)], exactlyOneOf: STATE_LABELS },
          `${p} at ${hhmm}Z`
        );
      });
});

/* ── Everything below draws from a MODEL, with no provider and no database.
 *    That is what the load/draw split bought: a free seat, a taken seat, an
 *    unreachable provider and a stacked layout are objects now, not states that
 *    needed a calendar behind them. ─────────────────────────────────────────── */

const ROOM_CONFIG = {
  providerId: "00000000-0000-4000-8000-000000000000",
  roomConfig: { resourceId: "1", resourceName: ROOM },
  roomName: ROOM,
  timezone: "Europe/Berlin",
  locale: "de",
  dateFormat: "PPP" as const,
  policy: "Show All" as const,
  cacheTtlS: 120,
  timelineShiftH: 2,
  bookingQr: { visibility: "never" as const, source: "provider" as const },
};

function roomModel(over: Partial<RoomModel> = {}): RoomModel {
  return {
    config: { ...ROOM_CONFIG, layout: "timeline" },
    timezone: "Europe/Berlin",
    now: at("10:30"),
    events: [],
    bookingUrl: null,
    isRoomFree: true,
    offline: false,
    ...over,
  };
}

function frameOf(draw: (surface: SurfaceFactory) => void): Recording {
  const { factory, recordings } = recordingFactory();
  draw(factory);
  expect(recordings).toHaveLength(1);
  return recordings[0];
}

describe("room booking, offline screen", () => {
  for (const p of ALL_PANELS)
    it(p, () => {
      const display = panel(p);
      const model = roomModel({ offline: true, isRoomFree: false });
      const rec = frameOf((surface) =>
        drawRoom(model, { theme: themeFor(display), display, surface })
      );
      expectSound(rec, { mustRead: [ROOM] }, `offline on ${p}`);
    });
});

describe("room booking, stacked layout", () => {
  for (const p of ALL_PANELS)
    for (const shape of SHAPES)
      it(`${p} / ${shape.name}`, () => {
        const display = panel(p);
        const now = at("10:30");
        const model = roomModel({
          config: { ...ROOM_CONFIG, layout: "stacked" },
          now,
          events: applyRoomPolicy(shape.events, "Show All", "de"),
          isRoomFree: !shape.events.some((e) => e.startTime <= now && e.endTime > now),
        });
        const rec = frameOf((surface) =>
          drawRoom(model, { theme: themeFor(display), display, surface })
        );
        /* Cards, unlike timeline blocks, carry only time and subject. The
         * occupant is therefore NOT owed here, and that gap is a recorded item
         * rather than a licence: see ROADMAP, "the stacked layout never names the
         * occupant at all". When it does, `owed(...)` belongs in this expectation
         * and this comment goes. */
        expectSound(rec, { mustRead: [ROOM] }, `stacked ${shape.name} on ${p}`);
      });
});

describe("name plate", () => {
  const NAMES = ["Prof. Dr. Fabian Schmieder", "Maria Warnking", "Lukas Thiele", "Ana de la Cruz"];
  const LABELS = { free: "Frei", busy: "Belegt", unknown: "Keine Verbindung" };
  const PLATE_ROOM = "1J.2.27";

  /**
   * A plate config through the REAL schema, which is how `load` gets one.
   *
   * Building the objects by hand skipped zod and therefore skipped the defaults
   * for `role` and `unit`, and `affiliationOf` trims them without asking. A test
   * that constructs an impossible value proves nothing about the possible ones.
   */
  function parsePlate(seats: unknown[], showStatus = false): PlateModel["config"] {
    return namePlateConfigSchema.parse({
      roomName: PLATE_ROOM,
      seats,
      showStatus,
      locale: "de",
      timezone: "Europe/Berlin",
    });
  }

  /** A seat's band, built through the real mapping rather than by hand. */
  function band(seat: Seat, state: SeatState, showStatus: boolean, placeFallback: boolean) {
    return bandContent(seat, state, showStatus, LABELS, placeFallback);
  }

  const staticSeat = (name: string) => ({ caption: "", occupant: { kind: "static", name } });
  const calendarSeat = (resourceName: string) => ({
    caption: "",
    occupant: {
      kind: "calendar",
      providerId: "00000000-0000-4000-8000-000000000000",
      resourceId: "1",
      resourceName,
    },
  });

  function plateFrameOf(display: ResolvedDisplay, model: PlateModel): Recording {
    return frameOf((surface) => drawPlate(model, { theme: themeFor(display), display, surface }));
  }

  for (const p of ALL_PANELS)
    for (const count of [1, 2, 3, 4])
      it(`${p} / ${count} occupied seat(s)`, () => {
        const display = panel(p);
        const names = NAMES.slice(0, count);
        const config = parsePlate(names.map(staticSeat));
        const model: PlateModel = {
          config,
          bands: config.seats.map((seat, i) =>
            band(seat, { occupant: names[i] }, false, count > 1)
          ),
          now: at("10:30"),
          timezone: "Europe/Berlin",
        };
        /* Only the surname is required reading. The plate sets it several times
         * larger than the rest precisely because it is the part that has to carry
         * across a corridor, and the given name may be dropped when a band is
         * short. */
        const surnames = names.map((n) => n.split(" ").pop()!);
        expectSound(
          plateFrameOf(display, model),
          { mustRead: [PLATE_ROOM, ...surnames] },
          `${count} seats on ${p}`
        );
      });

  /**
   * The seat states, on every panel. None of this was reachable before the split:
   * a static seat may not be nameless, so "Frei" and "Belegt" exist only on a
   * calendar seat, and a calendar seat used to mean a provider and a database.
   *
   * The wording of the occupied state depends on `showStatus`, by design: the pill
   * carries the DETAIL when there is one and the bare word otherwise, so a plate
   * showing status reads "bis 12:00" rather than "Belegt". Each case therefore
   * brings its own set of mutually exclusive wordings, which keeps the invariant
   * as strong as it was instead of loosening it to fit.
   */
  const STATES = [
    {
      name: "free",
      state: { occupant: null, placeLabel: "Föhr 1" } as SeatState,
      showStatus: true,
      oneOf: ["Frei", "Belegt", "Keine Verbindung"],
      reads: [] as string[],
    },
    {
      name: "occupied, status hidden",
      state: { occupant: "Maria Warnking", placeLabel: "Föhr 1" } as SeatState,
      showStatus: false,
      oneOf: ["Frei", "Belegt", "Keine Verbindung"],
      reads: ["Warnking"],
    },
    {
      name: "occupied, status shown",
      state: {
        occupant: "Maria Warnking",
        placeLabel: "Föhr 1",
        detail: "bis 12:00",
      } as SeatState,
      showStatus: true,
      oneOf: ["Frei", "bis 12:00", "Keine Verbindung"],
      reads: ["Warnking", "bis 12:00"],
    },
    {
      name: "unreachable",
      state: { occupant: null, placeLabel: "Föhr 1", unreachable: true } as SeatState,
      showStatus: true,
      oneOf: ["Frei", "Belegt", "Keine Verbindung"],
      reads: [],
    },
  ];

  for (const p of ALL_PANELS)
    for (const c of STATES)
      it(`${p} / a calendar seat that is ${c.name} says so`, () => {
        const display = panel(p);
        const config = parsePlate([calendarSeat("Föhr 1")], c.showStatus);
        const model: PlateModel = {
          config,
          bands: [band(config.seats[0], c.state, c.showStatus, false)],
          now: at("10:30"),
          timezone: "Europe/Berlin",
        };
        expectSound(
          plateFrameOf(display, model),
          { mustRead: [PLATE_ROOM, ...c.reads], exactlyOneOf: c.oneOf },
          `${c.name} seat on ${p}`
        );
      });
});
