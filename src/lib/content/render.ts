// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Both halves of a renderer, for callers that want the whole job.
 *
 * The render route and the preview route both want a finished frame, so they call
 * this rather than the two steps. Keeping the composition in one place is what
 * makes the eventual caching change a one-line edit here instead of an edit in
 * every route: `load` depends on the content instance and the clock, `draw` on the
 * panel and the theme, so N displays showing the same room can share one `load`
 * and each run its own `draw`. Today each display does both.
 */

import type { ContentRenderer, DrawResult, RenderParams } from "./types";

export async function renderContent(
  renderer: ContentRenderer,
  params: RenderParams
): Promise<DrawResult> {
  const model = await renderer.load({
    config: params.config,
    now: params.now,
    timezone: params.timezone,
  });
  return renderer.draw(model, {
    theme: params.theme,
    display: params.display,
    surface: params.surface,
  });
}
