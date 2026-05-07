// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { getProviderWithCredentials } from "@/lib/providers";
import { extractOrgFromToken } from "@/lib/calendar/providers/anny";
import { UUID_RE } from "@/lib/validation";

/**
 * Resolve resource properties from anny for a given provider + resource.
 * Called at config time (editor save), not at render time.
 */
export async function GET(request: NextRequest) {
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
      const data = await res.json();

      // Build property label map from included
      const propLabels = new Map<string, string>();
      for (const inc of (data.included ?? []) as { id: string; type: string; attributes: { label?: string } }[]) {
        if (inc.type === "properties" && inc.attributes.label) {
          propLabels.set(inc.id, inc.attributes.label);
        }
      }

      // Filter for our resource and resolve values
      for (const rp of (data.data ?? []) as { attributes: { value: unknown }; relationships?: { resource?: { data?: { id: string } }; property?: { data?: { id: string } } } }[]) {
        if (rp.relationships?.resource?.data?.id !== resourceId) continue;
        const propId = rp.relationships?.property?.data?.id;
        const label = propId ? propLabels.get(propId) : undefined;
        if (label && rp.attributes.value != null) {
          props[`prop.${label}`] = String(rp.attributes.value);
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
