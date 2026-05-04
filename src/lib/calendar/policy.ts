// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import type { CalendarEvent, DisplayEvent, RoomPolicy } from "@/lib/types";

const RESERVED_TEXT: Record<string, string> = {
  en: "Reserved", de: "Reserviert", fr: "Réservé", it: "Riservato", es: "Reservado",
};

const BOOKED_BY_TEXT: Record<string, string> = {
  en: "Booked by", de: "Gebucht von", fr: "Réservé par", it: "Prenotato da", es: "Reservado por",
};

/**
 * Transforms calendar events based on the room's privacy policy.
 */
export function applyRoomPolicy(
  events: CalendarEvent[],
  policy: RoomPolicy,
  locale: string = "en"
): DisplayEvent[] {
  const reserved = RESERVED_TEXT[locale] ?? RESERVED_TEXT.en;
  const bookedBy = BOOKED_BY_TEXT[locale] ?? BOOKED_BY_TEXT.en;

  switch (policy) {
    case "Show All":
      return events.map((evt) =>
        evt.isPrivate
          ? {
              displaySubject: `${bookedBy} ${evt.organizer}`,
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
        displaySubject: reserved,
        organizer: "",
        startTime: evt.startTime,
        endTime: evt.endTime,
        isPrivate: evt.isPrivate,
        showLockIcon: false,
      }));

    case "Hide All":
      return [];
  }
}
