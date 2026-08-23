import { describe, it, expect } from "vitest";
import { seatBands, bandContent, bandLineCount, fitSharedSize } from "../name-plate-layout";
import { seatSchema, namePlateConfigSchema, resolveRoomName, MAX_SEATS } from "../name-plate-types";

const staticSeat = (name: string, caption = "") =>
  seatSchema.parse({ caption, occupant: { kind: "static", name } });

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
      expect(bands[i].y).toBeGreaterThanOrEqual(bands[i - 1].y + bands[i - 1].h);
    }
  });

  it("stays inside the padded area", () => {
    const pad = 20;
    const bands = seatBands(3, 800, 480, pad);
    expect(bands[0].y).toBeGreaterThanOrEqual(pad);
    const last = bands[bands.length - 1];
    expect(last.y + last.h).toBeLessThanOrEqual(480 - pad + 1); /* rounding */
  });

  /* Gaps go BETWEEN bands only. Counting the edge twice is how a four-seat plate
   * would silently get less usable height than three seats deserve. */
  it("spends gap only between bands, so one seat uses the whole area", () => {
    const [single] = seatBands(1, 800, 480, 20);
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
    expect(bands[0].h).toBeGreaterThan(seatBands(4, 800, 480, 20)[0].h);
  });
});

const LABELS = { free: "Frei", unknown: "Keine Verbindung" };

describe("bandContent", () => {
  /* The roles are fixed: the ROOM is in the header, the SEAT is the caption, the
   * big line is the person. The bug this replaced put the resource name in the
   * big line whenever a seat was free, so an empty desk rendered as
   * "Föhr 1 (1J.2.27)" in the slot meant for a person and read like one. */
  it("says nobody is there instead of putting the place in the name slot", () => {
    const c = bandContent(
      calendarSeat(),
      { occupant: null, placeLabel: "Föhr 1 (1J.2.27)" },
      false,
      LABELS
    );
    expect(c.name).toBe("Frei");
    expect(c.caption).toBe("Föhr 1 (1J.2.27)");
  });

  it("puts the occupant in the name slot and the seat in the caption", () => {
    const c = bandContent(
      calendarSeat(),
      { occupant: "Schmieder", placeLabel: "Föhr 1", detail: "bis 12:00" },
      true,
      LABELS
    );
    expect(c).toMatchObject({ caption: "Föhr 1", name: "Schmieder", status: "bis 12:00" });
  });

  /* showStatus governs the DETAIL, not whether the state is admitted: a plate that
   * cannot say "free" is not a door sign, and is indistinguishable from a failed
   * lookup. */
  it("still reveals a free seat when the detail is switched off", () => {
    const c = bandContent(calendarSeat(), { occupant: null, placeLabel: "Föhr 1" }, false, LABELS);
    expect(c.name).toBe("Frei");
    expect(c.status).toBeNull();
  });

  it("drops only the detail when status is switched off", () => {
    const c = bandContent(
      calendarSeat(),
      { occupant: "Schmieder", placeLabel: "Föhr 1", detail: "bis 12:00" },
      false,
      LABELS
    );
    expect(c.name).toBe("Schmieder");
    expect(c.status).toBeNull();
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
   * no state, so it composes one line. */
  it("gives a static seat its name and nothing else", () => {
    const c = bandContent(staticSeat("Müller"), { occupant: "Müller" }, true, LABELS);
    expect(c).toMatchObject({ caption: null, name: "Müller", status: null });
    expect(bandLineCount(c)).toBe(1);
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
    expect(off.name).toBe("Keine Verbindung");
    expect(off.name).not.toBe(
      bandContent(calendarSeat(), { occupant: null, placeLabel: "Föhr 1" }, false, LABELS).name
    );
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
    expect(cfg.seats[0].occupant.kind).toBe("static");
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
    expect(bands[0].y).toBeGreaterThanOrEqual(headerH);
    const last = bands[bands.length - 1];
    expect(last.y + last.h).toBeLessThanOrEqual(480 - 20 + 1);
  });

  it("gives seats less height than it would without a header", () => {
    const withHeader = seatBands(4, 800, 480, 20, 75)[0].h;
    const without = seatBands(4, 800, 480, 20)[0].h;
    expect(withHeader).toBeLessThan(without);
  });
});
