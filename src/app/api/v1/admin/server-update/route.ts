// SPDX-License-Identifier: AGPL-3.0-or-later
import { getRequestPrincipal, hasPermission, writeAudit } from "@/lib/access";
import { configureServerUpdates, getServerUpdateStatus, requestServerUpdate, requestServerUpdateCheck } from "@/lib/server-updater";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { env } from "@/lib/env";
import { z } from "zod";

const timezoneSchema = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
}, "Invalid IANA timezone");

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("check") }),
  z.object({ action: z.literal("apply") }),
  z.object({ action: z.literal("configure"), mode: z.enum(["manual", "automatic"]),
    maintenanceTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: timezoneSchema }),
]);

export async function GET(request: Request) {
  const principal = await getRequestPrincipal(request);
  if (!hasPermission(principal, "system.read") && !hasPermission(principal, "system.update")) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  return Response.json(await getServerUpdateStatus(), { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const principal = await getRequestPrincipal(request);
  if (!principal || !hasPermission(principal, "system.update")) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (!hasTrustedMutationOrigin(request, env.VELLUM_PUBLIC_URL, principal.type !== "user")) {
    return Response.json({ error: "Invalid origin" }, { status: 403 });
  }

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid action" }, { status: 400 });
  const body = parsed.data;
  const result = body.action === "apply" ? await requestServerUpdate() : body.action === "check"
    ? await requestServerUpdateCheck() : await configureServerUpdates(body);
  if (!result.supported) return Response.json(result, { status: 503 });
  await writeAudit(principal, `server.update.${body.action}`, "server", undefined, {
    currentVersion: result.currentVersion, availableVersion: result.availableVersion,
    ...(body.action === "configure" ? { mode: body.mode, maintenanceTime: body.maintenanceTime, timezone: body.timezone } : {}),
  });
  return Response.json(result, { status: 202, headers: { "cache-control": "no-store" } });
}
