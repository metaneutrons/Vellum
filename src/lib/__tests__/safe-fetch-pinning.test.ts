// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock DNS so we can drive the resolver the pre-check AND the pinning dispatcher
// both consult. The real fetch + real undici dispatcher run against it.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
import { lookup } from "node:dns/promises";
import { safeFetch } from "../safe-fetch";

const mockedLookup = vi.mocked(lookup);
const PUBLIC = [{ address: "93.184.216.34", family: 4 }]; // example.com, not blocked
const METADATA = [{ address: "169.254.169.254", family: 4 }]; // cloud metadata, blocked

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("safeFetch — DNS-rebinding TOCTOU is closed at connect", () => {
  it("rejects when the host re-resolves to a blocked IP after the pre-check passed", async () => {
    // Pre-check sees a public IP (passes); the dispatcher's connect-time lookup
    // sees the rebind to the metadata IP and must refuse — so no socket is ever
    // opened to a blocked address. Real fetch, real dispatcher.
    mockedLookup
      .mockResolvedValueOnce(PUBLIC as never) // assertAllowedHost pre-check
      .mockResolvedValueOnce(METADATA as never); // dispatcher connect lookup

    await expect(
      safeFetch("http://rebind.test/x", { allowHttp: true, timeoutMs: 3000 }),
    ).rejects.toThrow();

    // Both resolutions happened: the pre-check AND the connect-time re-validation.
    expect(mockedLookup).toHaveBeenCalledTimes(2);
  });

  it("rejects up front when the host resolves to a blocked IP", async () => {
    mockedLookup.mockResolvedValue(METADATA as never);
    await expect(
      safeFetch("http://evil.test/x", { allowHttp: true }),
    ).rejects.toThrow(/blocked address/);
    expect(mockedLookup).toHaveBeenCalledTimes(1); // pre-check short-circuits
  });
});

describe("safeFetch — response handling with pinning", () => {
  it("returns a buffered body and passes the pinning dispatcher to fetch", async () => {
    mockedLookup.mockResolvedValue(PUBLIC as never);
    const fetchMock = vi.fn(
      async (_input: string | URL, _init?: RequestInit & { dispatcher?: unknown }) =>
        new Response("hello-body", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await safeFetch("http://example.test/x", { allowHttp: true });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello-body");
    expect(res.headers.get("content-type")).toBe("text/plain");
    const init = fetchMock.mock.calls[0][1];
    expect(init?.dispatcher).toBeDefined(); // the pin is wired in
  });

  it("follows redirects and returns the final body", async () => {
    mockedLookup.mockResolvedValue(PUBLIC as never);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "http://example.test/final" } }),
      )
      .mockResolvedValueOnce(new Response("final-body", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await safeFetch("http://example.test/start", { allowHttp: true });

    expect(await res.text()).toBe("final-body");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
