import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";

vi.mock("../auth", () => ({ validateToken: vi.fn() }));
vi.mock("../rate-limit", () => ({
  apiLimiter: {},
  getClientIp: vi.fn(() => "203.0.113.1"),
  applyRateLimit: vi.fn(() => null),
}));

import { validateToken } from "../auth";
import { applyRateLimit } from "../rate-limit";
import { readDeviceRequest } from "../device-request";

const schema = z.object({ mac: z.string().length(12), value: z.number() });

function post(body: unknown, token = "valid-token"): NextRequest {
  return new NextRequest(new URL("http://localhost/api/v1/ink/report"), {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", "x-device-token": token },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(applyRateLimit).mockReturnValue(null);
  vi.mocked(validateToken).mockResolvedValue(true);
});

describe("readDeviceRequest", () => {
  it("returns the parsed body once the device is authenticated", async () => {
    const result = await readDeviceRequest(post({ mac: "AABBCCDDEEFF", value: 3 }), schema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ mac: "AABBCCDDEEFF", value: 3 });
  });

  it("answers 400 for a body that is not JSON", async () => {
    const result = await readDeviceRequest(post("{not json"), schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it("answers 401 when the token does not match the MAC", async () => {
    vi.mocked(validateToken).mockResolvedValue(false);
    const result = await readDeviceRequest(post({ mac: "AABBCCDDEEFF", value: 3 }), schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  /* The order is the security property, and it is why this is one helper rather
   * than four copies: a token must only ever be checked against a MAC the schema
   * has already validated. */
  it("never reaches the token check with an unvalidated body", async () => {
    const result = await readDeviceRequest(post({ mac: "nope", value: "x" }), schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
    expect(validateToken).not.toHaveBeenCalled();
  });

  it("stops at the rate limiter before parsing anything", async () => {
    const limited = Response.json({ error: "Too many requests" }, { status: 429 });
    vi.mocked(applyRateLimit).mockReturnValue(limited);
    const result = await readDeviceRequest(post({ mac: "AABBCCDDEEFF", value: 3 }), schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(429);
    expect(validateToken).not.toHaveBeenCalled();
  });
});
