// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { validateRequest, okResponse, errorResponse } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { helloLimiter, getClientIp, applyRateLimit } from "@/lib/rate-limit";
import { macSchema } from "@/lib/validation";
import { getRequestPrincipal, hasPermission, withAuditedTransaction } from "@/lib/access";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { env } from "@/lib/env";
import { devices } from "@/db/schema";

const approveSchema = z.object({
  mac: macSchema,
});

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(helloLimiter, getClientIp(request));
  if (rateLimited) return rateLimited;

  const principal = await getRequestPrincipal(request);
  if (!principal || !hasPermission(principal, "devices.approve")) {
    return Response.json(errorResponse("Unauthorized"), { status: 401 });
  }
  if (!hasTrustedMutationOrigin(request, env.VELLUM_PUBLIC_URL, principal.type !== "user")) {
    return Response.json(errorResponse("Invalid origin"), { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(errorResponse("Invalid JSON body"), { status: 400 });
  }

  const validation = validateRequest(approveSchema, body);
  if (!validation.success) return validation.response;

  try {
    const mac = validation.data.mac;
    const token = randomBytes(32).toString("hex");
    await withAuditedTransaction(
      principal,
      { action: "device.approve", targetType: "device", targetId: mac },
      async (tx) => {
        const updated = await tx
          .update(devices)
          .set({ status: "approved", token, approvedAt: new Date() })
          .where(eq(devices.mac, mac))
          .returning({ mac: devices.mac });
        if (updated.length === 0) throw new Error("device_not_found");
      },
      "api-approve-device"
    );
    log.info("Device approved", { mac: validation.data.mac });
    return Response.json(okResponse({ approved: true }));
  } catch (err) {
    log.error("Device approval failed", { mac: validation.data.mac, error: String(err) });
    return Response.json(errorResponse("Internal server error"), { status: 500 });
  }
}
