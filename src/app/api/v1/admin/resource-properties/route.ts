// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dataProviders } from "@/db/schema";
import { decryptCredentials } from "@/lib/encryption";
import { extractOrgFromToken } from "@/lib/calendar/providers/anny";

/**
 * Resolve resource properties from anny for a given provider + resource.
 * Called at config time (editor save), not at render time.
 * Returns { [label]: value } map.
 */
export async function GET(request: NextRequest) {
  const providerId = request.nextUrl.searchParams.get("providerId");
  const resourceId = request.nextUrl.searchParams.get("resourceId");
  if (!providerId || !resourceId) {
    return Response.json({ error: "Missing providerId or resourceId" }, { status: 400 });
  }

  const [provider] = await db.select().from(dataProviders)
    .where(eq(dataProviders.id, providerId)).limit(1);
  if (!provider) return Response.json({ error: "Provider not found" }, { status: 404 });
  if (provider.type !== "anny") return Response.json({}); // Only anny has resource properties

  const creds = decryptCredentials(provider.encryptedCredentials) as { apiToken: string; organizationId?: string };
  const orgId = creds.organizationId || extractOrgFromToken(creds.apiToken) || "";
  if (!orgId) return Response.json({ error: "Cannot determine org ID" }, { status: 400 });

  const ANNY_BASE = "https://b.anny.co/api/v1";
  const url = new URL(`${ANNY_BASE}/resource-properties`);
  url.searchParams.set("o", orgId);
  url.searchParams.set("include", "property");
  url.searchParams.set("page[size]", "200");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${creds.apiToken}`, Accept: "application/vnd.api+json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) return Response.json({ error: `anny API ${res.status}` }, { status: 502 });
  const data = await res.json();

  // Build property label map
  const propLabels = new Map<string, string>();
  for (const inc of (data.included ?? []) as { id: string; type: string; attributes: { label?: string } }[]) {
    if (inc.type === "properties" && inc.attributes.label) {
      propLabels.set(inc.id, inc.attributes.label);
    }
  }

  // Resolve values
  const props: Record<string, string> = {};
  for (const rp of (data.data ?? []) as { attributes: { value: unknown }; relationships?: { property?: { data?: { id: string } } } }[]) {
    const propId = rp.relationships?.property?.data?.id;
    const label = propId ? propLabels.get(propId) : undefined;
    if (label && rp.attributes.value != null) {
      const key = `prop.${label}`;
      props[key] = String(rp.attributes.value);
    }
  }

  return Response.json(props);
}
