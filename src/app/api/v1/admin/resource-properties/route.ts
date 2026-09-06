// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { z } from "zod";
import { getProviderWithCredentials } from "@/lib/providers";
import { extractOrgFromToken } from "@/lib/calendar/providers/anny";
import { UUID_RE } from "@/lib/validation";
import { requestHasPermission } from "@/lib/access";

/**
 * Resolve resource properties from anny for a given provider + resource.
 * Called at config time (editor save), not at render time.
 */
/* The shape this route needs out of anny. `.catch` keeps one malformed page from
 * failing the whole property lookup — the admin UI then shows fewer options
 * rather than an error. */
const annyEnvelope = z
  .object({
    data: z.array(z.unknown()).default([]),
    included: z.array(z.unknown()).default([]),
    meta: z
      .object({ page: z.object({ "last-page": z.number().optional() }).optional() })
      .optional(),
  })
  .catch({ data: [], included: [] });

export async function GET(request: NextRequest) {
  /* content.manage, not providers.manage_secrets: resolving a room's properties is
   * a content task, and the old gate is held by no role but owner and
   * administrator — so the content manager whose job this is got a 403. Same
   * correction as on /provider-resources. */
  if (!(await requestHasPermission(request, "content.manage")))
    return Response.json({ error: "Forbidden" }, { status: 403 });
  const providerId = request.nextUrl.searchParams.get("providerId");
  const resourceId = request.nextUrl.searchParams.get("resourceId");

  if (!providerId || !UUID_RE.test(providerId)) {
    return Response.json({ error: "Invalid or missing providerId" }, { status: 400 });
  }
  if (!resourceId) {
    return Response.json({ error: "Missing resourceId" }, { status: 400 });
  }

  const provider = await getProviderWithCredentials(providerId);
  if (provider.type !== "anny") return Response.json({}); // Only anny has resource properties

  const creds = provider.credentials as { apiToken: string; organizationId?: string };
  const orgId = creds.organizationId || extractOrgFromToken(creds.apiToken) || "";
  if (!orgId) return Response.json({ error: "Cannot determine org ID" }, { status: 400 });

  const url = new URL("https://b.anny.co/api/v1/resource-properties");
  url.searchParams.set("o", orgId);
  url.searchParams.set("include", "property,resource");
  url.searchParams.set("page[size]", "200");

  // Paginate until we find properties for our resource (API doesn't support filtering by resource)
  const props: Record<string, string> = {};
  let page = 1;
  const MAX_PAGES = 10;

  try {
    while (page <= MAX_PAGES) {
      url.searchParams.set("page[number]", String(page));
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${creds.apiToken}`, Accept: "application/vnd.api+json" },
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) break;
      /* anny's JSON:API envelope. Only what this route reads is described; the
       * entries keep their own casts below, which the loop already had. */
      const data = annyEnvelope.parse(await res.json());

      // Build property label map from included
      const propLabels = new Map<string, string>();
      for (const inc of data.included as {
        id: string;
        type: string;
        attributes: { label?: string };
      }[]) {
        if (inc.type === "properties" && inc.attributes.label) {
          propLabels.set(inc.id, inc.attributes.label);
        }
      }

      // Filter for our resource and resolve values
      for (const rp of data.data as {
        attributes: { value: unknown };
        relationships?: {
          resource?: { data?: { id: string } };
          property?: { data?: { id: string } };
        };
      }[]) {
        if (rp.relationships?.resource?.data?.id !== resourceId) continue;
        /* The check above already skipped an entry without relationships. */
        const propId = rp.relationships.property?.data?.id;
        const label = propId ? propLabels.get(propId) : undefined;
        if (label && rp.attributes.value != null) {
          /* The value comes from the provider's JSON, so its type is a claim rather
           * than a guarantee. An object would reach the panel as "[object Object]";
           * JSON at least stays readable to whoever has to debug it. */
          const raw: unknown = rp.attributes.value;
          props[`prop.${label}`] =
            typeof raw === "string"
              ? raw
              : typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint"
                ? String(raw)
                : JSON.stringify(raw);
        }
      }

      // Stop if we found properties or reached last page
      if (Object.keys(props).length > 0) break;
      const lastPage = data.meta?.page?.["last-page"] ?? 1;
      if (page >= lastPage) break;
      page++;
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TimeoutError") {
      return Response.json({ error: "Upstream API timeout" }, { status: 504 });
    }
    return Response.json({ error: "Failed to fetch resource properties" }, { status: 502 });
  }

  return Response.json(props);
}
