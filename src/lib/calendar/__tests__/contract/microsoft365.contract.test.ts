// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Microsoft Graph, through the SDK's fluent client rather than plain HTTP, which is
 * why the module is mocked instead of `fetch`. This provider had 11.1 % of
 * statements and 0 % of branches covered before this file existed, and it is the
 * one every lexICT room runs on.
 *
 * The double FILTERS the window, because `calendarView` does: the window is a query
 * parameter and Graph returns only what overlaps it.
 *
 * Graph writes a time as a NAIVE local string plus a separate `timeZone` field, and
 * this provider sends no `Prefer: outlook.timezone` header, so what comes back is
 * always UTC and the provider appends the "Z" itself. There is no offset to read, so
 * the contract's offset case cannot be expressed here.
 */

import { describe, it, expect, vi } from "vitest";
import { describeProviderContract, plainEvent, WINDOW, type WireEvent } from "./contract";

const ROOM_EMAIL = "raum-1J118@example.org";

/* The SDK's chain: .api(path).query(...).select(...).orderby(...).get() */
const graphGet = vi.hoisted(() => vi.fn());

/* Constructible mocks rather than empty classes, which the lint rules rightly
 * object to. Neither is called for anything but `new`. */
vi.mock("@azure/identity", () => ({ ClientSecretCredential: vi.fn() }));
vi.mock("@microsoft/microsoft-graph-client", () => ({
  Client: {
    initWithMiddleware: () => {
      const chain = {
        api: () => chain,
        query: () => chain,
        select: () => chain,
        orderby: () => chain,
        get: graphGet,
      };
      return chain;
    },
  },
}));
vi.mock("@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials", () => ({
  TokenCredentialAuthenticationProvider: vi.fn(),
}));

const { microsoft365Provider } = await import("../../providers/microsoft365");

/** Graph's naive-local-plus-zone shape, always UTC for this provider. */
const graphTime = (iso: string) => ({
  dateTime: new Date(iso).toISOString().replace("Z", "0000000").replace(".", "."),
  timeZone: "UTC",
});

interface GraphAttendee {
  emailAddress: { name: string; address: string };
}

function graphEvent(e: WireEvent, attendees: GraphAttendee[] = []) {
  return {
    subject: e.subject,
    organizer: e.organizerName
      ? { emailAddress: { name: e.organizerName, address: e.organizerEmail ?? "x@example.org" } }
      : undefined,
    attendees,
    start: graphTime(e.start),
    end: graphTime(e.end),
    sensitivity: e.isPrivate ? "private" : "normal",
  };
}

function serve(events: WireEvent[], attendees: GraphAttendee[] = []): void {
  const inWindow = events.filter(
    (e) => new Date(e.end) > WINDOW.windowStart && new Date(e.start) < WINDOW.windowEnd
  );
  graphGet.mockReset();
  graphGet.mockResolvedValue({ value: inWindow.map((e) => graphEvent(e, attendees)) });
}

const CREDENTIALS = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  clientSecret: "a-secret-long-enough-to-pass-validation",
};
const ROOM_CONFIG = { roomEmail: ROOM_EMAIL };

describeProviderContract("microsoft365", {
  provider: microsoft365Provider,
  credentials: CREDENTIALS,
  roomConfig: ROOM_CONFIG,
  serve,
  cannot: {
    offsets:
      "Graph reports a naive local time plus a separate timeZone field rather than " +
      "an offset, and this provider sends no Prefer: outlook.timezone header, so what " +
      "arrives is always UTC and the provider appends the Z itself",
  },
});

/* ── Graph's own rules, which no other provider has ───────────────────────── */

async function fetchEvents() {
  return microsoft365Provider.fetchEvents({
    credentials: CREDENTIALS,
    roomConfig: ROOM_CONFIG,
    ...WINDOW,
  });
}

const attendee = (name: string, address: string): GraphAttendee => ({
  emailAddress: { name, address },
});

