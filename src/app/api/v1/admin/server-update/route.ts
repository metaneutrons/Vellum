// SPDX-License-Identifier: AGPL-3.0-or-later
import { getRequestPrincipal, hasPermission, writeAudit } from "@/lib/access";
import {
  configureServerUpdates,
  getServerUpdateStatus,
  requestServerUpdate,
  requestServerUpdateCheck,
} from "@/lib/server-updater";
import { checkMutationOrigin } from "@/lib/request-origin";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";
import { z } from "zod";

const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "Invalid IANA timezone");

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("check") }),
  z.object({ action: z.literal("apply") }),
  z.object({
    action: z.literal("configure"),
    mode: z.enum(["manual", "automatic"]),
    maintenanceTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timezone: timezoneSchema,
  }),
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
  if (!principal || !hasPermission(principal, "system.update"))
    return Response.json({ error: "Forbidden" }, { status: 403 });
  const originVerdict = checkMutationOrigin(
    request,
    env.VELLUM_PUBLIC_URL,
    principal.type !== "user"
  );
  if (!originVerdict.ok) {
    /* Logged because the client sees only a 403 and cannot tell it apart from a
     * permission failure. An unset VELLUM_PUBLIC_URL behind a reverse proxy used
     * to produce exactly this with no trace at all. */
    log.warn("Refused mutation on origin", {
      route: "server-update",
      reason: originVerdict.reason,
      expected: originVerdict.expected,
      received: originVerdict.received,
      derivedFromHost: originVerdict.derivedFromHost,
    });
    return Response.json({ error: "Invalid origin" }, { status: 403 });
  }

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid action" }, { status: 400 });
  const body = parsed.data;
  const requestMetadata =
    body.action === "configure"
      ? { mode: body.mode, maintenanceTime: body.maintenanceTime, timezone: body.timezone }
      : {};
  // External updater work cannot share a PostgreSQL transaction. Record intent
  // first so a committed external action is never invisible if the completion
  // audit cannot be written during a later database outage.
  await writeAudit(
    principal,
    `server.update.${body.action}.requested`,
    "server",
    undefined,
    requestMetadata
  );

  let result;
  try {
    result =
      body.action === "apply"
        ? await requestServerUpdate()
        : body.action === "check"
          ? await requestServerUpdateCheck()
          : await configureServerUpdates(body);
  } catch (error) {
    await writeAudit(
      principal,
      `server.update.${body.action}.failed`,
      "server",
      undefined,
      {
        ...requestMetadata,
        error: String(error),
      },
      "failure"
    ).catch((auditError: unknown) =>
      log.error("Failed to record server update failure", { error: String(auditError) })
    );
    throw error;
  }

  await writeAudit(
    principal,
    `server.update.${body.action}.${result.supported ? "accepted" : "rejected"}`,
    "server",
    undefined,
    {
      ...requestMetadata,
      currentVersion: result.currentVersion,
      availableVersion: result.availableVersion,
    },
    result.supported ? "success" : "failure"
  ).catch((error: unknown) =>
    log.error("Failed to record server update completion", { error: String(error) })
  );
  if (!result.supported) return Response.json(result, { status: 503 });
  return Response.json(result, { status: 202, headers: { "cache-control": "no-store" } });
}
