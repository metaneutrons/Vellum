// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * iCal URL provider — fetches an .ics file and parses VEVENT entries.
 *
 * No credentials needed — just a public or pre-authenticated URL.
 * Supports any standard iCalendar feed (Outlook publish, Google public, etc.)
 */

import { z } from "zod";
import type { CalendarProvider, CalendarEvent } from "../types";

export const icalCredentialSchema = z.object({}).optional();

export const icalRoomConfigSchema = z.object({
  icalUrl: z.string().url(),
});

/** Minimal VEVENT parser — extracts events from raw ICS text */
function parseIcs(ics: string, windowStart: Date, windowEnd: Date): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const blocks = ics.split("BEGIN:VEVENT");

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split("END:VEVENT")[0];
    const get = (key: string): string => {
      const match = block.match(new RegExp(`^${key}[^:]*:(.+)$`, "m"));
      return match?.[1]?.trim() ?? "";
    };

    const dtStart = parseIcsDate(get("DTSTART"));
    const dtEnd = parseIcsDate(get("DTEND"));
    if (!dtStart || !dtEnd) continue;
    if (dtEnd <= windowStart || dtStart >= windowEnd) continue;

    events.push({
      subject: get("SUMMARY").replace(/\\,/g, ",").replace(/\\n/g, " "),
      organizer: extractOrganizerName(get("ORGANIZER")),
      startTime: dtStart,
      endTime: dtEnd,
      isPrivate: get("CLASS") === "PRIVATE",
    });
  }

  return events.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

/** Parse ICS date formats: 20260423T080000Z or 20260423T080000 */
function parseIcsDate(raw: string): Date | null {
  const clean = raw.replace(/[^0-9TZ]/g, "");
  const m = clean.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? "Z" : ""}`;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Extract display name from ORGANIZER:CN=Name:mailto:... */
function extractOrganizerName(raw: string): string {
  const cn = raw.match(/CN=([^;:]+)/i);
  return cn?.[1]?.replace(/"/g, "") ?? "";
}

export const icalProvider: CalendarProvider = {
  type: "ical",
  name: "iCal URL",
  credentialSchema: icalCredentialSchema,
  roomConfigSchema: icalRoomConfigSchema,

  async fetchEvents({ roomConfig, windowStart, windowEnd }) {
    const room = icalRoomConfigSchema.parse(roomConfig);
    const res = await fetch(room.icalUrl, {
      headers: { Accept: "text/calendar" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`iCal fetch failed: ${res.status}`);
    const ics = await res.text();
    return parseIcs(ics, windowStart, windowEnd);
  },
};
