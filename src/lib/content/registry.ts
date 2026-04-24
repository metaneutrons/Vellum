/**
 * Content renderer registry — maps content type slugs to implementations.
 */

import type { ContentRenderer } from "./types";
import { roomBookingRenderer } from "./renderers/room-booking";

const renderers = new Map<string, ContentRenderer>();

function register(renderer: ContentRenderer) {
  renderers.set(renderer.slug, renderer);
}

register(roomBookingRenderer);

export function getContentRenderer(slug: string): ContentRenderer | undefined {
  return renderers.get(slug);
}

export function getAllContentRenderers(): ContentRenderer[] {
  return [...renderers.values()];
}
