// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Content renderer registry — maps content type slugs to implementations.
 *
 * `door-sign` and `door-sign-multi` were unregistered on 2026-08-25, once the
 * estate held no instance of either: production never had one, and development's
 * single door sign was migrated to a two-seat `name-plate`. Unregistering earlier
 * would have been a breaking change, because `getContentRenderer` returns
 * undefined for an unknown slug and the render route answers 500 — which on a wall
 * is a display that quietly stops updating.
 *
 * Their code is parked rather than deleted; see docs/door-sign-retirement.md for
 * what is worth keeping and why.
 */

import type { ContentRenderer } from "./types";
import { roomBookingRenderer } from "./renderers/room-booking";
import { namePlateRenderer } from "./renderers/name-plate";

const renderers = new Map<string, ContentRenderer>();

function register(renderer: ContentRenderer) {
  renderers.set(renderer.slug, renderer);
}

register(roomBookingRenderer);
register(namePlateRenderer);

export function getContentRenderer(slug: string): ContentRenderer | undefined {
  return renderers.get(slug);
}

export function getAllContentRenderers(): ContentRenderer[] {
  return [...renderers.values()];
}
