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
import type { CalendarProvider, CalendarEvent, ResourceRef } from "../types";
import { TtlCache } from "@/lib/cache";
import { log } from "@/lib/logger";

const ANNY_BASE = "https://b.anny.co/api/v1";

/** Extract organization (tenant) ID from anny JWT token */
export function extractOrgFromToken(token: string): string | null {
  try {
    /* A JWT payload is whatever the issuer put there; only `tenant` is read. A
     * token without a payload segment is caught below either way, but saying so
     * here keeps the throw out of Buffer.from. */
    const segment = token.split(".")[1];
    if (segment === undefined) return null;
    const payload: unknown = JSON.parse(Buffer.from(segment, "base64url").toString());
    const parsed = z.object({ tenant: z.string().optional() }).safeParse(payload);
    return parsed.success ? (parsed.data.tenant ?? null) : null;
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
  /** Persisted from Anny's resource slug; never infer this from a display name. */
  bookingUrl: z.url().max(256).optional(),
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

/* The JSON:API envelope this provider relies on. Only the three fields the code
 * reads are described; everything inside `data` stays `unknown` and is narrowed
 * where it is used. `.catch` on the envelope is deliberate: a malformed answer
 * becomes an empty result rather than an exception, because a room sign that
 * shows nothing is better than one that shows a stack trace. */
const annyEnvelope = z
  .object({
    data: z.array(z.unknown()).default([]),
    included: z.array(z.unknown()).optional(),
    meta: z.object({ page: z.unknown().optional() }).optional(),
  })
  .catch({ data: [] });

const ANNY_PAGE_SIZE = 50;
/* A display may poll every few minutes, while a public booking slug rarely
 * changes. Cache successful and unsuccessful legacy lookups alike. */
const bookingUrlCache = new TtlCache<string | null>(5 * 60_000);

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

  return annyEnvelope.parse(await res.json()) as AnnyResponse;
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

interface AnnyResource {
  id: string;
  type?: string;
  attributes: { name: string; description?: string; slug?: string; archived?: boolean };
  relationships?: { children?: { data?: { id: string }[] } };
}

function toResourceRef(r: AnnyResource, parent?: AnnyResource): ResourceRef {
  return {
    id: r.id,
    name: r.attributes.name,
    description: r.attributes.description,
    /* A resource ID and its public booking slug are unrelated. Only build a
     * direct link when anny explicitly supplied the latter. */
    bookingUrl: r.attributes.slug
      ? `https://anny.co/b/book/${encodeURIComponent(r.attributes.slug)}`
      : undefined,
    parentId: parent?.id,
    parentName: parent?.attributes.name,
  };
}

/**
 * Flatten anny's parent/child resources into one selectable list.
 *
 * Each seat follows its room directly, so a caller can indent by `parentId`
 * without holding a tree. Archived resources are dropped at either level:
 * offering one would set up a display that can never show a booking.
 *
 * Separated from the request so the ordering and the archived rule can be tested
 * without the network.
 */
export function flattenAnnyResources(
  data: AnnyResource[],
  included: AnnyResource[]
): ResourceRef[] {
  const byId = new Map(
    included.filter((i) => !i.type || i.type === "resources").map((i) => [i.id, i])
  );

  const out: ResourceRef[] = [];
  for (const parent of data) {
    if (parent.attributes.archived) continue;
    out.push(toResourceRef(parent));
    for (const ref of parent.relationships?.children?.data ?? []) {
      const child = byId.get(ref.id);
      if (!child || child.attributes.archived) continue;
      out.push(toResourceRef(child, parent));
    }
  }
  return out;
}

/**
 * Fetch resources from anny, INCLUDING the seats inside a room.
 *
 * anny models a flex office as a parent resource with one child per desk, and
 * each child is a first-class resource with its own id and its own bookings:
 * "S1 3er Flexbüro Sylt (1J.2.24)" contains "Sylt 1", "Sylt2", "Sylt 3". The
 * flat resource list returns PARENTS ONLY — 30 entries for an estate where 18 of
 * them have children — so a picker built on it could not reach a single seat, and
 * a name plate for a three-desk door had no way to name its three occupants.
 *
 * Two things about this are easy to get wrong and were verified against the live
 * API rather than assumed:
 *
 *   `children` MUST appear in `fields[resources]`. JSON:API sparse fieldsets
 *   limit relationships as well as attributes, so `include=children` alongside
 *   the previous `name,description,slug` returned zero children — silently, with
 *   a 200.
 *
 *   `filter[search]` matches PARENTS. Searching a room's name brings its seats
 *   along through the include, which covers the ordinary case ("Sylt" → the room
 *   and its three desks). A seat whose own name shares no word with its parent
 *   cannot be found by that name alone; here "Sylt2" written without a space
 *   returns nothing while "Sylt 2" would match. That is anny's filter, not ours,
 *   and it is why the picker also matches locally over what came back.
 *
 * Returned flat, each seat directly after its room and carrying `parentName`, so
 * a caller can indent without holding a tree.
 */
export async function fetchAnnyResources(
  apiToken: string,
  organizationId: string,
  search?: string,
  page = 1,
  perPage = 20
): Promise<{ resources: ResourceRef[]; total: number }> {
  const params: Record<string, string> = {
    "page[number]": String(page),
    "page[size]": String(perPage),
    /* children and archived are load-bearing here; see the note above. */
    "fields[resources]": "name,description,slug,children,archived",
    include: "children",
  };
  if (search) {
    params["filter[search]"] = search;
  }

  const result = await annyFetch("/resources", apiToken, organizationId, params);
  const resources = flattenAnnyResources(
    result.data as AnnyResource[],
    (result.included ?? []) as AnnyResource[]
  );

  return {
    resources,
    /* The page total counts PARENTS, which is what paging is over. Reporting the
     * flattened length instead would make the last page look short. */
    total: (result.meta?.page?.total as number) ?? resources.length,
  };
}

/**
 * Recover a public booking URL for content created before Vellum persisted the
 * slug selected in the resource picker. Anny remains the authority: an ID or
 * room name is never converted into a booking URL; a link exists only when the
 * live resource record explicitly carries a slug.
 */
async function resolveAnnyBookingUrl(
  creds: z.infer<typeof annyCredentialSchema>,
  room: z.infer<typeof annyRoomConfigSchema>
): Promise<string | null> {
  if (room.bookingUrl) return room.bookingUrl;

  const orgId = creds.organizationId || extractOrgFromToken(creds.apiToken) || "";
  if (!orgId) throw new Error("Cannot determine anny organization ID");

  const cacheKey = `${orgId}:${room.resourceId}`;
  const cached = bookingUrlCache.get(cacheKey);
  if (cached !== undefined) return cached;

  /* Resource pages contain parents plus their included child resources. Scan
   * every parent page, so a selected workspace is found as reliably as a room. */
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages) {
    const result = await fetchAnnyResources(creds.apiToken, orgId, undefined, page, ANNY_PAGE_SIZE);
    const resource = result.resources.find((candidate) => candidate.id === room.resourceId);
    if (resource?.bookingUrl) {
      bookingUrlCache.set(cacheKey, resource.bookingUrl);
      return resource.bookingUrl;
    }

    totalPages = Math.max(1, Math.ceil(result.total / ANNY_PAGE_SIZE));
    page++;
  }

  bookingUrlCache.set(cacheKey, null);
  return null;
}

export const annyProvider: CalendarProvider = {
  type: "anny",
  name: "anny.co — Room & Workspace Booking",
  credentialSchema: annyCredentialSchema,
  roomConfigSchema: annyRoomConfigSchema,

  async listResources({ credentials, search, page }) {
    const creds = annyCredentialSchema.parse(credentials);
    const orgId = creds.organizationId || extractOrgFromToken(creds.apiToken) || "";
    if (!orgId) throw new Error("Cannot determine anny organization ID");
    return fetchAnnyResources(creds.apiToken, orgId, search, page ?? 1);
  },

  async getBookingUrl({ credentials, roomConfig }) {
    const creds = annyCredentialSchema.parse(credentials);
    const room = annyRoomConfigSchema.parse(roomConfig);
    return resolveAnnyBookingUrl(creds, room);
  },

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

    const result = await annyFetchAll("/bookings", creds.apiToken, orgId, {
      "filter[resources]": room.resourceId,
      "filter[status]": "accepted",
      include: "customer",
    });

    const bookings = result.data as AnnyBooking[];
    const included = (result.included ?? []) as AnnyIncluded[];

    /* Kept apart rather than joined and re-split later. anny separates the two
     * fields, so a consumer that needs the surname on its own (a name plate sets
     * it several times larger than the given name) gets it exactly instead of
     * from a heuristic. The joined form stays available as `organizer`, because
     * every other consumer wants one string. */
    const customers = new Map<string, { given: string; family: string; full: string }>();
    for (const inc of included) {
      if (inc.type === "customers") {
        const given = ((inc.attributes.given_name as string) ?? "").trim();
        const family = ((inc.attributes.family_name as string) ?? "").trim();
        customers.set(inc.id, { given, family, full: `${given} ${family}`.trim() });
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
      const customer = customerId ? customers.get(customerId) : undefined;

      events.push({
        subject: b.attributes.description || room.resourceName || "Booking",
        organizer: customer?.full || "Booked",
        /* Only when anny actually gave a surname. An empty family_name must not
         * become an empty surname downstream, or the largest rank on the sign
         * would be blank. */
        organizerGiven: customer?.family ? customer.given : undefined,
        organizerSurname: customer?.family || undefined,
        startTime: start,
        endTime: end,
        isPrivate: false,
      });
    }

    log.info("anny: bookings fetched", { resourceId: room.resourceId, count: events.length });
    return events;
  },
};
