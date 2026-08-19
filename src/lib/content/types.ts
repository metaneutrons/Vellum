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
  configSchema: z.ZodType;

  /** Fetch live data + render to canvas */
  render(params: RenderParams): Promise<RenderResult>;
}
