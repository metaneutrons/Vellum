// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Microsoft 365 calendar provider — Graph API client credentials flow.
 */

import { z } from "zod";
import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import {
  TokenCredentialAuthenticationProvider,
} from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials";
import type { CalendarProvider, CalendarEvent } from "../types";

export const m365CredentialSchema = z.object({
  tenantId: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

export const m365RoomConfigSchema = z.object({
  roomEmail: z.string().email(),
});

export const microsoft365Provider: CalendarProvider = {
  type: "microsoft365",
  name: "Microsoft 365",
  credentialSchema: m365CredentialSchema,
  roomConfigSchema: m365RoomConfigSchema,

  async fetchEvents({ credentials, roomConfig, windowStart, windowEnd }) {
    const creds = m365CredentialSchema.parse(credentials);
    const room = m365RoomConfigSchema.parse(roomConfig);

    const credential = new ClientSecretCredential(
      creds.tenantId, creds.clientId, creds.clientSecret
    );
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ["https://graph.microsoft.com/.default"],
    });
    const client = Client.initWithMiddleware({ authProvider });

    const response = await client
      .api(`/users/${encodeURIComponent(room.roomEmail)}/calendarView`)
      .query({
        startDateTime: windowStart.toISOString(),
        endDateTime: windowEnd.toISOString(),
      })
      .select("subject,organizer,attendees,start,end,sensitivity")
      .orderby("start/dateTime")
      .get();

    const roomEmailLower = room.roomEmail.toLowerCase();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (response.value ?? []).map((evt: any): CalendarEvent => {
      // The organizer from Graph is the person who created the meeting
      const organizerName: string = evt.organizer?.emailAddress?.name ?? "";
      const organizerEmail: string = (evt.organizer?.emailAddress?.address ?? "").toLowerCase();

      // Filter attendees: exclude the room itself and the organizer
      const attendees: string[] = (evt.attendees ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((a: any) => {
          const email = (a.emailAddress?.address ?? "").toLowerCase();
          return email !== roomEmailLower && email !== organizerEmail;
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((a: any) => a.emailAddress?.name ?? "")
        .filter(Boolean);

      // Build organizer line — skip if organizer is the room itself
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

      return {
        subject: (evt.subject ?? "").trim(),
        organizer: organizerLine,
        startTime: new Date(evt.start?.dateTime + "Z"),
        endTime: new Date(evt.end?.dateTime + "Z"),
        isPrivate: evt.sensitivity === "private",
      };
    });
  },
};
