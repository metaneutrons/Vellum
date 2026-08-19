// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { readDeviceRequest } from "@/lib/device-request";
import { and, eq, inArray } from "drizzle-orm";
import { db, withDbRead, withDbWrite } from "@/db";
import { deviceConfigurationCommands } from "@/db/schema";
import { okResponse, errorResponse } from "@/lib/api-response";
import { configurationReportSchema } from "@/lib/validation";
import { log } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const parsed = await readDeviceRequest(request, configurationReportSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const isClaim = parsed.data.status === "applying";
    const rows = await withDbWrite(
      () =>
        db
          .update(deviceConfigurationCommands)
          .set({
            status: parsed.data.status,
            errorCode: parsed.data.errorCode ?? null,
            completedAt: isClaim ? null : new Date(),
          })
          .where(
            and(
              eq(deviceConfigurationCommands.id, parsed.data.id),
              eq(deviceConfigurationCommands.mac, parsed.data.mac),
              inArray(
                deviceConfigurationCommands.status,
                isClaim ? ["pending", "delivered"] : ["applying"]
              )
            )
          )
          .returning({ id: deviceConfigurationCommands.id }),
      "complete-device-configuration-command"
    );
    // Idempotent retries after a lost response are successful if the command
    // already reached the same terminal state.
    if (rows.length === 0) {
      const existing = await withDbRead(
        () =>
          db
            .select({ status: deviceConfigurationCommands.status })
            .from(deviceConfigurationCommands)
            .where(
              and(
                eq(deviceConfigurationCommands.id, parsed.data.id),
                eq(deviceConfigurationCommands.mac, parsed.data.mac)
              )
            )
            .limit(1),
        "read-completed-device-configuration-command"
      );
      if (existing[0]?.status !== parsed.data.status) {
        return Response.json(errorResponse("Configuration command not active"), { status: 409 });
      }
    }
    return Response.json(okResponse({}));
  } catch (error) {
    log.error("Configuration outcome report failed", {
      mac: parsed.data.mac,
      commandId: parsed.data.id,
      error: String(error),
    });
    return Response.json(errorResponse("Internal server error"), { status: 500 });
  }
}
