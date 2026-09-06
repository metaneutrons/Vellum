// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Microsoft 365 calendar provider — Graph API client credentials flow.
 */

import { z } from "zod";
import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials";
import type { CalendarProvider, CalendarEvent } from "../types";

export const m365CredentialSchema = z.object({
  tenantId: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

export const m365RoomConfigSchema = z.object({
  roomEmail: z.email(),
});

/**
 * What this provider actually needs out of a Graph calendarView answer.
 *
 * Everything here is optional because Graph omits fields rather than sending
 * nulls, and `.catch` on the envelope means a single malformed entry does not
 * discard the whole day: an unparseable event drops out, the rest still reaches
 * the panel. A room sign that shows four of five bookings is worth more than one
 * that shows an error.
 *
 * The reason this is a schema and not a cast: the previous code read the answer
 * as `any` and built `new Date(evt.start?.dateTime + "Z")`. With `dateTime`
 * absent that is the string "undefinedZ", so the event silently carried an
 * Invalid Date into the timeline rather than being rejected.
 */
const graphEmailAddress = z.object({
  name: z.string().optional(),
  address: z.string().optional(),
});

const graphEvent = z.object({
  subject: z.string().optional(),
  sensitivity: z.string().optional(),
  organizer: z.object({ emailAddress: graphEmailAddress.optional() }).optional(),
  attendees: z.array(z.object({ emailAddress: graphEmailAddress.optional() })).optional(),
  start: z.object({ dateTime: z.string() }).optional(),
  end: z.object({ dateTime: z.string() }).optional(),
});

const graphCalendarView = z.object({
  value: z.array(graphEvent.nullable().catch(null)).optional(),
});

type GraphEvent = z.infer<typeof graphEvent>;

export const microsoft365Provider: CalendarProvider = {
  type: "microsoft365",
  name: "Microsoft 365",
  credentialSchema: m365CredentialSchema,
  roomConfigSchema: m365RoomConfigSchema,

  async fetchEvents({ credentials, roomConfig, windowStart, windowEnd }) {
    const creds = m365CredentialSchema.parse(credentials);
    const room = m365RoomConfigSchema.parse(roomConfig);

    const credential = new ClientSecretCredential(
      creds.tenantId,
      creds.clientId,
      creds.clientSecret
    );
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ["https://graph.microsoft.com/.default"],
    });
    const client = Client.initWithMiddleware({ authProvider });

    /* `unknown`, not the library's `any`: the client hands back whatever the
     * service sent, and the schema below is what turns that into a type. Left as
     * `any` the annotation would spread outward silently. */
    const response: unknown = await client
      .api(`/users/${encodeURIComponent(room.roomEmail)}/calendarView`)
      .query({
        startDateTime: windowStart.toISOString(),
        endDateTime: windowEnd.toISOString(),
      })
      .select("subject,organizer,attendees,start,end,sensitivity")
      .orderby("start/dateTime")
      .get();

    const roomEmailLower = room.roomEmail.toLowerCase();
    const events = graphCalendarView.parse(response).value ?? [];

    return events
      .filter((evt): evt is GraphEvent => evt !== null)
      .map((evt): CalendarEvent | null => {
        // The organizer from Graph is the person who created the meeting.
        const organizerName = evt.organizer?.emailAddress?.name ?? "";
        const organizerEmail = (evt.organizer?.emailAddress?.address ?? "").toLowerCase();

        // Filter attendees: exclude the room itself and the organizer.
        const attendees = (evt.attendees ?? [])
          .filter((a) => {
            const email = (a.emailAddress?.address ?? "").toLowerCase();
            return email !== roomEmailLower && email !== organizerEmail;
          })
          .map((a) => a.emailAddress?.name ?? "")
          .filter(Boolean);

        // Build organizer line — skip if organizer is the room itself.
        let organizerLine = "";
        if (organizerEmail !== roomEmailLower && organizerName) {
          organizerLine = organizerName;
          if (attendees.length > 0) {
            organizerLine += ` (+${attendees.length})`;
          }
        } else if (attendees.length > 0) {
          organizerLine = attendees.slice(0, 3).join(", ");
          if (attendees.length > 3) organizerLine += ` (+${attendees.length - 3})`;
        }

        /* Without both timestamps there is no booking to draw. Previously this
         * produced an Invalid Date and the event travelled on into the timeline. */
        if (!evt.start?.dateTime || !evt.end?.dateTime) return null;
        const startTime = new Date(`${evt.start.dateTime}Z`);
        const endTime = new Date(`${evt.end.dateTime}Z`);
        if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) return null;

        return {
          subject: (evt.subject ?? "").trim(),
          organizer: organizerLine,
          startTime,
          endTime,
          isPrivate: evt.sensitivity === "private",
        };
      })
      .filter((e): e is CalendarEvent => e !== null);
  },
};
