// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * anny.co calendar provider — room/workspace booking system.
 *
 * Uses the anny Admin API to fetch bookings for a specific resource.
 * Auth: Bearer token (may have access to multiple organizations).
 * API: JSON:API format, base URL https://b.anny.co
 */

import { z } from "zod";
import type { CalendarProvider, CalendarEvent } from "../types";
import { log } from "@/lib/logger";

const ANNY_BASE = "https://b.anny.co/api/v1";

export const annyCredentialSchema = z.object({
  apiToken: z.string().min(1),
});

export const annyRoomConfigSchema = z.object({
  organizationId: z.string().min(1),
  resourceId: z.string().uuid(),
  resourceName: z.string().optional(),
});

interface AnnyBooking {
  id: string;
  attributes: {
    start: string;
    end: string;
    status: string;
    notes?: string | null;
  };
  relationships?: {
    customer?: { data?: { id: string; type: string } | null };
  };
}

interface AnnyIncluded {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
}

async function annyFetch(
  path: string,
  token: string,
  orgId: string | null,
  params: Record<string, string> = {}
): Promise<{ data: unknown[]; included?: unknown[]; meta?: { page?: { total?: number } } }> {
  const url = new URL(`${ANNY_BASE}${path}`);
  if (orgId) url.searchParams.set("o", orgId);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.api+json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    log.warn("anny API error", { path, status: res.status, body: text.slice(0, 200) });
    throw new Error(`anny API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Fetch organizations available to this API token.
 */
export async function fetchAnnyOrganizations(
  apiToken: string
): Promise<{ id: string; name: string; slug: string }[]> {
  const result = await annyFetch("/organizations", apiToken, null, {
    "fields[organizations]": "name,slug",
  });

  return (result.data as { id: string; attributes: { name: string; slug: string } }[]).map((o) => ({
    id: o.id,
    name: o.attributes.name,
    slug: o.attributes.slug,
  }));
}

/**
 * Fetch resources (rooms) from anny for a specific organization.
 */
export async function fetchAnnyResources(
  apiToken: string,
  organizationId: string,
  search?: string,
  page = 1,
  perPage = 20
): Promise<{ resources: { id: string; name: string; description?: string }[]; total: number }> {
  const params: Record<string, string> = {
    "page[number]": String(page),
    "page[size]": String(perPage),
    "fields[resources]": "name,description",
  };
  if (search) {
    params["filter[search]"] = search;
  }

  const result = await annyFetch("/resources", apiToken, organizationId, params);

  const resources = (result.data as { id: string; attributes: { name: string; description?: string } }[]).map((r) => ({
    id: r.id,
    name: r.attributes.name,
    description: r.attributes.description,
  }));

  return {
    resources,
    total: (result.meta?.page?.total as number) ?? resources.length,
  };
}

export const annyProvider: CalendarProvider = {
  type: "anny",
  name: "anny.co — Room & Workspace Booking",
  credentialSchema: annyCredentialSchema,
  roomConfigSchema: annyRoomConfigSchema,

  async fetchEvents({ credentials, roomConfig, windowStart, windowEnd }) {
    const creds = annyCredentialSchema.parse(credentials);
    const room = annyRoomConfigSchema.parse(roomConfig);

    log.info("anny: fetching bookings", {
      resourceId: room.resourceId,
      orgId: room.organizationId,
      from: windowStart.toISOString().split("T")[0],
      to: windowEnd.toISOString().split("T")[0],
    });

    const result = await annyFetch(
      "/bookings",
      creds.apiToken,
      room.organizationId,
      {
        "filter[resource_id]": room.resourceId,
        "filter[date_from]": windowStart.toISOString().split("T")[0],
        "filter[date_to]": windowEnd.toISOString().split("T")[0],
        "filter[status]": "accepted",
        "include": "customer",
        "fields[bookings]": "start,end,status,notes",
        "fields[customers]": "first_name,last_name",
        "page[size]": "100",
      }
    );

    const bookings = result.data as AnnyBooking[];
    const included = (result.included ?? []) as AnnyIncluded[];

    const customers = new Map<string, string>();
    for (const inc of included) {
      if (inc.type === "customers") {
        const first = (inc.attributes.first_name as string) ?? "";
        const last = (inc.attributes.last_name as string) ?? "";
        customers.set(inc.id, `${first} ${last}`.trim());
      }
    }

    const events: CalendarEvent[] = [];
    for (const b of bookings) {
      const start = new Date(b.attributes.start);
      const end = new Date(b.attributes.end);
      if (end <= windowStart || start >= windowEnd) continue;

      const customerId = b.relationships?.customer?.data?.id;
      const organizer = customerId ? (customers.get(customerId) ?? "Booked") : "Booked";

      events.push({
        subject: b.attributes.notes || room.resourceName || "Booking",
        organizer,
        startTime: start,
        endTime: end,
        isPrivate: false,
      });
    }

    log.info("anny: bookings fetched", { resourceId: room.resourceId, count: events.length });
    return events;
  },
};
