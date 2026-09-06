import { describe, it, expect } from "vitest";
import { seatBands, bandContent, bandLineCount, fitSharedSize } from "../name-plate-layout";
import { seatSchema, namePlateConfigSchema, resolveRoomName, MAX_SEATS } from "../name-plate-types";

const staticSeat = (name: string, caption = "", unit = "", role = "") =>
  seatSchema.parse({ caption, occupant: { kind: "static", name, unit, role } });

const calendarSeat = (caption = "", parentName?: string) =>
  seatSchema.parse({
    caption,
    occupant: {
      kind: "calendar",
      providerId: "123e4567-e89b-42d3-a456-426614174000",
      resourceId: "room-1",
      parentName,
    },
  });

describe("seatBands", () => {
  /* The property that makes the plate predictable: only the height changes as
   * seats are added. Every band keeps the full width, which is what a name needs. */
  it("gives every band the full inner width, whatever the seat count", () => {
    for (const count of [1, 2, 3, 4]) {
      const bands = seatBands(count, 800, 480, 20);
      expect(bands).toHaveLength(count);
      for (const b of bands) expect(b.w).toBe(760);
    }
  });

  it("stacks bands in order without overlapping", () => {
    const bands = seatBands(4, 800, 480, 20);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.y).toBeGreaterThanOrEqual(bands[i - 1]!.y + bands[i - 1]!.h);
    }
  });

  it("stays inside the padded area", () => {
    const pad = 20;
    const bands = seatBands(3, 800, 480, pad);
    expect(bands[0]!.y).toBeGreaterThanOrEqual(pad);
    const last = bands[bands.length - 1]!;
    expect(last.y + last.h).toBeLessThanOrEqual(480 - pad + 1); /* rounding */
  });

  /* Gaps go BETWEEN bands only. Counting the edge twice is how a four-seat plate
   * would silently get less usable height than three seats deserve. */
  it("spends gap only between bands, so one seat uses the whole area", () => {
    const single = seatBands(1, 800, 480, 20)[0]!;
    expect(single.h).toBe(440);
    expect(single.y).toBe(20);
  });

  it("returns nothing for a seatless plate rather than a zero-height band", () => {
    expect(seatBands(0, 800, 480, 20)).toEqual([]);
  });

  /* A portrait panel is the same rule, which is the point of bands: no special
   * case per orientation. */
  it("uses the same rule in portrait", () => {
    const bands = seatBands(4, 480, 800, 20);
    for (const b of bands) expect(b.w).toBe(440);
    expect(bands[0]!.h).toBeGreaterThan(seatBands(4, 800, 480, 20)[0]!.h);
  });
});

const LABELS = { free: "Frei", busy: "Belegt", unknown: "Keine Verbindung" };

