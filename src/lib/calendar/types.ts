// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
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

/** One bookable thing a provider knows about: a room, a desk, a resource. */
export interface ResourceRef {
  id: string;
  name: string;
  description?: string;
  /** Public booking link, when the provider exposes one for this resource. */
  bookingUrl?: string;
}

export interface CalendarProvider {
  type: string;
  name: string;
  credentialSchema: z.ZodType;
  roomConfigSchema: z.ZodType;

  /**
   * Enumerate the provider's resources, so an operator can pick one instead of
   * pasting an identifier they had to find somewhere else.
   *
   * OPTIONAL, and its absence is a real answer rather than a gap: for an iCal
   * feed the URL *is* the resource, so there is nothing to enumerate and nothing
   * a picker could offer. Callers that find this missing should ask for the
   * identifier directly and say why, not present an empty search box.
   *
   * `search` is passed through to the source rather than filtered here, because a
   * directory can hold thousands of rooms and the useful match may not be on the
   * first page. Same reason `page` exists.
   */
  listResources?(params: {
    credentials: unknown;
    search?: string;
    page?: number;
  }): Promise<{ resources: ResourceRef[]; total?: number }>;
  fetchEvents(params: {
    credentials: unknown;
    roomConfig: unknown;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<CalendarEvent[]>;
  /**
   * Return a public, resource-specific booking URL when the provider exposes
   * one. This deliberately lives alongside the resource configuration rather
   * than on calendar events: a booking link describes a room, not a meeting.
   */
  getBookingUrl?(params: { credentials: unknown; roomConfig: unknown }): string | null;
}
