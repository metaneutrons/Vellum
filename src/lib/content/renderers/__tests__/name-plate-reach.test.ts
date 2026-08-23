// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The editor tells an operator how far a plate can be read, and that number comes
 * from a constant. A constant copied by hand out of a measurement drifts away from
 * the renderer silently, and this is the one figure that tells someone what a
 * fourth seat costs, so it is recomputed here from the renderer's own size plan.
 */

import { describe, it, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { CAP_RATIO } from "../name-plate-scale";
import { choosePlan } from "../name-plate-sizes";
import { bandContent, seatBands } from "../name-plate-layout";
import { seatSchema, READING_DISTANCE_M } from "../name-plate-types";
import { ensureRenderFonts, narrowFontFamily } from "@/lib/render/fonts";

const LABELS = { free: "Frei", busy: "Belegt", unknown: "Keine Verbindung" };
/** E1001: 800 x 480 across a 163.2 mm active area. */
const PITCH_MM = 0.204;
/** The signage rule of thumb, height = distance / 200, as an angle. */
const COMFORT_ARCMIN = 17;

/** What the renderer would choose for `n` seats of a full academic name. */
function reachMetres(n: number): { rowMode: boolean; metres: number } {
  const canvas = createCanvas(800, 480);
  const ctx = canvas.getContext("2d");
  const families = [ensureRenderFonts(), narrowFontFamily()].filter((f): f is string => !!f);
  const seats = Array.from({ length: n }, (_, i) =>
    seatSchema.parse({
      caption: `Platz ${i + 1}`,
      occupant: { kind: "static", name: "Prof. Dr. Fabian Schmieder" },
    })
  );
  const contents = seats.map((s) =>
    bandContent(s, { occupant: "Prof. Dr. Fabian Schmieder" }, false, LABELS, n > 1)
  );
  /* Mirrors the renderer's own geometry: 6 % padding, a 75 px header and the
   * 60 px footer that carries the freshness mark. */
  const bands = seatBands(n, 800, 480 - 60, 29, 75);
  const plan = choosePlan(ctx, families, contents, {
    bandW: bands[0].w,
    bandH: bands[0].h,
    shortSide: 480,
    reserved: 0,
    scale: 1,
  });
  const capMm = plan.sizes.surname * CAP_RATIO * PITCH_MM;
  return {
    rowMode: plan.rowMode,
    metres: capMm / Math.tan((COMFORT_ARCMIN / 60) * (Math.PI / 180)) / 1000,
  };
}

describe("reading distance", () => {
  it("matches what the editor promises, to a tenth of a metre", () => {
    for (const n of [1, 2, 3, 4]) {
      expect(reachMetres(n).metres).toBeCloseTo(READING_DISTANCE_M[n], 1);
    }
  });

  /* The property that made the mode choice measured rather than threshold-based.
   * With a fixed switch at three seats, a two-seat plate stacked and reached
   * 1.8 m while a three-seat plate rowed and reached 2.0 m, so ADDING a seat
   * improved legibility. An operator would meet that head-on. */
  it("never improves when a seat is added", () => {
    const reach = [1, 2, 3, 4].map((n) => reachMetres(n).metres);
    for (let i = 1; i < reach.length; i++) {
      expect(reach[i]).toBeLessThan(reach[i - 1]);
    }
  });

  /* Where the two compositions win, asserted so that a change to either one has
   * to confront the consequence for the office door. */
  it("stacks a single seat and rows the rest", () => {
    expect(reachMetres(1).rowMode).toBe(false);
    for (const n of [2, 3, 4]) expect(reachMetres(n).rowMode).toBe(true);
  });
});
