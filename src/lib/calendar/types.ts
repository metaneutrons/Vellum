/**
 * Calendar provider interface — plugin system for calendar sources.
 *
 * Each provider implements fetchEvents() to return a common CalendarEvent[].
 * Credentials are stored encrypted in the DB; decrypted at fetch time.
 */

import { z } from "zod";

export interface CalendarEvent {
  subject: string;
  organizer: string;
  startTime: Date;
  endTime: Date;
  isPrivate: boolean;
}

export interface CalendarProvider {
  type: string;
  name: string;
  credentialSchema: z.ZodType;
  roomConfigSchema: z.ZodType;
  fetchEvents(params: {
    credentials: unknown;
    roomConfig: unknown;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<CalendarEvent[]>;
}
