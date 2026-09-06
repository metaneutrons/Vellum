// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * iCal URL provider — fetches an .ics file and parses VEVENT entries.
 *
 * No credentials needed — just a public or pre-authenticated URL.
 * Supports any standard iCalendar feed (Outlook publish, Google public, etc.)
 */

import { z } from "zod";
import { TZDate } from "@date-fns/tz";
import type { CalendarProvider, CalendarEvent } from "../types";
import { safeFetch } from "@/lib/safe-fetch";

export const icalCredentialSchema = z.object({
  url: z.url(),
});

export const icalRoomConfigSchema = z.object({});

/**
 * Minimal VEVENT parser — extracts events from raw ICS text.
 *
 * NOTE: recurring events (RRULE) are NOT expanded — only the master VEVENT's
 * single occurrence is considered. Feeds that rely on RRULE for recurring
 * bookings should be pre-expanded upstream.
 */
export function parseIcs(ics: string, windowStart: Date, windowEnd: Date): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const blocks = ics.split("BEGIN:VEVENT");

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split("END:VEVENT")[0];
    // Value only (params discarded) — for SUMMARY/ORGANIZER/CLASS.
    const get = (key: string): string =>
      block.match(new RegExp(`^${key}[^:]*:(.+)$`, "m"))?.[1]?.trim() ?? "";
    // Property with its parameters (e.g. `;TZID=Europe/Berlin` / `;VALUE=DATE`).
    const getProp = (key: string): { params: string; value: string } | null => {
      const m = block.match(new RegExp(`^${key}([^:]*):(.+)$`, "m"));
      return m ? { params: m[1], value: m[2].trim() } : null;
    };

    const startProp = getProp("DTSTART");
    if (!startProp) continue;
    const start = parseIcsDateTime(startProp.value, startProp.params);
    if (!start) continue;

    const endProp = getProp("DTEND");
    let end = endProp ? parseIcsDateTime(endProp.value, endProp.params) : null;
    // Missing DTEND: all-day events span one day; timed events are treated as
    // ending at DTSTART (window filtering still works).
    end ??= {
      date: new Date(start.date.getTime() + (start.allDay ? 86_400_000 : 0)),
      allDay: start.allDay,
    };
    if (end.date <= windowStart || start.date >= windowEnd) continue;

    events.push({
      subject: get("SUMMARY").replace(/\\,/g, ",").replace(/\\n/g, " "),
      organizer: extractOrganizerName(get("ORGANIZER")),
      startTime: start.date,
      endTime: end.date,
      isPrivate: get("CLASS") === "PRIVATE",
    });
  }

  return events.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}

/**
 * Parse an ICS date-time property to a UTC instant, honoring TZID and VALUE=DATE.
 *   - `VALUE=DATE` (or bare YYYYMMDD): all-day → anchored at UTC midnight.
 *   - trailing `Z`: already UTC.
 *   - `TZID=<IANA>`: wall-clock time interpreted in that zone → correct UTC instant.
 *   - floating (no Z, no TZID): interpreted as UTC for determinism.
 */
function parseIcsDateTime(value: string, params: string): { date: Date; allDay: boolean } | null {
  const v = value.replace(/[^0-9TZ]/g, "");
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, hh = "00", mm = "00", ss = "00", z] = m;
  const [yr, moIdx, day, h, mi, s] = [+y, +mo - 1, +d, +hh, +mm, +ss];

  const isAllDay = /VALUE=DATE(?!-)/i.test(params) || !m[4];
  if (isAllDay) return { date: new Date(Date.UTC(yr, moIdx, day)), allDay: true };

  if (z) return { date: new Date(Date.UTC(yr, moIdx, day, h, mi, s)), allDay: false };

  const tzid = params.match(/TZID=([^;:]+)/i)?.[1]?.trim();
  if (tzid) {
    const t = new TZDate(yr, moIdx, day, h, mi, s, tzid).getTime();
    return isNaN(t) ? null : { date: new Date(t), allDay: false };
  }
  return { date: new Date(Date.UTC(yr, moIdx, day, h, mi, s)), allDay: false };
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

  async fetchEvents({ credentials, windowStart, windowEnd }) {
    const creds = icalCredentialSchema.parse(credentials);
    const res = await safeFetch(creds.url, {
      headers: { Accept: "text/calendar" },
    });
    if (!res.ok) throw new Error(`iCal fetch failed: ${res.status}`);
    const ics = await res.text();
    return parseIcs(ics, windowStart, windowEnd);
  },
};
