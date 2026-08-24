// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * One way to ask a calendar for a resource's bookings, and one cache in front of it.
 *
 * There used to be FOUR, one per renderer: `room-booking`, `door-sign`,
 * `door-sign-multi` and `name-plate` each held their own `TtlCache` under their own
 * key prefix. So a name plate and a door sign pointed at the same anny desk fetched
 * it twice, three of the four ignored the configured `cacheTtlS` in favour of a
 * hard-coded minute, and none of them could say how often it was saving a call.
 *
 * All four keyed on `providerId + roomConfig` and therefore IGNORED the window they
 * had asked for, so a hit could answer a different question than the one asked.
 *
 * The window is part of the key here, which is the correction, and it is ROUNDED
 * OUTWARD TO WHOLE HOURS so that being part of the key does not defeat the cache:
 * a room display asks for `now - 4h .. now + 12h`, which is a different pair of
 * instants on every single poll. Rounded, twenty displays polling within the same
 * hour ask the same question once. Callers still get exactly the window they asked
 * for, because the wider result is filtered on the way out.
 *
 * The limit of that, stated plainly because the paragraph above reads like a wider
 * promise than it is: sharing needs the ROUNDED windows to coincide. Renderers
 * asking the same SHAPE of question share, which covers the three that ask for a
 * calendar day (both door signs and the name plate). A room display's rolling
 * sixteen hours never coincides with a calendar day, so those two still fetch
 * separately. Closing that gap means partitioning the cache by day, and anny
 * fetches every page of a resource's bookings on every call regardless of the
 * window, so a two-day span would double work that is already the most expensive
 * thing here. Not worth it until a room and a desk on one provider are actually
 * being polled together.
 */

import { getCalendarProvider } from "./registry";
import { getProviderWithCredentials } from "@/lib/providers";
import type { CalendarEvent } from "./types";

const HOUR_MS = 3_600_000;

export interface EventRequest {
  providerId: string;
  /** Passed through to the provider unread; its shape is the provider's business. */
  roomConfig: unknown;
  windowStart: Date;
  windowEnd: Date;
  /** Seconds a result stays usable. 120 by default, 0 to bypass. */
  ttlS?: number;
}

interface CacheEntry {
  events: CalendarEvent[];
  expiresAt: number;
}

/** Module-level on purpose: the point is that every caller in the process shares it. */
const cache = new Map<string, CacheEntry>();

/** Counters, so "one fetch per TTL" is a measurement rather than a hope. */
const counters = { hits: 0, misses: 0, fetches: 0 };

export interface EventCacheStats {
  hits: number;
  misses: number;
  /** Calls that reached a provider. Equal to misses unless one threw. */
  fetches: number;
  entries: number;
}

export function eventCacheStats(): EventCacheStats {
  return { ...counters, entries: cache.size };
}

/** For tests, and for an operator who has just changed a provider's credentials. */
export function resetEventCache(): void {
  cache.clear();
  counters.hits = 0;
  counters.misses = 0;
  counters.fetches = 0;
}

/** The window actually fetched: the requested one, grown to whole hours. */
export function cacheWindow(windowStart: Date, windowEnd: Date): { start: Date; end: Date } {
  return {
    start: new Date(Math.floor(windowStart.getTime() / HOUR_MS) * HOUR_MS),
    end: new Date(Math.ceil(windowEnd.getTime() / HOUR_MS) * HOUR_MS),
  };
}

function keyOf(req: EventRequest, window: { start: Date; end: Date }): string {
  /* roomConfig is serialised rather than picked apart because its shape belongs to
   * the provider. Two configs that differ only in key ORDER would miss, which
   * costs a fetch and never returns a wrong answer. */
  return [
    req.providerId,
    JSON.stringify(req.roomConfig),
    window.start.getTime(),
    window.end.getTime(),
  ].join("|");
}

/**
 * Events overlapping the requested window, from cache when possible.
 *
 * Overlap rather than containment: a booking that started before the window and is
 * still running is the one a person standing at the door cares about most.
 */
export async function fetchResourceEvents(req: EventRequest): Promise<CalendarEvent[]> {
  const window = cacheWindow(req.windowStart, req.windowEnd);
  /* The room-booking renderer disabled its cache in development "for instant
   * feedback". That was worth keeping and worth having in ONE place rather than in
   * one renderer out of four, so all of them now behave the same while developing. */
  const ttlMs = process.env.NODE_ENV === "development" ? 0 : (req.ttlS ?? 120) * 1000;
  const key = keyOf(req, window);

  const hit = ttlMs > 0 ? cache.get(key) : undefined;
  if (hit && Date.now() < hit.expiresAt) {
    counters.hits++;
    return clip(hit.events, req);
  }
  counters.misses++;

  const provider = await getProviderWithCredentials(req.providerId);
  const impl = getCalendarProvider(provider.type);
  if (!impl) throw new Error(`No implementation for provider type: ${provider.type}`);

  counters.fetches++;
  const events = await impl.fetchEvents({
    credentials: provider.credentials,
    roomConfig: req.roomConfig,
    windowStart: window.start,
    windowEnd: window.end,
  });

  if (ttlMs > 0) cache.set(key, { events, expiresAt: Date.now() + ttlMs });
  return clip(events, req);
}

function clip(events: CalendarEvent[], req: EventRequest): CalendarEvent[] {
  const from = req.windowStart.getTime();
  const to = req.windowEnd.getTime();
  return events.filter((e) => e.endTime.getTime() > from && e.startTime.getTime() < to);
}
