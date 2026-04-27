// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import type { ApiResponse } from "./types";
import type { z } from "zod";

export function okResponse<T>(data: T): ApiResponse<T> {
  return { status: "ok", data, error: null };
}

export function errorResponse(message: string): ApiResponse<null> {
  return { status: "error", data: null, error: message };
}

/**
 * Validates request data against a Zod schema.
 * Returns { success: true, data } on valid input,
 * or { success: false, response } with a 400 JSON Response on failure.
 */
export function validateRequest<T>(
  schema: z.ZodType<T>,
  data: unknown
):
  | { success: true; data: T }
  | { success: false; response: Response } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }

  const message = result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");

  return {
    success: false,
    response: Response.json(errorResponse(message), { status: 400 }),
  };
}
