// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { getProviderWithCredentials } from "@/lib/providers";
import { getCalendarProvider } from "@/lib/calendar/registry";
import { UUID_RE } from "@/lib/validation";
import { requestHasPermission } from "@/lib/access";

/**
 * List a provider's resources for the picker, whatever kind of provider it is.
 *
 * Replaces `/anny-resources`, which answered 404 for every other provider type
 * and so left three editors asking the operator to paste an identifier. The
 * capability now lives on `CalendarProvider.listResources`, so adding a provider
 * that can enumerate needs no change here.
 *
 * `supported: false` is a normal answer, not an error: an iCal feed's URL *is*
 * its resource, so there is nothing to enumerate. The client shows a plain field
 * for the identifier instead of an empty search box.
 *
 * Gated on `content.manage`, NOT `providers.manage_secrets`. Choosing a room is a
 * content task; the old gate is held by no role except owner and administrator,
 * so the content manager — whose job this is — got a 403 from the picker.
 * Credentials are used here but never returned.
 */
export async function GET(request: NextRequest) {
  if (!(await requestHasPermission(request, "content.manage"))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const providerId = request.nextUrl.searchParams.get("providerId");
  if (!providerId || !UUID_RE.test(providerId)) {
    return Response.json({ error: "Invalid or missing providerId" }, { status: 400 });
  }

  const search = request.nextUrl.searchParams.get("search") ?? undefined;
  const pageRaw = Number.parseInt(request.nextUrl.searchParams.get("page") ?? "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;

  let provider: Awaited<ReturnType<typeof getProviderWithCredentials>>;
  try {
    provider = await getProviderWithCredentials(providerId);
  } catch {
    return Response.json({ error: "Provider not found" }, { status: 404 });
  }

  const impl = getCalendarProvider(provider.type);
  if (!impl) {
    return Response.json({ error: "Unknown provider type" }, { status: 404 });
  }
  if (!impl.listResources) {
    return Response.json({ supported: false, resources: [] });
  }

  try {
    const { resources, total } = await impl.listResources({
      credentials: provider.credentials,
      search,
      page,
    });
    return Response.json({ supported: true, resources, total });
  } catch (err) {
    /* The message can name a misconfigured token or an unreachable host, which is
     * exactly what the operator needs to see; it carries no credential itself. */
    return Response.json(
      { error: String(err instanceof Error ? err.message : err) },
      { status: 502 }
    );
  }
}
