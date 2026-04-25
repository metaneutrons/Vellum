/**
 * Google Calendar provider — service account credentials.
 *
 * Uses the Google Calendar API v3 via REST (no SDK dependency).
 * Authenticates with a service account JWT.
 */

import { z } from "zod";
import crypto from "crypto";
import type { CalendarProvider, CalendarEvent } from "../types";

export const googleCredentialSchema = z.object({
  clientEmail: z.string().email(),
  privateKey: z.string().min(1),
});

export const googleRoomConfigSchema = z.object({
  calendarId: z.string().min(1),
});

/** Create a signed JWT for Google API access */
export function createJwt(email: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: email,
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");

  const signature = crypto
    .createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey, "base64url");

  return `${header}.${payload}.${signature}`;
}

/** Exchange JWT for an access token */
async function getAccessToken(email: string, privateKey: string): Promise<string> {
  const jwt = createJwt(email, privateKey);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`);
  const json = await res.json() as { access_token: string };
  return json.access_token;
}

export const googleProvider: CalendarProvider = {
  type: "google",
  name: "Google Calendar",
  credentialSchema: googleCredentialSchema,
  roomConfigSchema: googleRoomConfigSchema,

  async fetchEvents({ credentials, roomConfig, windowStart, windowEnd }) {
    const creds = googleCredentialSchema.parse(credentials);
    const room = googleRoomConfigSchema.parse(roomConfig);

    const token = await getAccessToken(creds.clientEmail, creds.privateKey);
    const params = new URLSearchParams({
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
    });

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(room.calendarId)}/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Google Calendar API error: ${res.status}`);

    const json = await res.json() as { items?: Array<{
      summary?: string;
      organizer?: { displayName?: string };
      start?: { dateTime?: string };
      end?: { dateTime?: string };
      visibility?: string;
    }> };

    return (json.items ?? [])
      .filter((evt) => evt.start?.dateTime && evt.end?.dateTime)
      .map((evt): CalendarEvent => ({
      subject: evt.summary ?? "",
      organizer: evt.organizer?.displayName ?? "",
      startTime: new Date(evt.start?.dateTime ?? ""),
      endTime: new Date(evt.end?.dateTime ?? ""),
      isPrivate: evt.visibility === "private",
    }));
  },
};
