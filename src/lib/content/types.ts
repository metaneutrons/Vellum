// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Content renderer interface — plugin system for display content.
 *
 * Each renderer fetches its own data, renders to a canvas at the
 * device's native resolution, and respects the display's capabilities.
 */

import type { Canvas } from "@napi-rs/canvas";
import type { z } from "zod";
import type { Theme } from "@/lib/theme";
import type { ResolvedDisplay } from "@/lib/display";

export interface RenderParams {
  config: unknown;
  theme: Theme;
  display: ResolvedDisplay;
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

export interface RenderResult {
  canvas: Canvas;
  /** Optional: override the device's refresh profile (e.g. carousel at 60s) */
  sleepOverrideS?: number;
}

export interface ContentRenderer {
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

  /** Fetch live data + render to canvas */
  render(params: RenderParams): Promise<RenderResult>;
}