describe("bandContent", () => {
  /* The roles are fixed: the ROOM is in the header, the SEAT is the caption, the
   * big rank is the person. The bug this replaced put the resource name in the
   * big rank whenever a seat was free, so an empty desk rendered as
   * "Föhr 1 (1J.2.27)" in the slot meant for a person and read like one. */
  it("says nobody is there instead of putting the place in the name slot", () => {
    const c = bandContent(
      calendarSeat(),
      { occupant: null, placeLabel: "Föhr 1 (1J.2.27)" },
      false,
      LABELS
    );
    expect(c.notice).toBe("Frei");
    expect(c.ranks).toBeNull();
    expect(c.caption).toBe("Föhr 1 (1J.2.27)");
  });

  /* A state is not a name, so it must not arrive as ranks: `drawBand` sets ranks
   * bold at the largest size and a notice light at the smallest, and the branch is
   * chosen here rather than there. */
  it("never turns a state into ranks", () => {
    for (const state of [
      { occupant: null, placeLabel: "Föhr 1" },
      { occupant: null, placeLabel: "Föhr 1", unreachable: true },
    ]) {
      expect(bandContent(calendarSeat(), state, false, LABELS).ranks).toBeNull();
    }
  });

  it("puts the occupant in the ranks and the seat in the caption", () => {
    const c = bandContent(
      calendarSeat(),
      { occupant: "Fabian Schmieder", placeLabel: "Föhr 1", detail: "bis 12:00" },
      true,
      LABELS
    );
    expect(c.caption).toBe("Föhr 1");
    expect(c.ranks).toEqual({ titles: "", given: "Fabian", surname: "Schmieder" });
    expect(c.pill).toBe("bis 12:00");
  });

  /* A provider that separates the two knows something no heuristic can recover,
   * so its split has to win. */
  it("believes the provider's own split over the heuristic", () => {
    const c = bandContent(
      calendarSeat(),
      {
        occupant: "Nikola Ćurić",
        ranks: { titles: "", given: "Nikola", surname: "Ćurić" },
      },
      false,
      LABELS
    );
    expect(c.ranks).toEqual({ titles: "", given: "Nikola", surname: "Ćurić" });
  });

  /* showStatus governs the DETAIL, not whether the state is admitted: a plate that
   * cannot say "free" is not a door sign, and is indistinguishable from a failed
   * lookup. */
  it("still reveals a free seat when the detail is switched off", () => {
    const c = bandContent(calendarSeat(), { occupant: null, placeLabel: "Föhr 1" }, false, LABELS);
    expect(c.notice).toBe("Frei");
    expect(c.pill).toBeNull();
  });

  it("keeps the pill but drops the detail when status is switched off", () => {
    const c = bandContent(
      calendarSeat(),
      { occupant: "Schmieder", placeLabel: "Föhr 1", detail: "bis 12:00" },
      false,
      LABELS
    );
    expect(c.ranks?.surname).toBe("Schmieder");
    expect(c.pill).toBe("Belegt");
  });

  /* A filled area means occupied and its absence means free, so a free seat and
   * an unreachable one must both come back without a pill. */
  it("gives a pill only to an occupied calendar seat", () => {
    expect(bandContent(calendarSeat(), { occupant: null }, true, LABELS).pill).toBeNull();
    expect(
      bandContent(calendarSeat(), { occupant: null, unreachable: true }, true, LABELS).pill
    ).toBeNull();
    expect(bandContent(staticSeat("Müller"), { occupant: "Müller" }, true, LABELS).pill).toBeNull();
  });

  /* An operator's own caption beats the provider's name for the same seat. */
  it("prefers the operator's caption over the resource name", () => {
    const c = bandContent(
      calendarSeat("Schreibtisch 1"),
      { occupant: null, placeLabel: "Föhr 1" },
      false,
      LABELS
    );
    expect(c.caption).toBe("Schreibtisch 1");
  });

  /* A static seat is always occupied by the person named, has no place label and
   * no state, so a one-word name composes one line. */
  it("gives a static seat its name and nothing else", () => {
    const c = bandContent(staticSeat("Müller"), { occupant: "Müller" }, true, LABELS);
    expect(c).toMatchObject({ caption: null, pill: null });
    expect(c.ranks).toEqual({ titles: "", given: "", surname: "Müller" });
    expect(bandLineCount(c)).toBe(1);
  });

  /* The line count is what divides the band's height, so each rank that is
   * actually drawn has to be counted and nothing else. */
  it("counts one line per rank it will draw", () => {
    const one = bandContent(staticSeat("Müller"), { occupant: "Müller" }, false, LABELS);
    expect(bandLineCount(one)).toBe(1);

    const two = bandContent(
      staticSeat("Fabian Müller"),
      { occupant: "Fabian Müller" },
      false,
      LABELS
    );
    expect(bandLineCount(two)).toBe(2);

    const three = bandContent(
      staticSeat("Prof. Dr. Fabian Müller"),
      { occupant: "Prof. Dr. Fabian Müller" },
      false,
      LABELS
    );
    expect(bandLineCount(three)).toBe(3);
  });

  /* The pill sits beside the stack, so it costs width and no height. Counting it
   * would shrink the surname to make room for nothing. */
  it("does not count the pill as a line", () => {
    const withPill = bandContent(
      calendarSeat(),
      { occupant: "Müller", detail: "bis 12:00" },
      true,
      LABELS
    );
    expect(withPill.pill).toBe("bis 12:00");
    expect(bandLineCount(withPill)).toBe(1);
  });

  it("keeps a caption on a static seat", () => {
    const c = bandContent(
      staticSeat("Müller", "Schreibtisch 2"),
      { occupant: "Müller" },
      false,
      LABELS
    );
    expect(c.caption).toBe("Schreibtisch 2");
    expect(bandLineCount(c)).toBe(2);
  });

  /* A blank caption means "no caption", so whitespace must not buy a line. */
  it("treats a blank caption as absent", () => {
    const c = bandContent(staticSeat("Müller", "   "), { occupant: "Müller" }, false, LABELS);
    expect(c.caption).toBeNull();
    expect(bandLineCount(c)).toBe(1);
  });

  /* A sign may withhold detail; it may not present an unknown state as current.
   * Before this, a failed lookup rendered exactly like a free desk. */
  it("names an unreachable provider whatever the operator asked for", () => {
    const off = bandContent(
      calendarSeat(),
      { occupant: null, placeLabel: "Föhr 1", unreachable: true },
      false,
      LABELS
    );
    expect(off.notice).toBe("Keine Verbindung");
    expect(off.notice).not.toBe(
      bandContent(calendarSeat(), { occupant: null, placeLabel: "Föhr 1" }, false, LABELS).notice
    );
  });
});

