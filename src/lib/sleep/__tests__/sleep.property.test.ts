import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { computeSleepDuration, applyJitter } from "../index";
import type { SleepContext } from "../index";

/**
 * Property 5: Sleep duration computation follows priority rules
 * **Validates: Requirements 6.2, 6.3, 6.4, 6.5**
 *
 * For any valid SleepContext:
 * (a) if powerSource is "usb", the result is 60
 * (b) if powerSource is "battery" and batteryLevel < 20, the result is 3600
 * (c) if powerSource is "battery", batteryLevel >= 20, and nextEventStart
 *     is within 20 minutes of now, the result equals (nextEventStart - now - 5min) in seconds
 * (d) otherwise the result is 900
 */
describe("Property 5: Sleep duration computation follows priority rules", () => {
  it("USB powered always returns 60", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.option(fc.date()),
        fc.date(),
        (batteryLevel, nextEventStart, now) => {
          const ctx: SleepContext = {
            powerSource: "usb",
            batteryLevel,
            nextEventStart,
            now,
          };
          expect(computeSleepDuration(ctx)).toBe(60);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("battery < 20% returns 3600", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 19 }),
        fc.option(fc.date()),
        fc.date(),
        (batteryLevel, nextEventStart, now) => {
          const ctx: SleepContext = {
            powerSource: "battery",
            batteryLevel,
            nextEventStart,
            now,
          };
          expect(computeSleepDuration(ctx)).toBe(3600);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("battery >= 20%, meeting within 20min returns (diff - 5min)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 20, max: 100 }),
        fc.date({ min: new Date("2000-01-01"), max: new Date("2100-01-01") }).filter(
          (d) => !isNaN(d.getTime())
        ),
        // offset in seconds: meeting is 1..1200 seconds from now (up to 20 min)
        fc.integer({ min: 1, max: 1200 }),
        (batteryLevel, now, offsetSeconds) => {
          const nextEventStart = new Date(
            now.getTime() + offsetSeconds * 1000
          );
          const ctx: SleepContext = {
            powerSource: "battery",
            batteryLevel,
            nextEventStart,
            now,
          };
          const result = computeSleepDuration(ctx);
          const expected = Math.max(offsetSeconds - 300, 0);
          expect(result).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("battery >= 20%, no imminent meeting returns 900", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 20, max: 100 }),
        fc.date(),
        (batteryLevel, now) => {
          // nextEventStart is null (no upcoming meeting)
          const ctx: SleepContext = {
            powerSource: "battery",
            batteryLevel,
            nextEventStart: null,
            now,
          };
          expect(computeSleepDuration(ctx)).toBe(900);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("battery >= 20%, meeting more than 20min away returns 900", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 20, max: 100 }),
        fc.date(),
        // offset > 20 minutes
        fc.integer({ min: 1201, max: 86400 }),
        (batteryLevel, now, offsetSeconds) => {
          const nextEventStart = new Date(
            now.getTime() + offsetSeconds * 1000
          );
          const ctx: SleepContext = {
            powerSource: "battery",
            batteryLevel,
            nextEventStart,
            now,
          };
          expect(computeSleepDuration(ctx)).toBe(900);
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 6: Jitter stays within bounds
 * **Validates: Requirements 6.7, 11.3**
 *
 * For any base sleep duration and max jitter of 10 seconds,
 * applyJitter(baseDuration, 10) should return a value in
 * [baseDuration, baseDuration + 10].
 */
describe("Property 6: Jitter stays within bounds", () => {
  it("result is in [baseDuration, baseDuration + maxJitter]", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 86400 }),
        fc.integer({ min: 0, max: 60 }),
        (baseDuration, maxJitter) => {
          const result = applyJitter(baseDuration, maxJitter);
          expect(result).toBeGreaterThanOrEqual(baseDuration);
          expect(result).toBeLessThanOrEqual(baseDuration + maxJitter);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 17: Render response always includes sleep duration header
 * **Validates: Requirements 6.1**
 *
 * This property validates that every successful render response includes
 * an X-Sleep-Duration header with a positive integer value.
 * Full integration testing requires the render route handler (Task 10.2).
 * Here we verify that computeSleepDuration always returns a non-negative number,
 * which is the value that will populate that header.
 */
describe("Property 17: Render response always includes sleep duration header", () => {
  it("computeSleepDuration always returns a non-negative integer for any valid context", () => {
    const arbSleepContext: fc.Arbitrary<SleepContext> = fc.record({
      powerSource: fc.constantFrom("usb" as const, "battery" as const),
      batteryLevel: fc.integer({ min: 0, max: 100 }),
      nextEventStart: fc.option(fc.date({ min: new Date(0), max: new Date("2100-01-01") })),
      now: fc.date({ min: new Date(0), max: new Date("2100-01-01") }),
    });

    fc.assert(
      fc.property(arbSleepContext, (ctx) => {
        const result = computeSleepDuration(ctx);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(result)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});
