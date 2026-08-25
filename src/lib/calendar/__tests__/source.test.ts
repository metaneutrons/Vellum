// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * The shared event source, and the claim it exists to make good on: N displays
 * looking at one room cost ONE call to the provider per TTL.
 *
 * Both dependencies are mocked, because neither belongs to this unit: the provider
 * row comes from the database and the implementation from the registry. What is
 * under test is the caching, the window rounding, and the clipping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CalendarEvent, CalendarProvider } from "../types";

const fetchEvents = vi.fn();

vi.mock("@/lib/providers", () => ({
  getProviderWithCredentials: vi.fn(async (id: string) => ({
    id,
    type: "fake",
    name: "Fake",
    credentials: { token: "t" },
  })),
}));

vi.mock("../registry", () => ({
  getCalendarProvider: vi.fn((type: string) =>
    type === "fake" ? ({ type, fetchEvents } as unknown as CalendarProvider) : undefined
  ),
}));

const { fetchResourceEvents, resetEventCache, eventCacheStats, cacheWindow } =
  await import("../source");

const PROVIDER = "11111111-1111-4111-8111-111111111111";
const ROOM = { resourceId: "173420" };

const ev = (from: string, to: string, subject = "Termin"): CalendarEvent => ({
  subject,
  organizer: "Maria Warnking",
  startTime: new Date(from),
  endTime: new Date(to),
  isPrivate: false,
});

/** The window a room display asks for: four hours back, twelve forward. */
function displayWindow(nowIso: string) {
  const now = new Date(nowIso).getTime();
  return {
    windowStart: new Date(now - 4 * 3600_000),
    windowEnd: new Date(now + 12 * 3600_000),
  };
}

beforeEach(() => {
  resetEventCache();
  fetchEvents.mockReset();
  fetchEvents.mockResolvedValue([]);
});

afterEach(() => vi.useRealTimers());

describe("window rounding", () => {
  it("grows the window outward to whole hours", () => {
    const w = cacheWindow(
      new Date("2026-08-25T08:17:33.000Z"),
      new Date("2026-08-25T20:02:01.000Z")
    );
    expect(w.start.toISOString()).toBe("2026-08-25T08:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-08-25T21:00:00.000Z");
  });

  it("leaves an already-whole window alone", () => {
    const w = cacheWindow(
      new Date("2026-08-25T00:00:00.000Z"),
      new Date("2026-08-26T00:00:00.000Z")
    );
    expect(w.start.toISOString()).toBe("2026-08-25T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-08-26T00:00:00.000Z");
  });

  it("asks the provider for the ROUNDED window, not the requested one", async () => {
    await fetchResourceEvents({
      providerId: PROVIDER,
      roomConfig: ROOM,
      ...displayWindow("2026-08-25T12:34:56.000Z"),
    });
    const call = fetchEvents.mock.calls[0][0];
    expect(call.windowStart.toISOString()).toBe("2026-08-25T08:00:00.000Z");
    expect(call.windowEnd.toISOString()).toBe("2026-08-26T01:00:00.000Z");
  });
});