describe("unit and position on a static seat", () => {
  const state = { occupant: "Schmieder" };

  it("sets the position before the unit, the way a business card does", () => {
    const c = bandContent(
      staticSeat("Schmieder", "", "Präsidium", "Vizepräsident"),
      state,
      false,
      LABELS
    );
    expect(c.affiliation).toBe("Vizepräsident · Präsidium");
  });

  it("joins nothing when only one of the two is given", () => {
    expect(bandContent(staticSeat("A", "", "Präsidium"), state, false, LABELS).affiliation).toBe(
      "Präsidium"
    );
    expect(
      bandContent(staticSeat("A", "", "", "Vizepräsident"), state, false, LABELS).affiliation
    ).toBe("Vizepräsident");
  });

  /* The requirement, stated as an invariant: an empty field must be
   * indistinguishable from an absent one. `bandLineCount` drives how the band's
   * height is divided, so a line count that grew here would shrink the name to
   * make room for nothing. */
  it("reserves no line, and no height, when both are empty", () => {
    const without = bandContent(staticSeat("Schmieder"), state, false, LABELS);
    expect(without.affiliation).toBeNull();
    expect(bandLineCount(without)).toBe(1);

    const withCaption = bandContent(staticSeat("Schmieder", "Platz 1"), state, false, LABELS);
    expect(bandLineCount(withCaption)).toBe(2);
  });

  it("treats whitespace as empty rather than as a value", () => {
    const c = bandContent(staticSeat("Schmieder", "", "   ", "\t"), state, false, LABELS);
    expect(c.affiliation).toBeNull();
    expect(bandLineCount(c)).toBe(1);
  });

  it("costs exactly one line when either is given", () => {
    const c = bandContent(staticSeat("Schmieder", "", "Präsidium"), state, false, LABELS);
    expect(bandLineCount(c)).toBe(2);
  });

  /* A booking carries neither, so the line can never appear on a calendar seat.
   * This is a property of the sources rather than of the layout: see the comment
   * on `unit` in name-plate-types.ts. */
  it("stays absent on a calendar seat", () => {
    const c = bandContent(calendarSeat("Föhr 1"), { occupant: "Schmieder" }, false, LABELS);
    expect(c.affiliation).toBeNull();
  });
});

describe("fitSharedSize", () => {
  /* A stand-in for the canvas: width grows linearly with size and length, which
   * is close enough to make the search's behaviour observable. */
  const measure = (text: string, size: number) => text.length * size * 0.6;

  it("returns the largest size at which every text still fits", () => {
    const size = fitSharedSize({
      texts: ["Müller"],
      maxWidth: 360,
      maxHeight: 400,
      measure,
      min: 10,
      max: 200,
    });
    expect(measure("Müller", size)).toBeLessThanOrEqual(360);
    expect(measure("Müller", size + 1)).toBeGreaterThan(360);
  });

  /* The whole reason the size is shared: the longest name decides, so the plate
   * does not mix a towering short name with a small long one. */
  it("is governed by the longest text, not the average", () => {
    const together = fitSharedSize({
      texts: ["Ott", "Prof. Dr. Fabian Schmieder"],
      maxWidth: 600,
      maxHeight: 400,
      measure,
      min: 10,
      max: 200,
    });
    const longAlone = fitSharedSize({
      texts: ["Prof. Dr. Fabian Schmieder"],
      maxWidth: 600,
      maxHeight: 400,
      measure,
      min: 10,
      max: 200,
    });
    expect(together).toBe(longAlone);
  });

  it("never exceeds the height it was given", () => {
    const size = fitSharedSize({
      texts: ["Ott"],
      maxWidth: 10_000,
      maxHeight: 42,
      measure,
      min: 10,
      max: 200,
    });
    expect(size).toBe(42);
  });

  /* When even the floor does not fit, return the floor rather than something
   * unreadable: the caller clips, and a 2 px name would be worse than a clipped
   * one. */
  it("returns the minimum when nothing fits", () => {
    const size = fitSharedSize({
      texts: ["Prof. Dr. Fabian Schmieder"],
      maxWidth: 5,
      maxHeight: 400,
      measure,
      min: 12,
      max: 200,
    });
    expect(size).toBe(12);
  });

  it("does not exceed the ceiling it was given", () => {
    const size = fitSharedSize({
      texts: ["Ott"],
      maxWidth: 10_000,
      maxHeight: 10_000,
      measure,
      min: 10,
      max: 64,
    });
    expect(size).toBe(64);
  });
});

