import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock auth module
vi.mock("@/lib/auth", () => ({
  handleHello: vi.fn(),
  validateToken: vi.fn(),
}));

// Mock telemetry module
vi.mock("@/lib/telemetry", () => ({
  extractTelemetry: vi.fn(() => null),
  logTelemetry: vi.fn(),
}));

// Mock calendar module
vi.mock("@/lib/calendar", () => ({
  fetchRoomEvents: vi.fn(() => []),
}));

// Mock DB
vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => []),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(),
    })),
  },
}));

import { handleHello, validateToken } from "@/lib/auth";
import { POST as helloHandler } from "../hello/route";
import { GET as configHandler } from "../config/route";
import { POST as reportHandler } from "../report/route";

const mockedHandleHello = vi.mocked(handleHello);
const mockedValidateToken = vi.mocked(validateToken);

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(url, "http://localhost"), init as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/ink/hello", () => {
  it("returns pending status for unknown MAC", async () => {
    mockedHandleHello.mockResolvedValue({ status: "pending" });

    const req = makeRequest("http://localhost/api/v1/ink/hello", {
      method: "POST",
      body: JSON.stringify({ mac: "AA:BB:CC:DD:EE:FF" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await helloHandler(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.data.status).toBe("pending");
    expect(body.data.token).toBeUndefined();
  });

  it("returns token for approved device", async () => {
    mockedHandleHello.mockResolvedValue({
      status: "approved",
      token: "abc123",
    });

    const req = makeRequest("http://localhost/api/v1/ink/hello", {
      method: "POST",
      body: JSON.stringify({ mac: "AA:BB:CC:DD:EE:FF" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await helloHandler(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.data.status).toBe("approved");
    expect(body.data.token).toBe("abc123");
  });

  it("returns 400 for missing mac", async () => {
    const req = makeRequest("http://localhost/api/v1/ink/hello", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    const res = await helloHandler(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.status).toBe("error");
    expect(body.error).toBeTruthy();
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = makeRequest("http://localhost/api/v1/ink/hello", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });

    const res = await helloHandler(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.status).toBe("error");
  });
});

describe("GET /api/v1/ink/config", () => {
  it("returns 401 for invalid token", async () => {
    mockedValidateToken.mockResolvedValue(false);

    const req = makeRequest(
      "http://localhost/api/v1/ink/config?mac=AA:BB:CC:DD:EE:FF",
      { headers: { "x-device-token": "bad-token" } },
    );

    const res = await configHandler(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.status).toBe("error");
    expect(body.error).toBe("Unauthorized");
  });

  it("returns config for authenticated device", async () => {
    mockedValidateToken.mockResolvedValue(true);

    const req = makeRequest(
      "http://localhost/api/v1/ink/config?mac=AA:BB:CC:DD:EE:FF",
      { headers: { "x-device-token": "valid-token" } },
    );

    const res = await configHandler(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.data).toHaveProperty("rotation");
  });

  it("returns 400 for missing mac query param", async () => {
    const req = makeRequest("http://localhost/api/v1/ink/config");

    const res = await configHandler(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.status).toBe("error");
  });
});

describe("POST /api/v1/ink/report", () => {
  it("returns 401 for invalid token", async () => {
    mockedValidateToken.mockResolvedValue(false);

    const req = makeRequest("http://localhost/api/v1/ink/report", {
      method: "POST",
      body: JSON.stringify({ mac: "AA:BB:CC:DD:EE:FF", issue: "broken screen" }),
      headers: {
        "Content-Type": "application/json",
        "x-device-token": "bad-token",
      },
    });

    const res = await reportHandler(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.status).toBe("error");
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 400 for missing parameters", async () => {
    const req = makeRequest("http://localhost/api/v1/ink/report", {
      method: "POST",
      body: JSON.stringify({ mac: "AA:BB:CC:DD:EE:FF" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await reportHandler(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.status).toBe("error");
  });
});