describe("one fetch per TTL", () => {
  /* The claim in the ROADMAP, as an assertion. Twenty displays polling the same
   * room within the same hour used to be twenty calls, or forty when a name plate
   * and a door sign both pointed at it. */
  it("serves twenty displays from one provider call", async () => {
    for (let i = 0; i < 20; i++) {
      /* Each poll a different instant, as real polls are. */
      await fetchResourceEvents({
        providerId: PROVIDER,
        roomConfig: ROOM,
        ...displayWindow(`2026-08-25T12:${String(i).padStart(2, "0")}:07.000Z`),
      });
    }
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(eventCacheStats()).toMatchObject({ hits: 19, misses: 1, fetches: 1, entries: 1 });
  });

  it("fetches again once the poll crosses into the next hour", async () => {
    await fetchResourceEvents({
      providerId: PROVIDER,
      roomConfig: ROOM,
      ...displayWindow("2026-08-25T12:59:00.000Z"),
    });
    await fetchResourceEvents({
      providerId: PROVIDER,
      roomConfig: ROOM,
      ...displayWindow("2026-08-25T13:01:00.000Z"),
    });
    expect(fetchEvents).toHaveBeenCalledTimes(2);
  });

  it("keeps rooms apart", async () => {
    const w = displayWindow("2026-08-25T12:00:00.000Z");
    await fetchResourceEvents({ providerId: PROVIDER, roomConfig: { resourceId: "a" }, ...w });
    await fetchResourceEvents({ providerId: PROVIDER, roomConfig: { resourceId: "b" }, ...w });
    expect(fetchEvents).toHaveBeenCalledTimes(2);
  });

  it("keeps providers apart", async () => {
    const w = displayWindow("2026-08-25T12:00:00.000Z");
    await fetchResourceEvents({ providerId: PROVIDER, roomConfig: ROOM, ...w });
    await fetchResourceEvents({
      providerId: "22222222-2222-4222-8222-222222222222",
      roomConfig: ROOM,
      ...w,
    });
    expect(fetchEvents).toHaveBeenCalledTimes(2);
  });

  it("refetches when the entry has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
    const w = displayWindow("2026-08-25T12:00:00.000Z");
    await fetchResourceEvents({ providerId: PROVIDER, roomConfig: ROOM, ...w, ttlS: 60 });
    vi.setSystemTime(new Date("2026-08-25T12:00:59.000Z"));
    await fetchResourceEvents({ providerId: PROVIDER, roomConfig: ROOM, ...w, ttlS: 60 });
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-08-25T12:01:01.000Z"));
    await fetchResourceEvents({ providerId: PROVIDER, roomConfig: ROOM, ...w, ttlS: 60 });
    expect(fetchEvents).toHaveBeenCalledTimes(2);
  });

  it("does not cache at all when the TTL is zero", async () => {
    const w = displayWindow("2026-08-25T12:00:00.000Z");
    await fetchResourceEvents({ providerId: PROVIDER, roomConfig: ROOM, ...w, ttlS: 0 });
    await fetchResourceEvents({ providerId: PROVIDER, roomConfig: ROOM, ...w, ttlS: 0 });
    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(eventCacheStats().entries).toBe(0);
  });
});