describe("namePlateConfigSchema", () => {
  it("accepts a static seat without any provider", () => {
    const cfg = namePlateConfigSchema.parse({
      seats: [{ occupant: { kind: "static", name: "Müller" } }],
    });
    expect(cfg.seats[0]!.occupant.kind).toBe("static");
    expect(cfg.showStatus).toBe(false);
  });

  it("refuses more seats than a plate can show legibly", () => {
    const seats = Array.from({ length: MAX_SEATS + 1 }, (_, i) => ({
      occupant: { kind: "static" as const, name: `P${i}` },
    }));
    expect(namePlateConfigSchema.safeParse({ seats }).success).toBe(false);
  });

  it("refuses a plate with no seats at all", () => {
    expect(namePlateConfigSchema.safeParse({ seats: [] }).success).toBe(false);
  });

  /* A static occupant with an empty name is a configuration mistake that would
   * otherwise render as a blank plate. */
  it("refuses an empty static name", () => {
    expect(
      namePlateConfigSchema.safeParse({ seats: [{ occupant: { kind: "static", name: "" } }] })
        .success
    ).toBe(false);
  });

  /* Unlike door-sign, the timezone is optional so the display's own zone wins by
   * default instead of a hardcoded Europe/Berlin. */
  it("leaves the timezone unset so the display's zone applies", () => {
    const cfg = namePlateConfigSchema.parse({
      seats: [{ occupant: { kind: "static", name: "Müller" } }],
    });
    expect(cfg.timezone).toBeUndefined();
  });
});

describe("resolveRoomName", () => {
  const plate = (over: Record<string, unknown>) =>
    namePlateConfigSchema.parse({
      seats: [{ occupant: { kind: "static", name: "Müller" } }],
      ...over,
    });

  it("prefers what the operator typed", () => {
    expect(resolveRoomName(plate({ roomName: "1J.2.27" }))).toBe("1J.2.27");
  });

  /* An operator who picked seats has already said which room this is, so the
   * header does not need typing again. */
  it("falls back to the room the seats came from", () => {
    const cfg = namePlateConfigSchema.parse({
      seats: [calendarSeat("", "S1 2er Flexbüro Föhr"), calendarSeat("", "S1 2er Flexbüro Föhr")],
    });
    expect(resolveRoomName(cfg)).toBe("S1 2er Flexbüro Föhr");
  });

  /* Guessing one of two rooms would put a wrong name on a wall. */
  it("names none when the seats come from different rooms", () => {
    const cfg = namePlateConfigSchema.parse({
      seats: [calendarSeat("", "Föhr"), calendarSeat("", "Sylt")],
    });
    expect(resolveRoomName(cfg)).toBeNull();
  });

  it("names none for static seats with nothing typed", () => {
    expect(resolveRoomName(plate({}))).toBeNull();
  });

  it("treats a blank room name as unset", () => {
    const cfg = namePlateConfigSchema.parse({
      roomName: "   ",
      seats: [calendarSeat("", "Föhr")],
    });
    expect(resolveRoomName(cfg)).toBe("Föhr");
  });
});

describe("seatBands with a header", () => {
  /* Bands start below the header and still end inside the padding, so adding a
   * header shortens the seats rather than pushing one off the panel. */
  it("keeps every band below the header and inside the panel", () => {
    const headerH = 75;
    const bands = seatBands(4, 800, 480, 20, headerH);
    expect(bands[0]!.y).toBeGreaterThanOrEqual(headerH);
    const last = bands[bands.length - 1]!;
    expect(last.y + last.h).toBeLessThanOrEqual(480 - 20 + 1);
  });

  it("gives seats less height than it would without a header", () => {
    const withHeader = seatBands(4, 800, 480, 20, 75)[0]!.h;
    const without = seatBands(4, 800, 480, 20)[0]!.h;
    expect(withHeader).toBeLessThan(without);
  });
});
