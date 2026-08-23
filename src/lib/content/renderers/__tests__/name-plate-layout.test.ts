import { describe, it, expect } from "vitest";
import { seatBands, bandContent, bandLineCount, fitSharedSize } from "../name-plate-layout";
import { seatSchema, namePlateConfigSchema, MAX_SEATS } from "../name-plate-types";

const staticSeat = (name: string, caption = "") =>
  seatSchema.parse({ caption, occupant: { kind: "static", name } });

const calendarSeat = (caption = "") =>
  seatSchema.parse({
    caption,
    occupant: {
      kind: "calendar",
      providerId: "123e4567-e89b-42d3-a456-426614174000",
      resourceId: "room-1",
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

describe("bandContent", () => {
  /* The decision the operator asked for: a static seat has no booking state, and
   * its band omits the line instead of reserving an empty one. */
  it("gives a static seat no status even when the plate shows status", () => {
    const c = bandContent(staticSeat("Müller"), { name: "Müller", status: "Belegt" }, true);
    expect(c.status).toBeNull();
    expect(bandLineCount(c)).toBe(1);
  });

  it("gives a calendar seat its status when the plate shows status", () => {
    const c = bandContent(calendarSeat(), { name: "Schmieder", status: "Belegt" }, true);
    expect(c.status).toBe("Belegt");
    expect(bandLineCount(c)).toBe(2);
  });

  it("withholds status from a calendar seat when the plate does not show it", () => {
    const c = bandContent(calendarSeat(), { name: "Schmieder", status: "Belegt" }, false);
    expect(c.status).toBeNull();
  });

  /* A caption is the place, not the person, so it is independent of the source. */
  it("keeps a caption for either kind of seat", () => {
    expect(
      bandContent(staticSeat("Müller", "Platz 1"), { name: "Müller", status: null }, false).caption
    ).toBe("Platz 1");
    expect(
      bandContent(calendarSeat("Platz 2"), { name: "Schmieder", status: null }, false).caption
    ).toBe("Platz 2");
  });

  /* An empty caption means "no caption", so whitespace must not buy a line. */
  it("treats a blank caption as absent", () => {
    const c = bandContent(staticSeat("Müller", "   "), { name: "Müller", status: null }, false);
    expect(c.caption).toBeNull();
    expect(bandLineCount(c)).toBe(1);
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
