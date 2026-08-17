// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db, withDbRead, withDbWrite } from "@/db";
import { deviceConfigurationCommands } from "@/db/schema";
import { validateToken } from "@/lib/auth";
import { validateRequest, okResponse, errorResponse } from "@/lib/api-response";
import { configurationReportSchema } from "@/lib/validation";
import { apiLimiter, getClientIp, applyRateLimit } from "@/lib/rate-limit";
import { log } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(apiLimiter, getClientIp(request));
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(errorResponse("Invalid JSON body"), { status: 400 });
  }
  const validation = validateRequest(configurationReportSchema, body);
  if (!validation.success) return validation.response;

  const token = request.headers.get("x-device-token") ?? "";
  if (!(await validateToken(validation.data.mac, token))) {
    return Response.json(errorResponse("Unauthorized"), { status: 401 });
  }

  try {
    const isClaim = validation.data.status === "applying";
    const rows = await withDbWrite(
      () =>
        db
          .update(deviceConfigurationCommands)
          .set({
            status: validation.data.status,
            errorCode: validation.data.errorCode ?? null,
            completedAt: isClaim ? null : new Date(),
          })
          .where(
            and(
              eq(deviceConfigurationCommands.id, validation.data.id),
              eq(deviceConfigurationCommands.mac, validation.data.mac),
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
                eq(deviceConfigurationCommands.id, validation.data.id),
                eq(deviceConfigurationCommands.mac, validation.data.mac)
              )
            )
            .limit(1),
        "read-completed-device-configuration-command"
      );
      if (existing[0]?.status !== validation.data.status) {
        return Response.json(errorResponse("Configuration command not active"), { status: 409 });
      }
    }
    return Response.json(okResponse({}));
  } catch (error) {
    log.error("Configuration outcome report failed", {
      mac: validation.data.mac,
      commandId: validation.data.id,
      error: String(error),
    });
    return Response.json(errorResponse("Internal server error"), { status: 500 });
  }
}
