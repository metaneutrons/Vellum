// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock DNS so we can drive the resolver the pre-check AND the pinning dispatcher
// both consult.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
// Mock undici's fetch but DELEGATE to the real one by default, so the rebind
// test runs the real fetch + real Agent (exercising the pinning dispatcher),
// while the response-handling tests can stub canned responses. The real Agent
// is preserved via `...actual`.
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: vi.fn(actual.fetch) };
});

import { lookup } from "node:dns/promises";
import { fetch as undiciFetch } from "undici";
import { safeFetch } from "../safe-fetch";

const mockedLookup = vi.mocked(lookup);
const mockedFetch = vi.mocked(undiciFetch);
const PUBLIC = [{ address: "93.184.216.34", family: 4 }]; // example.com, not blocked
const METADATA = [{ address: "169.254.169.254", family: 4 }]; // cloud metadata, blocked

beforeEach(() => {
  vi.clearAllMocks(); // keeps the vi.fn(actual.fetch) default implementation
});

describe("safeFetch — DNS-rebinding TOCTOU is closed at connect", () => {
  it("rejects when the host re-resolves to a blocked IP after the pre-check passed", async () => {
    // Pre-check sees a public IP (passes); the dispatcher's connect-time lookup
    // sees the rebind to the metadata IP and refuses — no socket to a blocked
    // address. Real fetch + real dispatcher (mockedFetch delegates to undici).
    mockedLookup
      .mockResolvedValueOnce(PUBLIC as never) // assertAllowedHost pre-check
      .mockResolvedValueOnce(METADATA as never); // dispatcher connect lookup

    await expect(
      safeFetch("http://rebind.test/x", { allowHttp: true, timeoutMs: 3000 })
    ).rejects.toThrow();

    // BOTH resolutions happened — the pre-check AND the connect-time revalidation
    // through the pinning dispatcher. (If the dispatcher were ignored, as global
    // fetch does on Node 22, only the pre-check would run.)
    expect(mockedLookup).toHaveBeenCalledTimes(2);
  });

  it("rejects up front when the host resolves to a blocked IP", async () => {
    mockedLookup.mockResolvedValue(METADATA as never);
    await expect(safeFetch("http://evil.test/x", { allowHttp: true })).rejects.toThrow(
      /blocked address/
    );
    expect(mockedLookup).toHaveBeenCalledTimes(1); // pre-check short-circuits
  });
});

describe("safeFetch — response handling with pinning", () => {
  it("returns a buffered body and passes the pinning dispatcher to fetch", async () => {
    mockedLookup.mockResolvedValue(PUBLIC as never);
    mockedFetch.mockResolvedValueOnce(
      new Response("hello-body", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }) as never
    );

    const res = await safeFetch("http://example.test/x", { allowHttp: true });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello-body");
    expect(res.headers.get("content-type")).toBe("text/plain");
    const init = mockedFetch.mock.calls[0]![1];
    expect(init?.dispatcher).toBeDefined(); // the pin is wired in
  });

  it("follows redirects and returns the final body", async () => {
    mockedLookup.mockResolvedValue(PUBLIC as never);
    mockedFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "http://example.test/final" },
        }) as never
      )
      .mockResolvedValueOnce(new Response("final-body", { status: 200 }) as never);

    const res = await safeFetch("http://example.test/start", { allowHttp: true });

    expect(await res.text()).toBe("final-body");
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});
