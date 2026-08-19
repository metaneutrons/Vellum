// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import type { NextRequest } from "next/server";
import type { z } from "zod";
import { validateRequest, errorResponse } from "./api-response";
import { validateToken } from "./auth";
import { apiLimiter, getClientIp, applyRateLimit } from "./rate-limit";

/**
 * The preamble every device-facing POST endpoint shares.
 *
 * `report`, `ota-report`, `config-report` and `logs` each opened with the same
 * eighteen lines, differing only in the schema. Four copies of an authentication
 * sequence is three too many: the order carries the security property, and a copy
 * that drifts is how a route ends up checking a token against a MAC nobody
 * validated.
 *
 * That order, deliberately:
 *
 *  1. rate limit by client address, before any parsing work is done,
 *  2. parse the body, since a malformed one cannot identify a device,
 *  3. validate against the schema, which is what normalises the MAC,
 *  4. only then verify the token against the MAC the *validated* body claims.
 *
 * Returns the parsed body, or the response to send back verbatim.
 */
export async function readDeviceRequest<T extends { mac: string }>(
  request: NextRequest,
  schema: z.ZodType<T>
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  const rateLimited = applyRateLimit(apiLimiter, getClientIp(request));
  if (rateLimited) return { ok: false, response: rateLimited };

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      ok: false,
      response: Response.json(errorResponse("Invalid JSON body"), { status: 400 }),
    };
  }

  const validation = validateRequest(schema, body);
  if (!validation.success) return { ok: false, response: validation.response };

  const token = request.headers.get("x-device-token") ?? "";
  if (!(await validateToken(validation.data.mac, token))) {
    return {
      ok: false,
      response: Response.json(errorResponse("Unauthorized"), { status: 401 }),
    };
  }

  return { ok: true, data: validation.data };
}
