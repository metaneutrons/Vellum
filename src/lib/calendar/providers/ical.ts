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
    const block = blocks[i]?.split("END:VEVENT")[0];
    if (block === undefined) continue;
    /* Split once and look up by prefix rather than building a RegExp per property.
     * The keys are literals from this file, so the old `new RegExp(`^${key}...`)`
     * was not injectable, but a constructor fed a variable is worth not writing at
     * all — and one pass over the lines beats compiling a pattern per lookup. */
    const lines = block.split(/\r?\n/);

    /** The first line naming this property, split at its first colon. */
    const findProp = (key: string): { params: string; value: string } | null => {
      for (const line of lines) {
        if (!line.startsWith(key)) continue;
        const colon = line.indexOf(":");
        /* Everything between the key and the colon is the parameter list, and it
         * cannot itself contain a colon — same shape the pattern matched. */
        if (colon < key.length) continue;
        return { params: line.slice(key.length, colon), value: line.slice(colon + 1).trim() };
      }
      return null;
    };

    // Value only (params discarded) — for SUMMARY/ORGANIZER/CLASS.
    const get = (key: string): string => findProp(key)?.value ?? "";
    // Property with its parameters (e.g. `;TZID=Europe/Berlin` / `;VALUE=DATE`).
    const getProp = findProp;

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
  /* The date groups are not optional in the pattern, so a match always fills
   * them. Returning null keeps the impossible case inside this function's
   * contract instead of letting `+undefined` reach Date.UTC as NaN. */
  if (y === undefined || mo === undefined || d === undefined) return null;
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
