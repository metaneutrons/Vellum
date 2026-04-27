// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dataProviders } from "@/db/schema";
import { decryptCredentials } from "@/lib/encryption";
import { fetchAnnyOrganizations } from "@/lib/calendar/providers/anny";

/**
 * Fetch anny organizations available to the provider's API token.
 * Query params: providerId
 */
export async function GET(request: NextRequest) {
  const providerId = request.nextUrl.searchParams.get("providerId");
  if (!providerId) return Response.json({ error: "Missing providerId" }, { status: 400 });

  const [provider] = await db.select().from(dataProviders).where(eq(dataProviders.id, providerId)).limit(1);
  if (!provider || provider.type !== "anny") {
    return Response.json({ error: "Provider not found or not anny type" }, { status: 404 });
  }

  try {
    const credentials = decryptCredentials(provider.encryptedCredentials) as { apiToken: string };
    const orgs = await fetchAnnyOrganizations(credentials.apiToken);
    return Response.json({ organizations: orgs });
  } catch (err) {
    return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 502 });
  }
}
