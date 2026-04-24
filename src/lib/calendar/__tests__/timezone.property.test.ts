import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { toRoomTime, toUTC } from "../timezone";

// A set of common IANA timezones to test against
const arbTimezone = fc.constantFrom(
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC"
);

// Generate dates in a reasonable range to avoid edge cases with
// very old dates where timezone rules may differ
const arbDate = fc.date({
  min: new Date("2000-01-01T00:00:00Z"),
  max: new Date("2030-12-31T23:59:59Z"),
});

/**
 * Property 4: Timezone conversion round-trip
 * Validates: Requirements 4.7
 *
 * For any UTC datetime and any valid IANA timezone string, converting
 * the datetime to the room timezone and then back to UTC should produce
 * the original UTC datetime (same instant in time).
 */
describe("Property 4: Timezone conversion round-trip", () => {
  it("toRoomTime then toUTC preserves the original UTC instant", () => {
    fc.assert(
      fc.property(arbDate, arbTimezone, (utcDate, timezone) => {
        const roomTime = toRoomTime(utcDate, timezone);
        const backToUtc = toUTC(roomTime);

        // The underlying instant (milliseconds since epoch) must be identical
        expect(backToUtc.getTime()).toBe(utcDate.getTime());
      }),
      { numRuns: 100 }
    );
  });
});
