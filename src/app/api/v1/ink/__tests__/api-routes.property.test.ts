import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { validateRequest } from "@/lib/api-response";
import {
  helloRequestSchema,
  reportRequestSchema,
  renderQuerySchema,
} from "@/lib/validation";

/**
 * Property 14: Missing required parameters return HTTP 400
 * Validates: Requirements 10.5
 *
 * For any API endpoint and any request missing one or more required parameters,
 * the server should respond with HTTP 400 and a JSON body containing a
 * descriptive error message in the envelope format.
 */
describe("Property 14: Missing required parameters return HTTP 400", () => {
  it("hello endpoint rejects any body without a valid mac", async () => {
    const arbInvalidBody = fc.oneof(
      fc.constant({}),
      fc.constant({ mac: "" }),
      fc.record({
        mac: fc.string().filter(
          (s) => !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(s)
        ),
      }),
      fc.constant(null),
      fc.constant(42),
      fc.constant("string"),
    );

    await fc.assert(
      fc.asyncProperty(arbInvalidBody, async (body) => {
        const result = validateRequest(helloRequestSchema, body);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.response.status).toBe(400);
          const json = await result.response.json();
          expect(json.status).toBe("error");
          expect(json.data).toBeNull();
          expect(typeof json.error).toBe("string");
          expect(json.error.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("report endpoint rejects any body without valid mac and issue", async () => {
    const arbInvalidBody = fc.oneof(
      fc.constant({}),
      fc.constant({ mac: "AA:BB:CC:DD:EE:FF" }), // missing issue
      fc.constant({ issue: "broken" }), // missing mac
      fc.constant({ mac: "bad", issue: "broken" }), // invalid mac
      fc.constant({ mac: "AA:BB:CC:DD:EE:FF", issue: "" }), // empty issue
      fc.constant(null),
    );

    await fc.assert(
      fc.asyncProperty(arbInvalidBody, async (body) => {
        const result = validateRequest(reportRequestSchema, body);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.response.status).toBe(400);
          const json = await result.response.json();
          expect(json.status).toBe("error");
          expect(json.data).toBeNull();
          expect(typeof json.error).toBe("string");
          expect(json.error.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("render/config endpoint rejects any query without a valid mac", async () => {
    const arbInvalidQuery = fc.oneof(
      fc.constant({}),
      fc.constant({ mac: "" }),
      fc.constant({ mac: null }),
      fc.record({
        mac: fc.string().filter(
          (s) => !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(s)
        ),
      }),
    );

    await fc.assert(
      fc.asyncProperty(arbInvalidQuery, async (query) => {
        const result = validateRequest(renderQuerySchema, query);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.response.status).toBe(400);
          const json = await result.response.json();
          expect(json.status).toBe("error");
          expect(json.data).toBeNull();
          expect(typeof json.error).toBe("string");
          expect(json.error.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});
