// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The seam between a renderer and its pixels.
 *
 * A renderer asks a `SurfaceFactory` for somewhere to draw instead of calling
 * `createCanvas` itself. In production that is a canvas and nothing changes. In a
 * test it can be a canvas that also RECORDS every piece of text and every filled
 * rectangle, which turns questions about the finished frame into assertions:
 *
 *   - is the occupant's name on this panel at 12:30?
 *   - does any text sit on a ground it cannot be read against?
 *   - does any text run off the edge?
 *
 * None of those are answerable from pixels without OCR, and none were answerable
 * from the renderers' internals either, which is why a running booking silently
 * stopped naming the person in the room (see room-booking-blocks.ts). The record
 * is the missing observation point.
 *
 * It wraps the CONTEXT rather than replacing the drawing helpers, deliberately.
 * Renderers reach for `ctx.fillText` directly in several places, the offline
 * screen does nothing else, and a seam that only covered the helpers would have
 * blind spots exactly where the least-tested code lives.
 */

import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";

/** Somewhere to draw, and the canvas it will end up on. */
export interface Surface {
  readonly canvas: Canvas;
  readonly ctx: SKRSContext2D;
}

export type SurfaceFactory = (width: number, height: number) => Surface;

/** The production factory. A plain canvas, no observation, no overhead. */
export const canvasSurface: SurfaceFactory = (width, height) => {
  const canvas = createCanvas(width, height);
  return { canvas, ctx: canvas.getContext("2d") };
};

/** The ink box of one piece of text, in panel pixels. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DrawnText {
  /** The string handed to `fillText`, before any condensing. */
  text: string;
  /** Where the ink actually landed, alignment and baseline already resolved. */
  box: Box;
  font: string;
  color: string;
  /**
   * True when the advance width exceeded the `maxWidth` argument.
   *
   * Canvas CONDENSES rather than clips, so the string is still complete and still
   * whole on the panel, just narrower. It is recorded because past some ratio a
   * condensed line stops being readable across a room, and because it is the only
   * trace that a renderer asked for more width than it had.
   */
  condensed: boolean;
  /** advance width / maxWidth, or 1 when it fits or no limit was given. */
  squeeze: number;
}

export interface DrawnFill {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

/** Everything a frame was told to draw, in paint order. */
export interface Recording {
  width: number;
  height: number;
  texts: DrawnText[];
  fills: DrawnFill[];
  /**
   * Bitmaps painted onto the frame: QR codes, background images.
   *
   * Counted rather than captured. Their pixels are opaque to this module, so text
   * over one has no resolvable ground, and the contrast invariant has to abstain
   * there. Counting them keeps that abstention visible instead of silent.
   */
  images: number;
}

export interface RecordingSurface extends Surface {
  readonly recording: Recording;
}

function asColor(style: unknown): string {
  return typeof style === "string" ? style : "";
}

/**
 * Where the ink of one `fillText` call lands.
 *
 * `actualBoundingBox*` already accounts for `textAlign` and `textBaseline`, which
 * is why this module reimplements neither. Verified against @napi-rs/canvas: right
 * alignment reports a positive Left and a near-zero Right, and a top baseline
 * moves the ascent to about zero.
 *
 * `maxWidth` CONDENSES rather than clipping, so an over-long string keeps every
 * character and gets narrower. The horizontal extents are scaled by the same
 * ratio; a box that ignored it would report text running off the panel.
 */
function inkOf(
  real: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth?: number
): { box: Box; squeeze: number } {
  const m = real.measureText(text);
  const squeeze = maxWidth && m.width > maxWidth ? maxWidth / m.width : 1;
  return {
    squeeze,
    box: {
      left: x - m.actualBoundingBoxLeft * squeeze,
      right: x + m.actualBoundingBoxRight * squeeze,
      top: y - m.actualBoundingBoxAscent,
      bottom: y + m.actualBoundingBoxDescent,
    },
  };
}

/**
 * A context that draws normally and writes down what it drew.
 *
 * A proxy rather than a hand-written wrapper, so that a renderer reaching for a
 * context member this module has never heard of keeps working. Only the calls
 * that carry meaning are intercepted; `measureText`, the transform stack and the
 * whole path API go straight through to Skia. Measurement happens through the
 * real context at the moment of drawing, so a recorded box carries the font,
 * alignment and baseline that were actually in force.
 */
function recordingProxy(real: SKRSContext2D, recording: Recording): SKRSContext2D {
  const onFillText = (text: string, x: number, y: number, maxWidth?: number) => {
    const { box, squeeze } = inkOf(real, text, x, y, maxWidth);
    recording.texts.push({
      text,
      box,
      font: real.font,
      color: asColor(real.fillStyle),
      condensed: squeeze < 1,
      squeeze,
    });
    if (maxWidth === undefined) real.fillText(text, x, y);
    else real.fillText(text, x, y, maxWidth);
  };

  const onFillRect = (x: number, y: number, w: number, h: number) => {
    recording.fills.push({ x, y, width: w, height: h, color: asColor(real.fillStyle) });
    real.fillRect(x, y, w, h);
  };

  const onBitmap = (prop: string | symbol) => {
    return (...args: unknown[]) => {
      recording.images++;
      const fn = Reflect.get(real, prop, real) as (...a: unknown[]) => unknown;
      return fn.apply(real, args);
    };
  };

  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "fillText") return onFillText;
      if (prop === "fillRect") return onFillRect;
      if (prop === "drawImage" || prop === "putImageData") return onBitmap(prop);
      /* A proxy's get is dynamic by definition: `prop` is whatever the caller
       * asked for, so Reflect.get can only answer `unknown`. Narrowing it to a
       * function is the one distinction this handler needs. */
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value);
    },
  }) as SKRSContext2D;
}

/** A canvas that also writes down what it was asked to draw. */
export function recordingSurface(width: number, height: number): RecordingSurface {
  const canvas = createCanvas(width, height);
  const real = canvas.getContext("2d");
  const recording: Recording = { width, height, texts: [], fills: [], images: 0 };
  return { canvas, ctx: recordingProxy(real, recording), recording };
}

/**
 * A factory that hands out recording surfaces and keeps every recording.
 *
 * A renderer may produce more than one frame per call, and the offline fallback
 * produces a different one than the timeline, so the caller gets the list rather
 * than a single object.
 */
export function recordingFactory(): { factory: SurfaceFactory; recordings: Recording[] } {
  const recordings: Recording[] = [];
  const factory: SurfaceFactory = (width, height) => {
    const surface = recordingSurface(width, height);
    recordings.push(surface.recording);
    return surface;
  };
  return { factory, recordings };
}
