// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, it, expect, vi, afterEach } from "vitest";
import { annyProvider, fetchAnnyResources } from "../providers/anny";

/** anny JSON:API bookings response. */
function annyResponse(data: unknown[], lastPage = 1): Response {
  return new Response(JSON.stringify({
    data,
    included: [],
    meta: { page: { "current-page": 1, "last-page": lastPage } },
  }), {
    status: 200,
    headers: { "content-type": "application/vnd.api+json" },
  });
}

const CREDS = { apiToken: "test-token", organizationId: "org-1" };
const ROOM = { resourceId: "173420" };

afterEach(() => vi.unstubAllGlobals());

describe("anny provider — recurring series", () => {
  it("fetches every bookings page before filtering the requested time window", async () => {
    const pageOne = [{
      id: "past",
      type: "bookings",
      attributes: {
        start_date: "2026-07-01T09:00:00+00:00",
        end_date: "2026-07-01T10:00:00+00:00",
        status: "accepted",
      },
    }];
    const pageTwo = [{
      id: "today",
      type: "bookings",
      attributes: {
        start_date: "2026-07-14T13:00:00+00:00",
        end_date: "2026-07-14T14:00:00+00:00",
        status: "accepted",
        description: "Green Office",
      },
    }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(annyResponse(pageOne, 2))
      .mockResolvedValueOnce(annyResponse(pageTwo));
    vi.stubGlobal("fetch", fetchMock);

    const events = await annyProvider.fetchEvents({
      credentials: CREDS,
      roomConfig: ROOM,
      windowStart: new Date("2026-07-14T00:00:00Z"),
      windowEnd: new Date("2026-07-15T00:00:00Z"),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("page[number]")).toBe("1");
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("page[number]")).toBe("2");
    expect(events).toHaveLength(1);
    expect(events[0].subject).toBe("Green Office");
  });

  it("excludes the series-master envelope but keeps the in-window occurrence", async () => {
    const now = Date.UTC(2026, 6, 14, 10, 0, 0); // 2026-07-14 10:00 UTC
    const windowStart = new Date(now - 4 * 3600_000);
    const windowEnd = new Date(now + 12 * 3600_000);

    const data = [
      // MASTER: a daily 15:00–16:00 series returned as one 3-week envelope.
      // It overlaps the window but must be dropped — else the room reads BELEGT
      // around the clock for the whole span.
      {
        id: "master",
        type: "bookings",
        attributes: {
          start_date: "2026-07-07T13:00:00+00:00",
          end_date: "2026-07-28T14:00:00+00:00",
          status: "accepted",
          is_series_master: true,
          series_type: "recurring",
          description: "Green Office",
        },
      },
      // MEMBER occurrence that actually falls in the window — must be kept.
      {
        id: "occ",
        type: "bookings",
        attributes: {
          start_date: "2026-07-14T13:00:00+00:00",
          end_date: "2026-07-14T14:00:00+00:00",
          status: "accepted",
          is_series: true,
          series_id: "master",
          description: "Green Office",
        },
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => annyResponse(data)));

    const events = await annyProvider.fetchEvents({
      credentials: CREDS,
      roomConfig: ROOM,
      windowStart,
      windowEnd,
    });

    expect(events).toHaveLength(1);
    expect(events[0].startTime.toISOString()).toBe("2026-07-14T13:00:00.000Z");
    expect(events[0].endTime.toISOString()).toBe("2026-07-14T14:00:00.000Z");
  });

  it("regression: room is free between occurrences of a multi-week series", async () => {
    // 2026-07-13 21:46 UTC (23:46 CEST) — the exact repro moment. The next
    // occurrence is 2026-07-14 15:00 CEST, outside the window, so the room must
    // read FREI even though the master envelope (Jul 7 – Jul 28) covers today.
    const now = Date.UTC(2026, 6, 13, 21, 46, 0);
    const windowStart = new Date(now - 4 * 3600_000);
    const windowEnd = new Date(now + 12 * 3600_000);

    const data = [
      {
        id: "master",
        type: "bookings",
        attributes: {
          start_date: "2026-07-07T13:00:00+00:00",
          end_date: "2026-07-28T14:00:00+00:00",
          status: "accepted",
          is_series_master: true,
          description: "Green Office",
        },
      },
      {
        id: "o1",
        type: "bookings",
        attributes: {
          start_date: "2026-07-07T13:00:00+00:00",
          end_date: "2026-07-07T14:00:00+00:00",
          status: "accepted",
          is_series: true,
          description: "Green Office",
        },
      },
      {
        id: "o2",
        type: "bookings",
        attributes: {
          start_date: "2026-07-14T13:00:00+00:00",
          end_date: "2026-07-14T14:00:00+00:00",
          status: "accepted",
          is_series: true,
          description: "Green Office",
        },
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => annyResponse(data)));

    const events = await annyProvider.fetchEvents({
      credentials: CREDS,
      roomConfig: ROOM,
      windowStart,
      windowEnd,
    });
    const busy = events.some(
      (e) => e.startTime.getTime() <= now && e.endTime.getTime() > now,
    );
    expect(busy).toBe(false);
  });

  it("keeps ordinary (non-series) bookings", async () => {
    const now = Date.UTC(2026, 6, 14, 10, 0, 0);
    const data = [
      {
        id: "reg",
        type: "bookings",
        attributes: {
          start_date: "2026-07-14T09:00:00+00:00",
          end_date: "2026-07-14T10:00:00+00:00",
          status: "accepted",
          description: "Besprechung",
        },
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => annyResponse(data)));

    const events = await annyProvider.fetchEvents({
      credentials: CREDS,
      roomConfig: ROOM,
      windowStart: new Date(now - 4 * 3600_000),
      windowEnd: new Date(now + 12 * 3600_000),
    });

    expect(events).toHaveLength(1);
    expect(events[0].subject).toBe("Besprechung");
  });
});

describe("anny provider — direct booking URLs", () => {
  it("uses a booking URL only when Anny explicitly supplies a resource slug", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => annyResponse([{
      id: "resource-1",
      type: "resources",
      attributes: { name: "Team Room", slug: "team-room" },
    }])));

    const result = await fetchAnnyResources(CREDS.apiToken, "org-1");
    expect(result.resources).toEqual([{
      id: "resource-1",
      name: "Team Room",
      description: undefined,
      bookingUrl: "https://anny.co/b/book/team-room",
    }]);
  });

  it("does not infer a public booking URL from a resource ID or name", () => {
    expect(annyProvider.getBookingUrl?.({ credentials: CREDS, roomConfig: { resourceId: "looks-like-a-slug" } })).toBeNull();
  });
});
