// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * One suite every calendar provider has to pass.
 *
 * Written because the two providers that talk to the outside world were the two
 * with no tests at all: `microsoft365` sat at 11.1 % of statements and **0 %** of
 * branches, `google` at 12.0 % and 0 %, while `anny` and `ical` were at 75 % and
 * 77 %. Four implementations of one interface had four different ideas of what
 * that interface promises, and nothing said which idea was right.
 *
 * The cases are not invented. Every one of them is something that actually came up
 * while working on the renderers above: an organizer that is empty, a source that
 * reports local time with an offset, a source that pages, a source that returns
 * bookings in no particular order.
 *
 * Each provider brings a `serve` that translates these neutral descriptions into
 * its own wire format and installs a transport double. Writing that adapter is the
 * point as much as the assertions are: it is the only place in the repository
 * where each provider's payload shape is written down.
 *
 * A double is expected to behave like the real source, including whether it
 * filters the window server-side. Graph and Google do; anny and iCal hand back
 * everything and the provider filters.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import type { CalendarEvent, CalendarProvider } from "../../types";

/** A booking, described the same way for every source. */
export interface WireEvent {
  id: string;
  subject: string;
  /** null means the source knows of no organizer for this booking. */
  organizerName: string | null;
  organizerEmail?: string;
  /** ISO 8601. Deliberately allowed to carry an offset other than Z. */
  start: string;
  end: string;
  isPrivate?: boolean;
}

export type ContractCase = "shape" | "offsets" | "private" | "noOrganizer" | "unordered";

export interface ProviderContract {
  provider: CalendarProvider;
  credentials: unknown;
  roomConfig: unknown;
  /** Install a transport that answers with these bookings. */
  serve(events: WireEvent[]): void;
  /**
   * Cases the source cannot express, each with the reason.
   *
   * A skip has to say WHY, so that "anny has no privacy flag" stays a statement
   * about anny rather than a gap nobody looked at again.
   */
  cannot?: Partial<Record<ContractCase, string>>;
}

export const WINDOW = {
  windowStart: new Date("2026-08-25T08:00:00.000Z"),
  windowEnd: new Date("2026-08-25T20:00:00.000Z"),
};

/** A plain booking inside the window, for cases that need one. */
export function plainEvent(over: Partial<WireEvent> = {}): WireEvent {
  return {
    id: "1",
    subject: "Projektbesprechung",
    organizerName: "Maria Warnking",
    organizerEmail: "warnking@example.org",
    start: "2026-08-25T10:00:00.000Z",
    end: "2026-08-25T11:00:00.000Z",
    ...over,
  };
}

export function describeProviderContract(name: string, contract: ProviderContract): void {
  const fetchEvents = (): Promise<CalendarEvent[]> =>
    contract.provider.fetchEvents({
      credentials: contract.credentials,
      roomConfig: contract.roomConfig,
      ...WINDOW,
    });

  const maybe = (c: ContractCase) => (contract.cannot?.[c] ? it.skip : it);

  describe(`${name} — provider contract`, () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    /* The strongest case, and the cheapest. Every field below is read by a
     * renderer without checking it first, so a provider returning undefined for
     * any of them is a crash on a wall rather than a bad pixel. */
    maybe("shape")("returns events whose every field is what the renderers assume", async () => {
      contract.serve([
        plainEvent(),
        plainEvent({
          id: "2",
          subject: "Jour fixe",
          start: "2026-08-25T14:00:00.000Z",
          end: "2026-08-25T15:30:00.000Z",
        }),
      ]);
      const events = await fetchEvents();
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(typeof e.subject, "subject").toBe("string");
        expect(typeof e.organizer, "organizer").toBe("string");
        expect(typeof e.isPrivate, "isPrivate").toBe("boolean");
        expect(e.startTime, "startTime").toBeInstanceOf(Date);
        expect(e.endTime, "endTime").toBeInstanceOf(Date);
        expect(Number.isNaN(e.startTime.getTime()), `startTime of "${e.subject}"`).toBe(false);
        expect(Number.isNaN(e.endTime.getTime()), `endTime of "${e.subject}"`).toBe(false);
        expect(e.endTime.getTime(), `"${e.subject}" ends after it starts`).toBeGreaterThan(
          e.startTime.getTime()
        );
      }
    });

    /* A source that reports "12:00+02:00" means the same instant as "10:00Z". The
     * failure mode is silent: the sign shows a booking two hours off and nothing
     * anywhere reports an error. */
    maybe("offsets")("reads a local time with an offset as the right instant", async () => {
      contract.serve([
        plainEvent({ start: "2026-08-25T12:00:00+02:00", end: "2026-08-25T13:00:00+02:00" }),
      ]);
      const [event] = await fetchEvents();
      expect(event.startTime.toISOString()).toBe("2026-08-25T10:00:00.000Z");
      expect(event.endTime.toISOString()).toBe("2026-08-25T11:00:00.000Z");
    });

    maybe("private")("marks a private booking as private and a public one as not", async () => {
      contract.serve([
        plainEvent({ id: "1", subject: "Personalgespräch", isPrivate: true }),
        plainEvent({
          id: "2",
          subject: "Jour fixe",
          isPrivate: false,
          start: "2026-08-25T14:00:00.000Z",
          end: "2026-08-25T15:00:00.000Z",
        }),
      ]);
      const events = await fetchEvents();
      const bySubject = new Map(events.map((e) => [e.subject, e.isPrivate]));
      expect(bySubject.get("Personalgespräch")).toBe(true);
      expect(bySubject.get("Jour fixe")).toBe(false);
    });

    /* `organizer` is read as a string everywhere: trimmed, compared, split into
     * name ranks. A provider returning null or undefined turns that into a
     * TypeError, and an unattributed booking is entirely legal in every source
     * here — a room mailbox that auto-accepts is the common way to get one. */
    maybe("noOrganizer")("returns a STRING organizer even when nobody is named", async () => {
      contract.serve([plainEvent({ organizerName: null, organizerEmail: undefined })]);
      const [event] = await fetchEvents();
      expect(typeof event.organizer).toBe("string");
    });

    /* Providers do not promise an order and the renderers do not need one, but a
     * provider must not LOSE an event because of it. `computeTimelineLayout`
     * learned this the hard way: it sorted a copy after two reverse-ordered
     * bookings rendered as one full-width and one half-width block. */
    maybe("unordered")(
      "keeps every booking when the source returns them out of order",
      async () => {
        contract.serve([
          plainEvent({
            id: "3",
            subject: "Drittes",
            start: "2026-08-25T16:00:00.000Z",
            end: "2026-08-25T17:00:00.000Z",
          }),
          plainEvent({
            id: "1",
            subject: "Erstes",
            start: "2026-08-25T09:00:00.000Z",
            end: "2026-08-25T10:00:00.000Z",
          }),
          plainEvent({
            id: "2",
            subject: "Zweites",
            start: "2026-08-25T12:00:00.000Z",
            end: "2026-08-25T13:00:00.000Z",
          }),
        ]);
        const events = await fetchEvents();
        expect(events.map((e) => e.subject).sort()).toEqual(["Drittes", "Erstes", "Zweites"]);
      }
    );

    /* The skips, listed rather than silent, so the suite reports what it did not
     * check and why. */
    for (const [c, why] of Object.entries(contract.cannot ?? {})) {
      it(`does not implement "${c}": ${why}`, () => {
        expect(why.length, "a skip has to give a reason").toBeGreaterThan(10);
      });
    }
  });
}
