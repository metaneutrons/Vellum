// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Content renderer interface — plugin system for display content.
 *
 * A renderer is two steps, and the split is the point rather than a tidiness
 * exercise. `load` gathers everything the frame depends on and is the ONLY step
 * allowed to touch the outside world. `draw` turns that into pixels and is
 * deterministic: given the same model it produces the same frame, on any machine,
 * at any time of day.
 *
 * Before the split, one method did both. The consequence was measurable rather
 * than theoretical: the renderer with the most layout logic sat at 51.9 % of
 * statements and 38.6 % of branches, because nothing about it could be exercised
 * without a database and a calendar provider, while the modules next to it that
 * had been split into pure decisions sat at 98 to 100 %. Coverage was following
 * decomposition, not diligence. A defect that hid in that gap for months is
 * described in `renderers/room-booking-blocks.ts`.
 *
 * `DrawParams` therefore carries no clock and no `timezone`. Anything that
 * depends on the moment belongs in the model, put there by `load`. A frame's
 * instant is DATA; reading the wall clock while painting is not.
 */

import type { Canvas } from "@napi-rs/canvas";
import type { z } from "zod";
import type { Theme } from "@/lib/theme";
import type { ResolvedDisplay } from "@/lib/display";
import type { SurfaceFactory } from "@/lib/render/surface";

/** Everything `load` may look at. */
export interface LoadParams {
  config: unknown;
  now: Date;
  /**
   * The display's timezone, resolved from its device override or its site.
   *
   * A fallback, not an override: a renderer whose own config names a zone keeps
   * it. Before this existed the room-booking renderer defaulted to UTC while the
   * schedule logic used the server clock, so two parts of the same response could
   * disagree about what time it was at the display.
   */
  timezone?: string;
}

/** Everything `draw` may look at. Note what is missing: the clock. */
export interface DrawParams {
  theme: Theme;
  display: ResolvedDisplay;
  /**
   * Where to draw. Defaults to a plain canvas, which is what the render route and
   * the preview both want.
   *
   * A renderer must create its canvases through this rather than calling
   * `createCanvas`, so that a test can pass a surface which records what was
   * drawn and then assert properties of the finished frame. See
   * `lib/render/surface.ts` and `lib/render/frame-invariants.ts`. The alternative,
   * reading the properties back out of pixels, needs OCR; the alternative of
   * asserting them inside the renderers needs the assertions written once per
   * renderer and gets them written nowhere.
   */
  surface?: SurfaceFactory;
}

/** Both halves at once, for the two routes that do the whole job. */
export interface RenderParams extends LoadParams, DrawParams {}

export interface DrawResult {
  canvas: Canvas;
  /** Optional: override the device's refresh profile (e.g. carousel at 60s) */
  sleepOverrideS?: number;
  /**
   * Next moment at which the content becomes time-sensitive. The profile engine
   * uses this to wake shortly before a booking without understanding provider
   * data or leaking event details into the firmware.
   */
  nextEventStart?: Date | null;
}

/** @deprecated Use `DrawResult`. Kept so the name still resolves in older code. */
export type RenderResult = DrawResult;

export interface ContentRenderer<M = unknown> {
  slug: string;
  name: string;
  /**
   * Retired: still RENDERS, cannot be CREATED.
   *
   * The two halves are the point. Removing a renderer outright is a breaking
   * change for any instance that still names it, because `getContentRenderer`
   * returns undefined and the render route answers 500, which on a wall is a
   * display that stops updating. So a type on its way out keeps rendering
   * indefinitely and merely disappears from the list an operator can pick from.
   *
   * Enforced in `createContentInstance`, not only hidden in the UI: a hidden
   * option is a suggestion, and this is a rule.
   */
  deprecated?: boolean;
  configSchema: z.ZodType;

  /**
   * Parse the config and gather what the frame depends on.
   *
   * The only step that may read a database, call a provider, or look at a clock.
   * Whatever it returns must be enough for `draw` on its own, which is what lets
   * a test paint a frame from a model it wrote by hand.
   */
  load(params: LoadParams): Promise<M>;

  /**
   * Paint the model. Deterministic, and offline by construction.
   *
   * Declared as a method rather than a property so that TypeScript checks the
   * model parameter bivariantly. The registry holds renderers with different
   * model types behind one `ContentRenderer<unknown>`, which a strictly
   * contravariant signature would reject; the pairing of `load` and `draw` is
   * guaranteed by them living in the same object, not by the registry's type.
   */
  draw(model: M, params: DrawParams): DrawResult;
}