describe("clipping to the requested window", () => {
  /* The rounded window is WIDER than the one asked for, so the extra has to be
   * removed again or a caller would see bookings outside the range it named. This
   * is the half of the design that keeps the rounding honest. */
  it("drops what the wider fetch brought back and the caller did not ask for", async () => {
    fetchEvents.mockResolvedValue([
      ev("2026-08-25T08:05:00.000Z", "2026-08-25T08:20:00.000Z", "vor dem Fenster"),
      ev("2026-08-25T10:00:00.000Z", "2026-08-25T11:00:00.000Z", "im Fenster"),
    ]);
    const events = await fetchResourceEvents({
      providerId: PROVIDER,
      roomConfig: ROOM,
      windowStart: new Date("2026-08-25T09:30:00.000Z"),
      windowEnd: new Date("2026-08-25T12:30:00.000Z"),
    });
    expect(events.map((e) => e.subject)).toEqual(["im Fenster"]);
  });

  it("keeps a booking that started before the window and is still running", async () => {
    fetchEvents.mockResolvedValue([ev("2026-08-25T08:00:00.000Z", "2026-08-25T11:00:00.000Z")]);
    const events = await fetchResourceEvents({
      providerId: PROVIDER,
      roomConfig: ROOM,
      windowStart: new Date("2026-08-25T10:30:00.000Z"),
      windowEnd: new Date("2026-08-25T12:00:00.000Z"),
    });
    expect(events).toHaveLength(1);
  });

  /* Touching is not overlapping: a booking that ends exactly when the window opens
   * is over, and one that starts exactly when it closes has not begun. */
  it("excludes bookings that merely touch the boundary", async () => {
    fetchEvents.mockResolvedValue([
      ev("2026-08-25T09:00:00.000Z", "2026-08-25T10:00:00.000Z", "endet am Rand"),
      ev("2026-08-25T12:00:00.000Z", "2026-08-25T13:00:00.000Z", "beginnt am Rand"),
    ]);
    const events = await fetchResourceEvents({
      providerId: PROVIDER,
      roomConfig: ROOM,
      windowStart: new Date("2026-08-25T10:00:00.000Z"),
      windowEnd: new Date("2026-08-25T12:00:00.000Z"),
    });
    expect(events).toEqual([]);
  });

  it("clips a cached result too, not only a fresh one", async () => {
    fetchEvents.mockResolvedValue([
      ev("2026-08-25T08:10:00.000Z", "2026-08-25T08:40:00.000Z", "früh"),
      ev("2026-08-25T11:00:00.000Z", "2026-08-25T11:30:00.000Z", "später"),
    ]);
    /* Both requests round to 08:00-12:00, so the second is a cache HIT with a
     * narrower request, which is the case that would leak an out-of-range booking
     * if only fresh results were clipped. */
    const first = await fetchResourceEvents({
      providerId: PROVIDER,
      roomConfig: ROOM,
      windowStart: new Date("2026-08-25T08:05:00.000Z"),
      windowEnd: new Date("2026-08-25T11:55:00.000Z"),
    });
    expect(first.map((e) => e.subject)).toEqual(["früh", "später"]);
    /* 08:45 floors to 08:00, so the key is unchanged; a start of 09:00 would floor
     * to 09:00 and miss, which is the mistake this comment exists to prevent. */
    const second = await fetchResourceEvents({
      providerId: PROVIDER,
      roomConfig: ROOM,
      windowStart: new Date("2026-08-25T08:45:00.000Z"),
      windowEnd: new Date("2026-08-25T11:50:00.000Z"),
    });
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(second.map((e) => e.subject)).toEqual(["später"]);
  });

  /* The limit of the design, asserted so that nobody reads the module header as a
   * broader promise than it makes. Sharing requires the ROUNDED windows to
   * coincide, so renderers that ask the same SHAPE of question share, and a room
   * display's rolling sixteen hours never coincides with a name plate's calendar
   * day. Fixing that would mean partitioning the cache by day, and anny fetches
   * every page of a resource's bookings per call regardless of the window, so a
   * two-day span would double the work it already does. */
  it("does not share between a rolling window and a day window", async () => {
    await fetchResourceEvents({
      providerId: PROVIDER,
      roomConfig: ROOM,
      ...displayWindow("2026-08-25T12:00:00.000Z"),
    });
    await fetchResourceEvents({
      providerId: PROVIDER,
      roomConfig: ROOM,
      windowStart: new Date("2026-08-24T22:00:00.000Z"),
      windowEnd: new Date("2026-08-25T22:00:00.000Z"),
    });
    expect(fetchEvents).toHaveBeenCalledTimes(2);
  });
});

describe("failures", () => {
  it("does not cache a failed fetch", async () => {
    fetchEvents.mockRejectedValueOnce(new Error("provider down"));
    const w = displayWindow("2026-08-25T12:00:00.000Z");
    await expect(
      fetchResourceEvents({ providerId: PROVIDER, roomConfig: ROOM, ...w })
    ).rejects.toThrow("provider down");
    fetchEvents.mockResolvedValue([ev("2026-08-25T12:00:00.000Z", "2026-08-25T13:00:00.000Z")]);
    const events = await fetchResourceEvents({ providerId: PROVIDER, roomConfig: ROOM, ...w });
    expect(events).toHaveLength(1);
    expect(eventCacheStats()).toMatchObject({ misses: 2, fetches: 2 });
  });

  it("names the provider type it cannot serve", async () => {
    const { getProviderWithCredentials } = await import("@/lib/providers");
    vi.mocked(getProviderWithCredentials).mockResolvedValueOnce({
      id: PROVIDER,
      type: "carrier-pigeon",
      name: "Pigeon",
      credentials: {},
    });
    await expect(
      fetchResourceEvents({
        providerId: PROVIDER,
        roomConfig: ROOM,
        ...displayWindow("2026-08-25T12:00:00.000Z"),
      })
    ).rejects.toThrow("carrier-pigeon");
  });
});
