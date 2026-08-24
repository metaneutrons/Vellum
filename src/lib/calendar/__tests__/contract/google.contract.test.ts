// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Google Calendar's v3 events list, behind a service-account JWT.
 *
 * The double answers two endpoints, because the provider makes two calls: the
 * OAuth token exchange and then the calendar. The JWT is really signed, with a
 * throwaway key generated here, so the signing path is exercised rather than
 * stepped over.
 *
 * The double FILTERS the window, because Google does: `timeMin`/`timeMax` are
 * query parameters and the API returns only what falls inside them.
 */

import { vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { googleProvider } from "../../providers/google";
import { describeProviderContract, WINDOW, type WireEvent } from "./contract";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function itemOf(e: WireEvent) {
  return {
    summary: e.subject,
    organizer: e.organizerName ? { displayName: e.organizerName } : undefined,
    start: { dateTime: e.start },
    end: { dateTime: e.end },
    visibility: e.isPrivate ? "private" : "default",
  };
}

function serve(events: WireEvent[]): void {
  const inWindow = events.filter(
    (e) => new Date(e.end) > WINDOW.windowStart && new Date(e.start) < WINDOW.windowEnd
  );
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "ya29.test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ items: inWindow.map(itemOf) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describeProviderContract("google", {
  provider: googleProvider,
  credentials: { clientEmail: "vellum@example.iam.gserviceaccount.com", privateKey },
  roomConfig: { calendarId: "room-1J118@example.org" },
  serve,
});
