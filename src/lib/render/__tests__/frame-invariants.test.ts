// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Each invariant has to fail on the frame it was written for, and pass on a sound
 * one. A check that cannot fail is worse than no check, because it reads as
 * coverage.
 */

import { describe, it, expect } from "vitest";
import { recordingSurface } from "../surface";
import { checkFrame, groundsUnder, textsOf } from "../frame-invariants";
import { ensureRenderFonts } from "../fonts";

const FF = ensureRenderFonts();

/** A frame with a white ground and whatever the caller draws on it. */
function frame(draw: (ctx: ReturnType<typeof recordingSurface>["ctx"]) => void) {
  const s = recordingSurface(400, 200);
  s.ctx.fillStyle = "#FFFFFF";
  s.ctx.fillRect(0, 0, 400, 200);
  s.ctx.font = `24px ${FF}`;
  draw(s.ctx);
  return s.recording;
}

describe("bounds", () => {
  it("passes for text inside the panel", () => {
    const rec = frame((ctx) => {
      ctx.fillStyle = "#000000";
      ctx.fillText("Warnking", 20, 100);
    });
    expect(checkFrame(rec)).toEqual([]);
  });

  it("fails for text running off the right edge", () => {
    const rec = frame((ctx) => {
      ctx.fillStyle = "#000000";
      ctx.fillText("Prof. Dr. Fabian Schmieder", 320, 100);
    });
    const out = checkFrame(rec);
    expect(out).toHaveLength(1);
    expect(out[0]!.invariant).toBe("bounds");
    expect(out[0]!.detail).toContain("right");
  });

  it("fails for text above the top edge", () => {
    const rec = frame((ctx) => {
      ctx.fillStyle = "#000000";
      ctx.fillText("Warnking", 20, 4);
    });
    expect(checkFrame(rec).map((v) => v.invariant)).toEqual(["bounds"]);
  });

  it("tolerates a descender touching the edge", () => {
    const rec = frame((ctx) => {
      ctx.fillStyle = "#000000";
      ctx.fillText("Gg", 20, 199);
    });
    expect(checkFrame(rec, { boundsSlackPx: 6 })).toEqual([]);
  });
});

describe("contrast", () => {
  it("fails for black on black", () => {
    const rec = frame((ctx) => {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 60, 400, 60);
      ctx.fillStyle = "#000000";
      ctx.fillText("Warnking", 20, 100);
    });
    const out = checkFrame(rec);
    expect(out.map((v) => v.invariant)).toEqual(["contrast"]);
    expect(out[0]!.detail).toContain("1.00:1");
  });

  it("fails for white on white, which is how the mono theme failed", () => {
    const rec = frame((ctx) => {
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText("Warnking", 20, 100);
    });
    expect(checkFrame(rec).map((v) => v.invariant)).toEqual(["contrast"]);
  });

  it("passes for white on the ground a block was filled with", () => {
    const rec = frame((ctx) => {
      ctx.fillStyle = "#333333";
      ctx.fillRect(0, 60, 400, 60);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText("Warnking", 20, 100);
    });
    expect(checkFrame(rec)).toEqual([]);
  });

  /* Painter's algorithm: the LAST fill covering a point is the ground. Reading the
   * first would judge every block's text against the page. */
  it("takes the topmost fill as the ground", () => {
    const rec = frame((ctx) => {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 60, 400, 60);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText("Warnking", 20, 100);
    });
    expect(groundsUnder(rec, rec.texts[0]!)).toEqual(["#000000"]);
    expect(checkFrame(rec)).toEqual([]);
  });

  it("abstains where nothing was filled, rather than guessing", () => {
    const s = recordingSurface(400, 200);
    s.ctx.font = `24px ${FF}`;
    s.ctx.fillStyle = "#FEFEFE";
    s.ctx.fillText("Warnking", 20, 100);
    expect(groundsUnder(s.recording, s.recording.texts[0]!)).toEqual([]);
    expect(checkFrame(s.recording)).toEqual([]);
  });

  it("reports both grounds when text straddles a block edge", () => {
    const rec = frame((ctx) => {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 60, 60, 60);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText("Warnking", 20, 100);
    });
    expect(groundsUnder(rec, rec.texts[0]!).sort()).toEqual(["#000000", "#FFFFFF"]);
    /* White is unreadable on the white half, and that is the finding. */
    expect(checkFrame(rec).map((v) => v.invariant)).toEqual(["contrast"]);
  });
});

