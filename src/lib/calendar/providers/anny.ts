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

/** Extract organization (tenant) ID from anny JWT token */
export function extractOrgFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return payload.tenant ?? null;
  } catch {
    return null;
  }
}

export const annyCredentialSchema = z.object({
  apiToken: z.string().min(1),
  organizationId: z.string().optional(),
});

export const annyRoomConfigSchema = z.object({
  resourceId: z.string().min(1),
  resourceName: z.string().optional(),
});

interface AnnyBooking {
  id: string;
  attributes: {
    start_date: string;
    end_date: string;
    status: string;
    description?: string | null;
    note?: string | null;
    /** True for the MASTER of a recurring series — an envelope spanning
     *  [first occurrence, last occurrence]. The real occurrences arrive as
     *  separate `is_series` member bookings. */
    is_series_master?: boolean;
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

interface AnnyPage {
  "current-page"?: number;
  "last-page"?: number;
  total?: number;
}

interface AnnyResponse {
  data: unknown[];
  included?: unknown[];
  meta?: { page?: AnnyPage };
}

const ANNY_PAGE_SIZE = 50;

async function annyFetch(
  path: string,
  token: string,
  orgId: string | null,
  params: Record<string, string> = {}
): Promise<AnnyResponse> {
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

/** Fetch every page for anny endpoints whose result set can exceed one page. */
async function annyFetchAll(
  path: string,
  token: string,
  orgId: string | null,
  params: Record<string, string> = {}
): Promise<AnnyResponse> {
  const first = await annyFetch(path, token, orgId, {
    ...params,
    "page[number]": "1",
    "page[size]": String(ANNY_PAGE_SIZE),
  });
  const lastPage = first.meta?.page?.["last-page"] ?? 1;

  if (!Number.isInteger(lastPage) || lastPage < 1) return first;

  const data = [...first.data];
  const included = [...(first.included ?? [])];
  for (let page = 2; page <= lastPage; page++) {
    const next = await annyFetch(path, token, orgId, {
      ...params,
      "page[number]": String(page),
      "page[size]": String(ANNY_PAGE_SIZE),
    });
    data.push(...next.data);
    included.push(...(next.included ?? []));
  }

  return { data, included, meta: first.meta };
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

    const orgId = creds.organizationId || extractOrgFromToken(creds.apiToken) || "";
    if (!orgId) throw new Error("Cannot determine organization ID from token");

    log.info("anny: fetching bookings", {
      resourceId: room.resourceId,
      orgId,
      from: windowStart.toISOString().split("T")[0],
      to: windowEnd.toISOString().split("T")[0],
    });

    const result = await annyFetchAll(
      "/bookings",
      creds.apiToken,
      orgId,
      {
        "filter[resources]": room.resourceId,
        "filter[status]": "accepted",
        "include": "customer",
      }
    );

    const bookings = result.data as AnnyBooking[];
    const included = (result.included ?? []) as AnnyIncluded[];

    const customers = new Map<string, string>();
    for (const inc of included) {
      if (inc.type === "customers") {
        const first = (inc.attributes.given_name as string) ?? "";
        const last = (inc.attributes.family_name as string) ?? "";
        customers.set(inc.id, `${first} ${last}`.trim());
      }
    }

    const events: CalendarEvent[] = [];
    for (const b of bookings) {
      // Skip recurring-series MASTER bookings. anny returns the master as a
      // single envelope spanning [first occurrence, last occurrence] — which
      // can be weeks or months — AND returns every occurrence as its own
      // `is_series` member booking. Including the master would mark the room
      // occupied for the entire span (e.g. a daily 15:00–16:00 series showing
      // BELEGT around the clock for three weeks).
      if (b.attributes.is_series_master) continue;

      const start = new Date(b.attributes.start_date);
      const end = new Date(b.attributes.end_date);
      if (end <= windowStart || start >= windowEnd) continue;

      const customerId = b.relationships?.customer?.data?.id;
      const organizer = customerId ? (customers.get(customerId) ?? "Booked") : "Booked";

      events.push({
        subject: b.attributes.description || room.resourceName || "Booking",
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
