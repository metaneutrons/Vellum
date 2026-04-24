import { describe, it, expect } from "vitest";
import { z } from "zod";
import { okResponse, errorResponse, validateRequest } from "../api-response";

describe("okResponse", () => {
  it("wraps data in envelope with status ok", () => {
    const result = okResponse({ id: 1 });
    expect(result).toEqual({ status: "ok", data: { id: 1 }, error: null });
  });
});

describe("errorResponse", () => {
  it("wraps message in envelope with status error", () => {
    const result = errorResponse("something broke");
    expect(result).toEqual({ status: "error", data: null, error: "something broke" });
  });
});

describe("validateRequest", () => {
  const schema = z.object({ mac: z.string().regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/) });

  it("returns success with parsed data for valid input", () => {
    const result = validateRequest(schema, { mac: "AA:BB:CC:DD:EE:FF" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ mac: "AA:BB:CC:DD:EE:FF" });
    }
  });

  it("returns 400 Response with error envelope for invalid input", async () => {
    const result = validateRequest(schema, { mac: "not-a-mac" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.status).toBe("error");
      expect(body.data).toBeNull();
      expect(body.error).toContain("mac");
    }
  });

  it("returns 400 when required field is missing", async () => {
    const result = validateRequest(schema, {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.status).toBe("error");
      expect(typeof body.error).toBe("string");
    }
  });
});
