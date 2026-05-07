// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Content renderer registry — maps content type slugs to implementations.
 */

import type { ContentRenderer } from "./types";
import { roomBookingRenderer } from "./renderers/room-booking";
import { doorSignRenderer } from "./renderers/door-sign";
import { doorSignMultiRenderer } from "./renderers/door-sign-multi";

const renderers = new Map<string, ContentRenderer>();

function register(renderer: ContentRenderer) {
  renderers.set(renderer.slug, renderer);
}

register(roomBookingRenderer);
register(doorSignRenderer);
register(doorSignMultiRenderer);

export function getContentRenderer(slug: string): ContentRenderer | undefined {
  return renderers.get(slug);
}

export function getAllContentRenderers(): ContentRenderer[] {
  return [...renderers.values()];
}
