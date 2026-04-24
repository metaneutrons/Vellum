import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { applyRoomPolicy } from "../policy";
import type { CalendarEvent } from "@/lib/types";

// --- Generator: arbitrary CalendarEvent ---

const arbCalendarEvent: fc.Arbitrary<CalendarEvent> = fc.record({
  subject: fc.string({ minLength: 1 }),
  organizer: fc.string({ minLength: 1 }),
  startTime: fc.date(),
  endTime: fc.date(),
  isPrivate: fc.boolean(),
});

const arbCalendarEvents = fc.array(arbCalendarEvent, { minLength: 1, maxLength: 10 });

/**
 * Property 1: Room policy transforms public and private events correctly under "Show All"
 * Validates: Requirements 4.3, 4.4
 *
 * For any calendar event and "Show All" room policy: if the event is public,
 * the display subject should equal the original subject with the organizer and
 * time range preserved; if the event is private, the display subject should
 * equal "Booked by [Organizer Name]" with showLockIcon set to true.
 */
describe("Property 1: Room policy transforms public and private events correctly under 'Show All'", () => {
  it("public events keep subject/organizer, private events become 'Booked by [Organizer]' with lock icon", async () => {
    fc.assert(
      fc.property(arbCalendarEvents, (events) => {
        const result = applyRoomPolicy(events, "Show All");

        expect(result).toHaveLength(events.length);

        for (let i = 0; i < events.length; i++) {
          const src = events[i];
          const out = result[i];

          // Time range always preserved
          expect(out.startTime).toEqual(src.startTime);
          expect(out.endTime).toEqual(src.endTime);

          if (src.isPrivate) {
            expect(out.displaySubject).toBe(`Booked by ${src.organizer}`);
            expect(out.showLockIcon).toBe(true);
            expect(out.isPrivate).toBe(true);
          } else {
            expect(out.displaySubject).toBe(src.subject);
            expect(out.organizer).toBe(src.organizer);
            expect(out.showLockIcon).toBe(false);
            expect(out.isPrivate).toBe(false);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 2: "Hide Subject" policy replaces all subjects with "Reserved"
 * Validates: Requirements 4.5
 *
 * For any calendar event (public or private) and "Hide Subject" room policy,
 * the display subject should equal "Reserved" and the time range should still
 * be present.
 */
describe('Property 2: "Hide Subject" policy replaces all subjects with "Reserved"', () => {
  it("all events get 'Reserved' subject with time preserved", () => {
    fc.assert(
      fc.property(arbCalendarEvents, (events) => {
        const result = applyRoomPolicy(events, "Hide Subject");

        expect(result).toHaveLength(events.length);

        for (let i = 0; i < events.length; i++) {
          const src = events[i];
          const out = result[i];

          expect(out.displaySubject).toBe("Reserved");
          expect(out.startTime).toEqual(src.startTime);
          expect(out.endTime).toEqual(src.endTime);
        }
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 3: "Hide All" policy produces only FREE/BUSY status
 * Validates: Requirements 4.6
 *
 * For any set of calendar events and "Hide All" room policy, the output
 * should contain only a "FREE" or "BUSY" indicator with no event subjects,
 * organizer names, or time ranges exposed.
 */
describe('Property 3: "Hide All" policy produces only FREE/BUSY status', () => {
  it("returns empty array — no event details exposed", () => {
    fc.assert(
      fc.property(arbCalendarEvents, (events) => {
        const result = applyRoomPolicy(events, "Hide All");

        // No event details should be exposed
        expect(result).toHaveLength(0);
      }),
      { numRuns: 100 }
    );
  });
});
