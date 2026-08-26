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
  /**
   * The organizer's given name and surname, when the SOURCE separates them.
   *
   * A door sign sets the surname several times larger than the rest of the name,
   * because the surname alone decides how far away the sign can be read. Working
   * that split out of one display string takes a heuristic (see
   * `content/renderers/name-split.ts`), and a heuristic that a provider can make
   * unnecessary should be made unnecessary: anny returns `given_name` and
   * `family_name` as separate fields, so it fills these in and nothing has to be
   * guessed. Microsoft Graph offers only `displayName` on a calendar event, so it
   * leaves them unset and the heuristic runs.
   *
   * Both absent means "this provider does not know", never "this person has no
   * surname".
   */
  organizerGiven?: string;
  organizerSurname?: string;
}

/** One bookable thing a provider knows about: a room, a desk, a resource. */
export interface ResourceRef {
  id: string;
  name: string;
  description?: string;
  /** Public booking link, when the provider exposes one for this resource. */
  bookingUrl?: string;
  /**
   * The resource this one sits inside, when it is a seat within a room.
   *
   * anny models a flex office as a parent resource with one child per desk, each
   * a first-class resource with its own id and its own bookings — "S1 3er
   * Flexbüro Sylt" contains "Sylt 1", "Sylt2", "Sylt 3". A name plate for that
   * door wants one band per SEAT, so the seats have to be selectable, and a bare
   * list of them would be unreadable without saying which room they belong to.
   */
  parentId?: string;
  parentName?: string;
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
  getBookingUrl?(params: {
    credentials: unknown;
    roomConfig: unknown;
  }): string | null | Promise<string | null>;
}
