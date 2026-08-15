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

// Mock firmware/OTA resolution — the config route calls resolveOta(), which
// otherwise hits the live GitHub Releases API and made this test hang/time out.
vi.mock("@/lib/firmware", () => ({
  resolveOta: vi.fn(async () => ({
    otaUrl: null,
    otaTag: null,
    otaVersion: null,
    otaSha256: null,
    otaSignature: null,
    otaKeyId: null,
    allowDowngrade: false,
  })),
}));

vi.mock("@/lib/env", () => ({
  env: { VELLUM_PUBLIC_URL: "https://vellum.example.com" },
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
  withDbRead: vi.fn((fn: () => unknown) => fn()),
}));

import { handleHello, validateToken } from "@/lib/auth";
import { resolveOta } from "@/lib/firmware";
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

  it("returns a short-lived Vellum URL instead of the GitHub OTA URL", async () => {
    mockedValidateToken.mockResolvedValue(true);
    vi.mocked(resolveOta).mockResolvedValueOnce({
      otaUrl: "https://github.com/metaneutrons/Vellum/releases/download/firmware-v1.4.3/e1003-ota.bin",
      otaTag: "firmware-v1.4.3",
      otaVersion: "1.4.3",
      otaSha256: "00".repeat(32),
      otaSignature: "signature",
      otaKeyId: "key-1",
      allowDowngrade: false,
    });

    const req = makeRequest("http://localhost/api/v1/ink/config?mac=AA:BB:CC:DD:EE:FF", {
      headers: { "x-device-token": "valid-token", "x-display-model": "e1003" },
    });
    const res = await configHandler(req);
    const body = await res.json();
    const otaUrl = new URL(body.data.otaUrl);

    expect(otaUrl.origin).toBe("https://vellum.example.com");
    expect(otaUrl.pathname).toBe("/api/v1/ink/firmware");
    expect(otaUrl.searchParams.get("tag")).toBe("firmware-v1.4.3");
    expect(otaUrl.href).not.toContain("valid-token");
    expect(body.data.otaTag).toBeUndefined();
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

describe("GET /api/v1/ink/config — display model resolution", () => {
  /* A voucher-enrolled device is approved with a token immediately and never
   * calls /hello again, so its stored displayCaps stay NULL. Resolving the model
   * from the DB alone yielded "unknown", no manifest entry matched, and the
   * device silently never updated. The device sends X-Display-Model on this very
   * request, so the header must win. */
  it("resolves the model from X-Display-Model when caps are not stored", async () => {
    mockedValidateToken.mockResolvedValue(true);

    const req = makeRequest("http://localhost/api/v1/ink/config?mac=AA:BB:CC:DD:EE:FF", {
      headers: { "x-device-token": "valid-token", "x-display-model": "d1001", "x-firmware-ver": "1.3.2" },
    });

    const res = await configHandler(req);
    expect(res.status).toBe(200);

    const [firmwareVer, displayModel] = vi.mocked(resolveOta).mock.calls[0];
    expect(firmwareVer).toBe("1.3.2");
    expect(displayModel).toBe("d1001");
  });

  it("falls back to \"unknown\" only when the device sends no model", async () => {
    mockedValidateToken.mockResolvedValue(true);

    const req = makeRequest("http://localhost/api/v1/ink/config?mac=AA:BB:CC:DD:EE:FF", {
      headers: { "x-device-token": "valid-token" },
    });

    const res = await configHandler(req);
    expect(res.status).toBe(200);
    expect(vi.mocked(resolveOta).mock.calls[0][1]).toBe("unknown");
  });

  it("ignores a blank X-Display-Model instead of resolving an empty model", async () => {
    mockedValidateToken.mockResolvedValue(true);

    const req = makeRequest("http://localhost/api/v1/ink/config?mac=AA:BB:CC:DD:EE:FF", {
      headers: { "x-device-token": "valid-token", "x-display-model": "   " },
    });

    const res = await configHandler(req);
    expect(res.status).toBe(200);
    expect(vi.mocked(resolveOta).mock.calls[0][1]).toBe("unknown");
  });
});
