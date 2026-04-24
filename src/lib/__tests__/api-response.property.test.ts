import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { okResponse, errorResponse } from "../api-response";
import type { ApiResponse } from "../types";

/**
 * Property 15: All JSON responses use consistent envelope format
 * Validates: Requirements 10.6
 *
 * For any JSON API response from the server, the response body should parse to
 * an object containing exactly the fields `status`, `data`, and `error`,
 * where `status` is either "ok" or "error".
 */
describe("Property 15: All JSON responses use consistent envelope format", () => {
  it("okResponse always produces { status: 'ok', data, error: null }", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (data) => {
        const response = okResponse(data);

        expect(Object.keys(response).sort()).toEqual(["data", "error", "status"]);
        expect(response.status).toBe("ok");
        expect(response.data).toEqual(data);
        expect(response.error).toBeNull();

        // Round-trip through JSON to confirm serialization consistency
        const json = JSON.stringify(response);
        const parsed = JSON.parse(json);
        expect(Object.keys(parsed).sort()).toEqual(["data", "error", "status"]);
        expect(parsed.status).toBe("ok");
        expect(parsed.error).toBeNull();
      }),
      { numRuns: 100 }
    );
  });

  it("errorResponse always produces { status: 'error', data: null, error: string }", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (message) => {
        const response = errorResponse(message);

        expect(Object.keys(response).sort()).toEqual(["data", "error", "status"]);
        expect(response.status).toBe("error");
        expect(response.data).toBeNull();
        expect(response.error).toBe(message);

        const json = JSON.stringify(response);
        const parsed = JSON.parse(json);
        expect(Object.keys(parsed).sort()).toEqual(["data", "error", "status"]);
        expect(parsed.status).toBe("error");
        expect(parsed.data).toBeNull();
        expect(typeof parsed.error).toBe("string");
      }),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 16: API response serialization round-trip
 * Validates: Requirements 10.7
 *
 * For any valid ApiResponse object, serializing it to JSON and deserializing
 * the JSON back should produce an object deeply equal to the original.
 */
describe("Property 16: API response serialization round-trip", () => {
  const arbOkResponse: fc.Arbitrary<ApiResponse<unknown>> = fc
    .jsonValue()
    .map((data) => okResponse(data));

  const arbErrorResponse: fc.Arbitrary<ApiResponse<null>> = fc
    .string({ minLength: 1 })
    .map((msg) => errorResponse(msg));

  const arbApiResponse = fc.oneof(arbOkResponse, arbErrorResponse);

  it("JSON.parse(JSON.stringify(response)) deeply equals the original", () => {
    fc.assert(
      fc.property(arbApiResponse, (response) => {
        const json = JSON.stringify(response);
        const parsed = JSON.parse(json);
        expect(parsed).toEqual(response);
      }),
      { numRuns: 100 }
    );
  });
});
