// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * An .ics feed, fetched through `safeFetch` rather than global fetch, because the
 * URL comes from an operator and the SSRF guard belongs in front of it. That is why
 * the module is mocked here instead of the global.
 *
 * The double does NOT filter: a feed is a file, and the provider filters it.
 *
 * iCal writes an instant either as `...Z` or as a local time with a TZID
 * parameter. The offset case therefore has to be expressed as UTC, which is the
 * one form the format has for an absolute instant.
 */

import { vi } from "vitest";
import { describeProviderContract, type WireEvent } from "./contract";

const safeFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/safe-fetch", () => ({ safeFetch }));

const { icalProvider } = await import("../../providers/ical");

/** ICS wants basic-format UTC: 20260825T100000Z. */
const stamp = (iso: string) =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

function vevent(e: WireEvent): string {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${e.id}@example.org`,
    `DTSTART:${stamp(e.start)}`,
    `DTEND:${stamp(e.end)}`,
    `SUMMARY:${e.subject}`,
  ];
  if (e.organizerName) {
    lines.push(`ORGANIZER;CN=${e.organizerName}:mailto:${e.organizerEmail ?? "x@example.org"}`);
  }
  if (e.isPrivate) lines.push("CLASS:PRIVATE");
  lines.push("END:VEVENT");
  return lines.join("\r\n");
}

function serve(events: WireEvent[]): void {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Vellum//contract//DE",
    ...events.map(vevent),
    "END:VCALENDAR",
  ].join("\r\n");
  safeFetch.mockReset();
  safeFetch.mockResolvedValue(
    new Response(ics, {
      status: 200,
      headers: { "content-type": "text/calendar" },
    })
  );
}

describeProviderContract("ical", {
  provider: icalProvider,
  credentials: { url: "https://example.org/rooms/1J118.ics" },
  roomConfig: {},
  serve,
});
