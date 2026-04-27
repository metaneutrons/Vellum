// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import type { CalendarEvent, DisplayEvent, RoomPolicy } from "@/lib/types";

/**
 * Transforms calendar events based on the room's privacy policy.
 *
 * - "Show All": public events keep subject/organizer; private events
 *   become "Booked by [Organizer]" with a lock icon.
 * - "Hide Subject": all events get "Reserved" subject, time preserved.
 * - "Hide All": returns only a FREE/BUSY indicator (no event details).
 */
export function applyRoomPolicy(
  events: CalendarEvent[],
  policy: RoomPolicy
): DisplayEvent[] {
  switch (policy) {
    case "Show All":
      return events.map((evt) =>
        evt.isPrivate
          ? {
              displaySubject: `Booked by ${evt.organizer}`,
              organizer: evt.organizer,
              startTime: evt.startTime,
              endTime: evt.endTime,
              isPrivate: true,
              showLockIcon: true,
            }
          : {
              displaySubject: evt.subject,
              organizer: evt.organizer,
              startTime: evt.startTime,
              endTime: evt.endTime,
              isPrivate: false,
              showLockIcon: false,
            }
      );

    case "Hide Subject":
      return events.map((evt) => ({
        displaySubject: "Reserved",
        organizer: "",
        startTime: evt.startTime,
        endTime: evt.endTime,
        isPrivate: evt.isPrivate,
        showLockIcon: false,
      }));

    case "Hide All":
      // No event details exposed — caller uses array length to determine FREE/BUSY
      return [];
  }
}
