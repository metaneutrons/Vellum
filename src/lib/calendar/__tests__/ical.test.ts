// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, it, expect } from "vitest";
import { parseIcs } from "../providers/ical";

const WSTART = new Date("2026-04-01T00:00:00Z");
const WEND = new Date("2026-05-01T00:00:00Z");

function vevent(lines: string): string {
  return `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n${lines}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
}

describe("iCal parser", () => {
  it("interprets TZID wall-clock time as the correct UTC instant", () => {
    // 08:00 Europe/Berlin on 2026-04-23 (CEST, UTC+2) => 06:00Z
    const ics = vevent(
      "SUMMARY:Standup\r\nDTSTART;TZID=Europe/Berlin:20260423T080000\r\nDTEND;TZID=Europe/Berlin:20260423T083000"
    );
    const [ev] = parseIcs(ics, WSTART, WEND);
    expect(ev.subject).toBe("Standup");
    expect(ev.startTime.toISOString()).toBe("2026-04-23T06:00:00.000Z");
    expect(ev.endTime.toISOString()).toBe("2026-04-23T06:30:00.000Z");
  });

  it("keeps all-day (VALUE=DATE) events instead of dropping them", () => {
    const ics = vevent("SUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20260423\r\nDTEND;VALUE=DATE:20260424");
    const [ev] = parseIcs(ics, WSTART, WEND);
    expect(ev).toBeDefined();
    expect(ev.subject).toBe("Holiday");
    expect(ev.startTime.toISOString()).toBe("2026-04-23T00:00:00.000Z");
    expect(ev.endTime.toISOString()).toBe("2026-04-24T00:00:00.000Z");
  });

  it("bare 8-digit DTSTART is treated as all-day", () => {
    const ics = vevent("SUMMARY:AllDay\r\nDTSTART:20260423\r\nDTEND:20260424");
    const [ev] = parseIcs(ics, WSTART, WEND);
    expect(ev.startTime.toISOString()).toBe("2026-04-23T00:00:00.000Z");
  });

  it("honors a trailing Z as UTC", () => {
    const ics = vevent("SUMMARY:UTC\r\nDTSTART:20260423T080000Z\r\nDTEND:20260423T090000Z");
    const [ev] = parseIcs(ics, WSTART, WEND);
    expect(ev.startTime.toISOString()).toBe("2026-04-23T08:00:00.000Z");
  });

  it("filters events outside the window", () => {
    const ics = vevent("SUMMARY:Past\r\nDTSTART:20260101T080000Z\r\nDTEND:20260101T090000Z");
    expect(parseIcs(ics, WSTART, WEND)).toHaveLength(0);
  });
});
