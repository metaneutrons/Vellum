// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * A theme holds ONE text colour for pairs of grounds that need opposite ones, and
 * `readableOn` is what keeps that from erasing text.
 *
 * The cases below are not hypothetical. Every one of them was rendering on a panel:
 * the free badge drew white on white (mono) and white on bright green (six-colour),
 * and an event block drew black on black (mono) and black on blue (six-colour). On
 * the mono panel the whole booking list was a row of featureless bars.
 */

import { describe, it, expect } from "vitest";
import { contrastRatio, readableOn, resolveTheme, snapThemeToPalette, THEME_MONO } from "../theme";
import { DISPLAY_REGISTRY } from "../display";
import { ACCENTS } from "../content/renderers/name-plate-draw";

describe("contrastRatio", () => {
  it("spans 1 to 21", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
    expect(contrastRatio("#4B4B4B", "#4B4B4B")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#0000FF", "#FFFFFF")).toBeCloseTo(contrastRatio("#FFFFFF", "#0000FF"), 6);
  });

  /* Not a perceptual nicety: it is why black on pure blue fails. Blue carries 7 % of
   * the luminance and green 72 %, so the same "bright" colour behaves oppositely. */
  it("weights the channels, so blue is dark and green is light", () => {
    expect(contrastRatio("#0000FF", "#000000")).toBeLessThan(3);
    expect(contrastRatio("#00FF00", "#FFFFFF")).toBeLessThan(3);
  });
});

describe("readableOn", () => {
  it("leaves a legible choice alone", () => {
    expect(readableOn("#000000", "#FFFFFF")).toBe("#FFFFFF");
    expect(readableOn("#0000FF", "#FFFFFF")).toBe("#FFFFFF");
    /* 4.00:1 on red is above the floor and is the operator's business. */
    expect(readableOn("#FF0000", "#FFFFFF")).toBe("#FFFFFF");
  });

  it("replaces an illegible one with whichever of black or white contrasts more", () => {
    expect(readableOn("#FFFFFF", "#FFFFFF")).toBe("#000000");
    expect(readableOn("#000000", "#000000")).toBe("#FFFFFF");
    expect(readableOn("#00FF00", "#FFFFFF")).toBe("#000000");
    expect(readableOn("#0000FF", "#000000")).toBe("#FFFFFF");
  });

  it("always returns something readable", () => {
    for (const bg of ["#000000", "#FFFFFF", "#0000FF", "#00FF00", "#FF0000", "#555555"]) {
      for (const pref of ["#000000", "#FFFFFF", "#888888"]) {
        expect(contrastRatio(bg, readableOn(bg, pref))).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("honours a caller that demands more", () => {
    expect(readableOn("#FF0000", "#FFFFFF", 4.5)).toBe("#000000");
  });
});

describe("the built-in themes, per panel", () => {
  /* Every pair a renderer actually fills and writes on. Guarding these is what makes
   * the difference between a booking list and a row of black bars. */
  function pairs(T: ReturnType<typeof resolveTheme>) {
    return [
      [T.busyBadge, T.badgeText],
      [T.freeBadge, T.badgeText],
      [T.eventBg, T.slotText],
      [T.busyBadge, T.slotText],
      [T.eventBg, T.slotSecondary],
    ] as const;
  }

  it("is readable on every panel once guarded", () => {
    for (const key of Object.keys(DISPLAY_REGISTRY)) {
      const reg = DISPLAY_REGISTRY[key]!;
      const T = snapThemeToPalette(resolveTheme(reg.palette.length), reg.palette);
      for (const [bg, pref] of pairs(T)) {
        expect(
          contrastRatio(bg, readableOn(bg, pref)),
          `${key}: ${pref} on ${bg}`
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  /* The mono theme carries no mid-tone any more. One used to snap to white and erase
   * the name plate; another said `#444444` while the panel showed black. */
  it("gives the mono theme only black and white", () => {
    for (const [key, value] of Object.entries(THEME_MONO)) {
      if (key === "name") continue;
      expect(["#000000", "#FFFFFF"], `${key} = ${value}`).toContain(value);
    }
  });
});

describe("snapping onto a greyscale palette", () => {
  const grey = DISPLAY_REGISTRY.e1003.palette;
  const colour = DISPLAY_REGISTRY.e1002.palette;

  /* The defect this replaced: Euclidean distance to a grey ramp depends only on the
   * SUM of the channels, and pure red, green and blue all share it, so all three
   * landed on one grey. Of the E1003's sixteen levels the theme reached two, and a
   * free badge was indistinguishable from a busy one. */
  it("gives the three primaries three different greys", () => {
    const t = snapThemeToPalette(
      {
        ...THEME_MONO,
        name: "probe",
        freeBadge: "#00FF00",
        busyBadge: "#FF0000",
        eventBg: "#0000FF",
      },
      grey
    );
    expect(new Set([t.freeBadge, t.busyBadge, t.eventBg]).size).toBe(3);
  });

  it("orders them by perceived lightness, green above red above blue", () => {
    const t = snapThemeToPalette(
      {
        ...THEME_MONO,
        name: "probe",
        freeBadge: "#00FF00",
        busyBadge: "#FF0000",
        eventBg: "#0000FF",
      },
      grey
    );
    expect(contrastRatio(t.freeBadge, "#000000")).toBeGreaterThan(
      contrastRatio(t.busyBadge, "#000000")
    );
    expect(contrastRatio(t.busyBadge, "#000000")).toBeGreaterThan(
      contrastRatio(t.eventBg, "#000000")
    );
  });

  it("leaves black and white exactly where they are", () => {
    const t = snapThemeToPalette(THEME_MONO, grey);
    expect(t.headerBg).toBe("#000000");
    expect(t.headerText).toBe("#FFFFFF");
    expect(t.background).toBe("#FFFFFF");
  });

  /* A palette with hue keeps the Euclidean match, where it is the right question. */
  it("does not touch a palette that has hue", () => {
    const t = snapThemeToPalette(resolveTheme(colour.length), colour);
    expect(t.freeBadge).toBe("#00FF00");
    expect(t.busyBadge).toBe("#FF0000");
    expect(t.eventBg).toBe("#0000FF");
  });
});

describe("header accents", () => {
  it("gives every accent its own grey level", () => {
    const greys = Object.values(ACCENTS).map((a) => a.grey);
    expect(new Set(greys).size).toBe(greys.length);
  });

  /* A bar that cannot be told from the page is not a marker. Deriving each grey from
   * its hue's lightness put green at 87 % and yellow at 97 %, or 1.4:1 and 1.0:1
   * against white, which is why the levels are chosen instead. */
  it("keeps every accent visible as a bar on white, and its text readable", () => {
    for (const [name, accent] of Object.entries(ACCENTS)) {
      expect(contrastRatio(accent.grey, "#FFFFFF"), `${name} bar on white`).toBeGreaterThanOrEqual(
        3
      );
      expect(
        contrastRatio(accent.grey, readableOn(accent.grey, "#FFFFFF")),
        `${name} header text`
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the hues' lightness order, so an operator's expectation survives", () => {
    const order = ["blue", "red", "green", "yellow"];
    const lightness = order.map((k) => contrastRatio(ACCENTS[k]!.grey, "#000000"));
    for (let i = 1; i < lightness.length; i++) {
      expect(lightness[i]!, order[i]).toBeGreaterThan(lightness[i - 1]!);
    }
  });

  /* Black is the unaccented header, so no accent may collide with it. */
  it("never proposes the unaccented black", () => {
    for (const accent of Object.values(ACCENTS)) expect(accent.grey).not.toBe("#000000");
  });
});
