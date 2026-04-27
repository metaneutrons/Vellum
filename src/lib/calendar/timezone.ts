// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { TZDate } from "@date-fns/tz";

/**
 * Converts a UTC Date to a TZDate in the given IANA timezone.
 *
 * The returned TZDate carries the timezone context so that date-fns
 * functions (format, isBefore, etc.) operate in the room's local time.
 */
export function toRoomTime(utcDate: Date, timezone: string): TZDate {
  return new TZDate(utcDate, timezone);
}

/**
 * Converts a TZDate (or any Date) back to a plain UTC Date.
 *
 * This preserves the underlying instant — only the representation changes.
 */
export function toUTC(date: Date): Date {
  return new Date(date.getTime());
}
