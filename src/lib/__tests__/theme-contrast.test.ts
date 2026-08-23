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
      const reg = DISPLAY_REGISTRY[key];
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