describe("reads", () => {
  const sound = () =>
    frame((ctx) => {
      ctx.fillStyle = "#000000";
      ctx.fillText("Maria Warnking", 20, 100);
    });

  it("passes when the string is on the frame", () => {
    expect(checkFrame(sound(), { mustRead: ["Maria Warnking"] })).toEqual([]);
  });

  it("passes on a substring of a longer line", () => {
    expect(checkFrame(sound(), { mustRead: ["Warnking"] })).toEqual([]);
  });

  it("ignores case and repeated whitespace", () => {
    expect(checkFrame(sound(), { mustRead: ["  maria   WARNKING "] })).toEqual([]);
  });

  it("fails when the string is nowhere", () => {
    const out = checkFrame(sound(), { mustRead: ["Lukas Thiele"] });
    expect(out.map((v) => v.invariant)).toEqual(["reads"]);
    expect(out[0]!.detail).toContain("Lukas Thiele");
  });

  it("names every missing string, not just the first", () => {
    const out = checkFrame(sound(), { mustRead: ["Lukas Thiele", "Ana de la Cruz"] });
    expect(out).toHaveLength(2);
  });
});

describe("legible", () => {
  it("fails when the only drawing of a string is squeezed past the floor", () => {
    const rec = frame((ctx) => {
      ctx.fillStyle = "#000000";
      ctx.fillText("Maria Warnking", 20, 100, 40);
    });
    const out = checkFrame(rec, { mustRead: ["Maria Warnking"] });
    expect(out.map((v) => v.invariant)).toEqual(["legible"]);
  });

  /* A renderer may draw the same string twice, once squeezed into a narrow band
   * and once at full width. The widest drawing is the one a reader sees. */
  it("passes when one drawing of it is unsqueezed", () => {
    const rec = frame((ctx) => {
      ctx.fillStyle = "#000000";
      ctx.fillText("Maria Warnking", 20, 60, 40);
      ctx.fillText("Maria Warnking", 20, 140);
    });
    expect(checkFrame(rec, { mustRead: ["Maria Warnking"] })).toEqual([]);
  });
});

describe("state", () => {
  const withLabel = (label: string) =>
    frame((ctx) => {
      ctx.fillStyle = "#000000";
      ctx.fillText(label, 20, 100);
    });

  it("passes with exactly one label", () => {
    expect(checkFrame(withLabel("BELEGT"), { exactlyOneOf: ["FREI", "BELEGT"] })).toEqual([]);
  });

  it("fails with none", () => {
    const out = checkFrame(withLabel("Projektbesprechung"), {
      exactlyOneOf: ["FREI", "BELEGT"],
    });
    expect(out.map((v) => v.invariant)).toEqual(["state"]);
    expect(out[0]!.detail).toContain("no state label");
  });

  it("fails when both appear, because the sign then says nothing", () => {
    const rec = frame((ctx) => {
      ctx.fillStyle = "#000000";
      ctx.fillText("FREI", 20, 80);
      ctx.fillText("BELEGT", 20, 140);
    });
    const out = checkFrame(rec, { exactlyOneOf: ["FREI", "BELEGT"] });
    expect(out[0]!.detail).toContain("ambiguous");
  });

  it("is not checked at all when no labels are given", () => {
    expect(checkFrame(withLabel("Projektbesprechung"))).toEqual([]);
  });
});

describe("textsOf", () => {
  it("lists the drawn strings in paint order", () => {
    const rec = frame((ctx) => {
      ctx.fillStyle = "#000000";
      ctx.fillText("one", 10, 60);
      ctx.fillText("two", 10, 120);
    });
    expect(textsOf(rec)).toEqual(["one", "two"]);
  });
});