describe("microsoft365 — the room mailbox as organizer", () => {
  /* A resource mailbox that auto-accepts becomes the organizer of the booking it
   * accepted, so naming the organizer would put the ROOM's own name on the room's
   * own sign. The provider falls back to the attendees, and this is where the
   * missing occupant on a stacked sign was first traced to. */
  it("names the attendees when the room itself organised the booking", async () => {
    serve(
      [plainEvent({ organizerName: "Besprechungsraum 1J.1.18", organizerEmail: ROOM_EMAIL })],
      [attendee("Maria Warnking", "warnking@example.org")]
    );
    const event = (await fetchEvents())[0]!;
    expect(event.organizer).toBe("Maria Warnking");
  });

  /* Nobody else invited, so there is nothing to fall back to. An empty string is
   * the right answer and the renderers handle it; naming the room would not be. */
  it("returns an empty organizer when the room organised it and invited nobody", async () => {
    serve([plainEvent({ organizerName: "Besprechungsraum 1J.1.18", organizerEmail: ROOM_EMAIL })]);
    const event = (await fetchEvents())[0]!;
    expect(event.organizer).toBe("");
  });

  it("does not count the room, nor the organizer, among the attendees", async () => {
    serve(
      [plainEvent({ organizerName: "Maria Warnking", organizerEmail: "warnking@example.org" })],
      [attendee("Der Raum", ROOM_EMAIL), attendee("Maria Warnking", "warnking@example.org")]
    );
    const event = (await fetchEvents())[0]!;
    expect(event.organizer).toBe("Maria Warnking");
  });

  it("counts the others behind the organizer's name", async () => {
    serve(
      [plainEvent({ organizerName: "Maria Warnking", organizerEmail: "warnking@example.org" })],
      [
        attendee("Lukas Thiele", "thiele@example.org"),
        attendee("Fabian Schmieder", "schmieder@example.org"),
      ]
    );
    const event = (await fetchEvents())[0]!;
    expect(event.organizer).toBe("Maria Warnking (+2)");
  });

  it("lists at most three attendees and counts the rest", async () => {
    serve(
      [plainEvent({ organizerName: "Besprechungsraum", organizerEmail: ROOM_EMAIL })],
      [
        attendee("Eins", "1@example.org"),
        attendee("Zwei", "2@example.org"),
        attendee("Drei", "3@example.org"),
        attendee("Vier", "4@example.org"),
        attendee("Fünf", "5@example.org"),
      ]
    );
    const event = (await fetchEvents())[0]!;
    expect(event.organizer).toBe("Eins, Zwei, Drei (+2)");
  });

  it("matches the room's address without regard to case", async () => {
    serve(
      [plainEvent({ organizerName: "Raum", organizerEmail: ROOM_EMAIL.toUpperCase() })],
      [attendee("Maria Warnking", "warnking@example.org")]
    );
    const event = (await fetchEvents())[0]!;
    expect(event.organizer).toBe("Maria Warnking");
  });

  /* Graph omits fields rather than sending nulls, and this provider used to read
   * the answer as `any`: `new Date(evt.start?.dateTime + "Z")` on an event without
   * a start produced the string "undefinedZ", so an Invalid Date travelled on into
   * the timeline instead of the event being rejected. The schema at the boundary
   * drops such an event now. */
  it("drops an event Graph sent without a start or end time", async () => {
    graphGet.mockResolvedValueOnce({
      value: [
        { subject: "kein Anfang", end: { dateTime: "2026-09-06T11:00:00" } },
        { subject: "kein Ende", start: { dateTime: "2026-09-06T10:00:00" } },
      ],
    });
    await expect(fetchEvents()).resolves.toEqual([]);
  });

  /* One malformed entry must not cost the whole day. A sign showing four of five
   * bookings is worth more than one showing an error. */
  it("keeps the usable events when one entry is malformed", async () => {
    graphGet.mockResolvedValueOnce({
      value: [
        { subject: "kaputt", start: { dateTime: 42 } },
        {
          subject: "brauchbar",
          start: { dateTime: "2026-09-06T10:00:00" },
          end: { dateTime: "2026-09-06T11:00:00" },
        },
      ],
    });
    const events = await fetchEvents();
    expect(events.map((e) => e.subject)).toEqual(["brauchbar"]);
  });
});
