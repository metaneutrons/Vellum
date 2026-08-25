// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The recording surface is the observation point every frame invariant rests on,
 * so its own arithmetic needs checking. Three things could quietly be wrong and
 * would make the invariants pass on frames that are broken: the ink box, the
 * condensing ratio, and the pass-through for context members it does not
 * intercept.
 */

import { describe, it, expect } from "vitest";
import { canvasSurface, recordingSurface, recordingFactory } from "../surface";
import { ensureRenderFonts } from "../fonts";

const FF = ensureRenderFonts();

describe("canvasSurface", () => {
  it("hands out a canvas of the requested size and its context", () => {
    const { canvas, ctx } = canvasSurface(320, 240);
    expect([canvas.width, canvas.height]).toEqual([320, 240]);
    expect(typeof ctx.fillText).toBe("function");
  });
});

describe("recordingSurface: the ink box", () => {
  it("resolves left alignment to a box starting at the pen", () => {
    const { ctx, recording } = recordingSurface(400, 100);
    ctx.font = `32px ${FF}`;
    ctx.fillText("Warnking", 50, 60);
    const [t] = recording.texts;
    expect(t.text).toBe("Warnking");
    expect(t.box.left).toBeCloseTo(50, 0);
    expect(t.box.right).toBeGreaterThan(150);
    /* The alphabetic baseline sits at y, so ink reaches above it and descenders
     * below. A box that started at y would put every line one ascent too low. */
    expect(t.box.top).toBeLessThan(60);
    expect(t.box.bottom).toBeGreaterThan(60);
  });

  it("resolves right alignment to a box ending at the pen", () => {
    const { ctx, recording } = recordingSurface(400, 100);
    ctx.font = `32px ${FF}`;
    ctx.textAlign = "right";
    ctx.fillText("Warnking", 300, 60);
    const [t] = recording.texts;
    expect(t.box.right).toBeLessThanOrEqual(300);
    expect(t.box.left).toBeLessThan(200);
  });

  it("resolves centre alignment symmetrically around the pen", () => {
    const { ctx, recording } = recordingSurface(400, 100);
    ctx.font = `32px ${FF}`;
    ctx.textAlign = "center";
    ctx.fillText("Warnking", 200, 60);
    const [t] = recording.texts;
    const mid = (t.box.left + t.box.right) / 2;
    /* Within a couple of pixels rather than exactly: the box is the INK, and the
     * right side bearing of the last glyph is not the left bearing of the first. */
    expect(Math.abs(mid - 200)).toBeLessThan(2);
  });

  it("follows textBaseline, so a top baseline puts the ink below the pen", () => {
    const { ctx, recording } = recordingSurface(400, 100);
    ctx.font = `32px ${FF}`;
    ctx.textBaseline = "top";
    ctx.fillText("Warnking", 10, 20);
    const [t] = recording.texts;
    /* The claim is that the ink starts AT the pen rather than an ascent above it,
     * which is where an alphabetic baseline would put it: at 32 px that would be
     * near y - 24. A pixel or two of overshoot above the em box is the font's
     * own, and expected. */
    expect(t.box.top).toBeGreaterThan(20 - 4);
    expect(t.box.bottom).toBeGreaterThan(40);
  });
});

describe("recordingSurface: condensing", () => {
  it("reports a squeeze of one when the text fits", () => {
    const { ctx, recording } = recordingSurface(400, 100);
    ctx.font = `16px ${FF}`;
    ctx.fillText("Warnking", 10, 50, 300);
    expect(recording.texts[0].condensed).toBe(false);
    expect(recording.texts[0].squeeze).toBe(1);
  });

  it("reports the ratio when maxWidth squeezes the text, and narrows the box", () => {
    const { ctx, recording } = recordingSurface(400, 100);
    ctx.font = `32px ${FF}`;
    ctx.fillText("Prof. Dr. Fabian Schmieder", 10, 50, 60);
    const [t] = recording.texts;
    expect(t.condensed).toBe(true);
    expect(t.squeeze).toBeLessThan(0.5);
    /* Canvas condenses rather than clipping, so the ink stays inside maxWidth.
     * A box that ignored this would report text running off the panel. */
    expect(t.box.right - t.box.left).toBeLessThanOrEqual(61);
  });
});

describe("recordingSurface: fills and images", () => {
  it("records a rectangle with the fill style in force", () => {
    const { ctx, recording } = recordingSurface(100, 100);
    ctx.fillStyle = "#123456";
    ctx.fillRect(1, 2, 30, 40);
    expect(recording.fills).toEqual([{ x: 1, y: 2, width: 30, height: 40, color: "#123456" }]);
  });

  it("counts bitmaps instead of capturing them", () => {
    const { ctx, recording } = recordingSurface(50, 50);
    const data = ctx.createImageData(4, 4);
    ctx.putImageData(data, 0, 0);
    expect(recording.images).toBe(1);
  });
});

describe("recordingSurface: pass-through", () => {
  it("leaves everything it does not intercept working", () => {
    const { ctx, canvas } = recordingSurface(100, 100);
    ctx.font = `16px ${FF}`;
    expect(ctx.measureText("x").width).toBeGreaterThan(0);
    ctx.save();
    ctx.translate(5, 5);
    ctx.beginPath();
    ctx.arc(10, 10, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    expect(canvas.toBuffer("image/png").length).toBeGreaterThan(0);
  });

  it("still paints, so a recording surface can produce a real frame", () => {
    const { ctx, canvas } = recordingSurface(20, 20);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, 20, 20);
    const before = canvas.getContext("2d").getImageData(10, 10, 1, 1).data[0];
    expect(before).toBe(255);
  });
});

describe("recordingFactory", () => {
  it("keeps one recording per surface handed out, in order", () => {
    const { factory, recordings } = recordingFactory();
    factory(10, 10).ctx.fillText("first", 0, 5);
    factory(20, 20).ctx.fillText("second", 0, 5);
    expect(recordings.map((r) => r.texts[0].text)).toEqual(["first", "second"]);
    expect(recordings.map((r) => r.width)).toEqual([10, 20]);
  });
});
