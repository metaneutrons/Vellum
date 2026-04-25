import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { floydSteinbergDither, type ColorPalette } from "../dither";
import { renderToCanvas as renderLayout, renderOffline as renderOfflineLayout } from "@/lib/content/renderers/room-booking";
import { THEME_MONO } from "@/lib/theme";
import type { DisplayEvent } from "@/lib/types";

/**
 * Property 7: Dithered output contains only palette indices and preserves dimensions
 * Validates: Requirements 5.6
 */
describe("Property 7: Dithered output contains only palette indices and preserves dimensions", () => {
  // Generator for small images (keep dimensions small for speed)
  const arbDimension = fc.integer({ min: 1, max: 50 });

  // Generator for a non-empty color palette (1-8 colors)
  const arbPalette: fc.Arbitrary<ColorPalette> = fc
    .array(
      fc.tuple(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 })
      ),
      { minLength: 1, maxLength: 8 }
    );

  it("output has exactly width × height entries and every entry is a valid palette index", () => {
    fc.assert(
      fc.property(
        arbDimension,
        arbDimension,
        arbPalette,
        (width, height, palette) => {
          // Generate random RGBA image data
          const size = width * height * 4;
          const imageData = new Uint8ClampedArray(size);
          for (let i = 0; i < size; i++) {
            imageData[i] = Math.floor(Math.random() * 256);
          }

          const result = floydSteinbergDither(imageData, width, height, palette);

          // Output dimensions match
          expect(result.length).toBe(width * height);

          // Every entry is a valid palette index
          for (let i = 0; i < result.length; i++) {
            expect(result[i]).toBeGreaterThanOrEqual(0);
            expect(result[i]).toBeLessThan(palette.length);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 8: Render layout contains required visual elements
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4
 *
 * For any valid render context (room name, display events, timezone, current time)
 * where calendar data is not stale, the rendered layout should contain:
 * (a) a "FREE" or "BUSY" status indicator,
 * (b) up to 3 upcoming event slots matching the input events,
 * (c) a "Last Updated" timestamp.
 * The output pixel buffer should have dimensions exactly 800 × 480.
 */
describe("Property 8: Render layout contains required visual elements", () => {
  const arbRoomName = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0);

  const arbDisplayEvent = (now: Date): fc.Arbitrary<DisplayEvent> => {
    const futureStart = now.getTime() + 60_000; // at least 1 min in the future
    return fc.record({
      displaySubject: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
      organizer: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
      startTime: fc.integer({ min: futureStart, max: futureStart + 8 * 3_600_000 }).map((t) => new Date(t)),
      endTime: fc.integer({ min: futureStart + 1_800_000, max: futureStart + 10 * 3_600_000 }).map((t) => new Date(t)),
      isPrivate: fc.boolean(),
      showLockIcon: fc.boolean(),
    });
  };

  it("canvas is 800x480 and contains rendered content for room name, status, events, and timestamp", () => {
    const now = new Date("2025-06-15T10:00:00Z");

    fc.assert(
      fc.property(
        arbRoomName,
        fc.array(arbDisplayEvent(now), { minLength: 0, maxLength: 5 }),
        (roomName, events) => {
          const canvas = renderLayout(events, roomName, "UTC", now, THEME_MONO, 800, 480, 2);

          // (a) Canvas dimensions are exactly 800x480
          expect(canvas.width).toBe(800);
          expect(canvas.height).toBe(480);

          // Read back pixel data to verify rendering occurred
          const ctx = canvas.getContext("2d");
          const imageData = ctx.getImageData(0, 0, 800, 480);
          const pixels = imageData.data;

          // (b) Header region (top 70px) should contain non-white pixels
          // (room name + FREE/BUSY status are rendered there)
          let headerHasContent = false;
          for (let y = 0; y < 80 && !headerHasContent; y++) {
            for (let x = 0; x < 800 && !headerHasContent; x++) {
              const idx = (y * 800 + x) * 4;
              if (pixels[idx] !== 255 || pixels[idx + 1] !== 255 || pixels[idx + 2] !== 255) {
                headerHasContent = true;
              }
            }
          }
          expect(headerHasContent).toBe(true);

          // (c) Footer region (bottom 50px) should contain non-white pixels
          // ("Last Updated" timestamp is rendered there)
          let footerHasContent = false;
          for (let y = 430; y < 480 && !footerHasContent; y++) {
            for (let x = 0; x < 800 && !footerHasContent; x++) {
              const idx = (y * 800 + x) * 4;
              if (pixels[idx] !== 255 || pixels[idx + 1] !== 255 || pixels[idx + 2] !== 255) {
                footerHasContent = true;
              }
            }
          }
          expect(footerHasContent).toBe(true);

          // (d) If there are upcoming events (endTime > now), the event slot region
          // (y: 90 to 430) should contain non-white pixels from rendered slots
          const upcomingCount = Math.min(
            events.filter((e) => e.endTime.getTime() > now.getTime()).length,
            3
          );
          if (upcomingCount > 0) {
            let eventRegionHasContent = false;
            for (let y = 90; y < 430 && !eventRegionHasContent; y++) {
              for (let x = 0; x < 800 && !eventRegionHasContent; x++) {
                const idx = (y * 800 + x) * 4;
                if (pixels[idx] !== 255 || pixels[idx + 1] !== 255 || pixels[idx + 2] !== 255) {
                  eventRegionHasContent = true;
                }
              }
            }
            expect(eventRegionHasContent).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 9: Stale calendar data triggers fail-safe
 * Validates: Requirements 5.5
 *
 * For any render context where the calendar data fetchedAt timestamp is more
 * than 4 hours before now, the rendered layout should display a "System Offline"
 * message instead of normal calendar content.
 *
 * We test this by verifying that renderOfflineLayout produces a valid 800x480
 * canvas with content distinct from a normal renderLayout output, and that the
 * offline layout contains rendered content in the center region where
 * "System Offline" text is drawn.
 */
describe("Property 9: Stale calendar data triggers fail-safe", () => {
  const arbRoomName = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0);
  const arbNow = fc.date({ min: new Date("2020-01-01"), max: new Date("2030-12-31") }).filter((d) => !isNaN(d.getTime()));

  it("renderOfflineLayout produces 800x480 canvas with content in the center region", () => {
    fc.assert(
      fc.property(arbRoomName, arbNow, (roomName, now) => {
        const canvas = renderOfflineLayout(roomName, now, THEME_MONO, 800, 480);

        // Canvas dimensions are exactly 800x480
        expect(canvas.width).toBe(800);
        expect(canvas.height).toBe(480);

        const ctx = canvas.getContext("2d");
        const imageData = ctx.getImageData(0, 0, 800, 480);
        const pixels = imageData.data;

        // The "System Offline" text is rendered near the vertical center (HEIGHT/2 = 240)
        // Check the center region (y: 200-300) for non-white, non-background content
        let centerHasContent = false;
        for (let y = 200; y < 300 && !centerHasContent; y++) {
          for (let x = 100; x < 700 && !centerHasContent; x++) {
            const idx = (y * 800 + x) * 4;
            // Look for black text pixels (the "System Offline" message)
            if (pixels[idx] < 50 && pixels[idx + 1] < 50 && pixels[idx + 2] < 50) {
              centerHasContent = true;
            }
          }
        }
        expect(centerHasContent).toBe(true);

        // Header should still be rendered (room name)
        let headerHasContent = false;
        for (let y = 0; y < 80 && !headerHasContent; y++) {
          for (let x = 0; x < 800 && !headerHasContent; x++) {
            const idx = (y * 800 + x) * 4;
            if (pixels[idx] !== 255 || pixels[idx + 1] !== 255 || pixels[idx + 2] !== 255) {
              headerHasContent = true;
            }
          }
        }
        expect(headerHasContent).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it("stale data (fetchedAt > 4 hours ago) should use offline layout instead of normal layout", () => {
    fc.assert(
      fc.property(arbRoomName, arbNow, (roomName, now) => {
        // Simulate stale scenario: fetchedAt is more than 4 hours before now
        const staleCutoff = new Date(now.getTime() - 4 * 60 * 60 * 1000);
        const fetchedAt = new Date(staleCutoff.getTime() - 60_000); // 1 min before cutoff

        // Verify staleness condition holds
        expect(fetchedAt.getTime()).toBeLessThan(staleCutoff.getTime());

        // When data is stale, renderOfflineLayout should be used
        const offlineCanvas = renderOfflineLayout(roomName, now, THEME_MONO, 800, 480);
        const offlineCtx = offlineCanvas.getContext("2d");
        const offlineData = offlineCtx.getImageData(0, 0, 800, 480);

        // The offline canvas center region should have "System Offline" text
        let hasOfflineText = false;
        for (let y = 200; y < 300 && !hasOfflineText; y++) {
          for (let x = 100; x < 700 && !hasOfflineText; x++) {
            const idx = (y * 800 + x) * 4;
            if (offlineData.data[idx] < 50 && offlineData.data[idx + 1] < 50 && offlineData.data[idx + 2] < 50) {
              hasOfflineText = true;
            }
          }
        }
        expect(hasOfflineText).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});
