import { signRemoteOrientation } from "@/lib/provisioning/remote-configuration";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const dbState = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  updateResults: [] as unknown[][],
}));

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

vi.mock("@/lib/encryption", () => ({
  decryptCredentials: vi.fn(() => ({ password: "correct horse battery staple" })),
}));

// Mock DB
vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => dbState.selectResults.shift() ?? []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => dbState.updateResults.shift() ?? []),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(),
    })),
  },
  withDbRead: vi.fn(async (fn: () => unknown) => fn()),
  withDbWrite: vi.fn(async (fn: () => unknown) => fn()),
}));

import { handleHello, validateToken } from "@/lib/auth";
import { resolveOta } from "@/lib/firmware";
import { POST as helloHandler } from "../hello/route";
import { GET as configHandler } from "../config/route";
import { POST as reportHandler } from "../report/route";
import { POST as configReportHandler } from "../config-report/route";
import { POST as logsHandler } from "../logs/route";

const mockedHandleHello = vi.mocked(handleHello);
const mockedValidateToken = vi.mocked(validateToken);

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(url, "http://localhost"), init as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selectResults = [];
  dbState.updateResults = [];
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

    const req = makeRequest("http://localhost/api/v1/ink/config?mac=AA:BB:CC:DD:EE:FF", {
      headers: { "x-device-token": "bad-token" },
    });

    const res = await configHandler(req);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.status).toBe("error");
    expect(body.error).toBe("Unauthorized");
  });

  it("returns config for authenticated device", async () => {
    mockedValidateToken.mockResolvedValue(true);

    const req = makeRequest("http://localhost/api/v1/ink/config?mac=AA:BB:CC:DD:EE:FF", {
      headers: { "x-device-token": "valid-token" },
    });

    const res = await configHandler(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.data).toHaveProperty("rotation");
  });

  it("delivers a device-bound signed server migration", async () => {
    mockedValidateToken.mockResolvedValue(true);
    dbState.selectResults = [
      [{ mac: "AABBCCDDEEFF", status: "approved", token: "01".repeat(32), displayCaps: null }],
      [
        {
          id: "123e4567-e89b-12d3-a456-426614174000",
          kind: "server_url",
          payload: { serverUrl: "https://vellum.example.com" },
          status: "pending",
        },
      ],
    ];

    const req = makeRequest("http://localhost/api/v1/ink/config?mac=AA:BB:CC:DD:EE:FF", {
      headers: { "x-device-token": "valid-token" },
    });
    const res = await configHandler(req);
    const body = await res.json();

    expect(body.data.remoteConfiguration).toEqual({
      protocol: 1,
      id: "123e4567-e89b-12d3-a456-426614174000",
      kind: "server_url",
      serverUrl: "https://vellum.example.com",
      signature: "c5ce06dd38a44bf708316a97311137c6160827bcb1b3709cefcbe5c50c9c77cd",
    });
  });

  it("delivers a device-bound signed mounting change", async () => {
    mockedValidateToken.mockResolvedValue(true);
    dbState.selectResults = [
      [{ mac: "AABBCCDDEEFF", status: "approved", token: "01".repeat(32), displayCaps: null }],
      [
        {
          id: "123e4567-e89b-12d3-a456-426614174000",
          kind: "orientation",
          payload: { orientation: "landscape" },
          status: "pending",
        },
      ],
    ];

    const req = makeRequest("http://localhost/api/v1/ink/config?mac=AA:BB:CC:DD:EE:FF", {
      headers: { "x-device-token": "valid-token" },
    });
    const res = await configHandler(req);
    const body = await res.json();

    expect(body.data.remoteConfiguration).toMatchObject({
      protocol: 1,
      id: "123e4567-e89b-12d3-a456-426614174000",
      kind: "orientation",
      orientation: "landscape",
    });
    /* Signed under its own context, so the signature cannot be replayed as a
     * server migration or a Wi-Fi rotation carrying the same command id. */
    expect(body.data.remoteConfiguration.signature).toBe(
      signRemoteOrientation({
        deviceToken: "01".repeat(32),
        id: "123e4567-e89b-12d3-a456-426614174000",
        orientation: "landscape",
      })
    );
  });

  it("refuses to emit a command whose stored mounting is not a valid one", async () => {
    mockedValidateToken.mockResolvedValue(true);
    dbState.selectResults = [
      [{ mac: "AABBCCDDEEFF", status: "approved", token: "01".repeat(32), displayCaps: null }],
      [
        {
          id: "123e4567-e89b-12d3-a456-426614174000",
          kind: "orientation",
          payload: { orientation: "upside-down" },
          status: "pending",
        },
      ],
    ];

    const req = makeRequest("http://localhost/api/v1/ink/config?mac=AA:BB:CC:DD:EE:FF", {
      headers: { "x-device-token": "valid-token" },
    });
    const body = await (await configHandler(req)).json();
    expect(body.data.remoteConfiguration).toBeUndefined();
  });

  it("decrypts and delivers a device-bound signed Wi-Fi change", async () => {
    mockedValidateToken.mockResolvedValue(true);
    dbState.selectResults = [
      [{ mac: "AABBCCDDEEFF", status: "approved", token: "01".repeat(32), displayCaps: null }],
      [
        {
          id: "123e4567-e89b-12d3-a456-426614174000",
          kind: "wifi",
          payload: { ssid: "Office WiFi", encryptedPassword: "encrypted-at-rest" },
          status: "pending",
        },
      ],
    ];

    const req = makeRequest("http://localhost/api/v1/ink/config?mac=AA:BB:CC:DD:EE:FF", {
      headers: { "x-device-token": "valid-token" },
    });
    const res = await configHandler(req);
    const body = await res.json();

    expect(body.data.remoteConfiguration).toEqual({
      protocol: 1,
      id: "123e4567-e89b-12d3-a456-426614174000",
      kind: "wifi",
      ssid: "Office WiFi",
      password: "correct horse battery staple",
      signature: "274ac50bacf2434bd6471f9f05b81170f634703883b9e005a017c31d6cd0e3ac",
    });
  });

  it("returns a short-lived Vellum URL instead of the GitHub OTA URL", async () => {
    mockedValidateToken.mockResolvedValue(true);
    vi.mocked(resolveOta).mockResolvedValueOnce({
      otaUrl:
        "https://github.com/metaneutrons/Vellum/releases/download/firmware-v1.4.3/e1003-ota.bin",
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

describe("POST /api/v1/ink/config-report", () => {
  it("accepts an authenticated terminal outcome idempotently", async () => {
    mockedValidateToken.mockResolvedValue(true);
    dbState.updateResults = [[{ id: "123e4567-e89b-12d3-a456-426614174000" }]];
    const req = makeRequest("http://localhost/api/v1/ink/config-report", {
      method: "POST",
      body: JSON.stringify({
        mac: "AA:BB:CC:DD:EE:FF",
        id: "123e4567-e89b-12d3-a456-426614174000",
        status: "applied",
      }),
      headers: { "Content-Type": "application/json", "x-device-token": "valid-token" },
    });
    expect((await configReportHandler(req)).status).toBe(200);
  });

  it("rejects unauthenticated outcomes", async () => {
    mockedValidateToken.mockResolvedValue(false);
    const req = makeRequest("http://localhost/api/v1/ink/config-report", {
      method: "POST",
      body: JSON.stringify({
        mac: "AA:BB:CC:DD:EE:FF",
        id: "123e4567-e89b-12d3-a456-426614174000",
        status: "failed",
        errorCode: "target_validation_failed",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect((await configReportHandler(req)).status).toBe(401);
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
      headers: {
        "x-device-token": "valid-token",
        "x-display-model": "d1001",
        "x-firmware-ver": "1.3.2",
      },
    });

    const res = await configHandler(req);
    expect(res.status).toBe(200);

    const [firmwareVer, displayModel] = vi.mocked(resolveOta).mock.calls[0];
    expect(firmwareVer).toBe("1.3.2");
    expect(displayModel).toBe("d1001");
  });

  it('falls back to "unknown" only when the device sends no model', async () => {
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

describe("POST /api/v1/ink/logs", () => {
  const batch = (overrides: Record<string, unknown> = {}) =>
    makeRequest("http://localhost/api/v1/ink/logs", {
      method: "POST",
      body: JSON.stringify({
        mac: "AA:BB:CC:DD:EE:FF",
        seq: 1,
        lines: "W (1234) panel_lcd: No memory for the decode buffer\n",
        ...overrides,
      }),
      headers: { "Content-Type": "application/json", "x-device-token": "valid-token" },
    });

  it("stores a reported batch and acknowledges the sequence", async () => {
    mockedValidateToken.mockResolvedValue(true);
    const res = await logsHandler(batch());
    const body = await res.json();
    expect(res.status).toBe(200);
    /* The device drops its bytes only on a 2xx, so the acknowledgement has to
     * name the sequence it accepted. */
    expect(body.data.seq).toBe(1);
  });

  it("acknowledges a stored batch even when housekeeping fails", async () => {
    mockedValidateToken.mockResolvedValue(true);
    /* The device drops its bytes only on a 2xx. A pruning failure that reached the
     * caller would make it retry a batch that is already stored, for as long as
     * the failure lasts. */
    const { withDbWrite } = await import("@/db");
    const mocked = vi.mocked(withDbWrite);
    let call = 0;
    mocked.mockImplementation(async (fn: () => unknown) => {
      call += 1;
      if (call === 1) return fn();
      throw new Error("lock timeout");
    });
    const res = await logsHandler(batch());
    expect(res.status).toBe(200);
    mocked.mockImplementation(async (fn: () => unknown) => fn());
  });

  it("refuses a batch from an unauthenticated device", async () => {
    mockedValidateToken.mockResolvedValue(false);
    const res = await logsHandler(batch());
    expect(res.status).toBe(401);
  });

  it("refuses a payload larger than the cap", async () => {
    mockedValidateToken.mockResolvedValue(true);
    const res = await logsHandler(batch({ lines: "x".repeat(32_769) }));
    expect(res.status).toBe(400);
  });

  it("refuses a sequence that cannot come from a device", async () => {
    mockedValidateToken.mockResolvedValue(true);
    expect((await logsHandler(batch({ seq: 0 }))).status).toBe(400);
    expect((await logsHandler(batch({ seq: -3 }))).status).toBe(400);
  });
});
