// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { createHash } from "node:crypto";

export type RenderRepresentation = "idle" | "frame";

/**
 * Strong, compact HTTP entity tag for a visible device state. The type prefix
 * prevents an idle state from ever colliding semantically with bitmap content;
 * quoting follows RFC entity-tag syntax and still fits the firmware's 32-byte
 * header field including its trailing NUL.
 */
export function renderEntityTag(kind: RenderRepresentation, payload: string | Uint8Array): string {
  const prefix = kind === "idle" ? "i" : "f";
  const digest = createHash("sha256").update(payload).digest("hex").slice(0, 16);
  return `"${prefix}-${digest}"`;
}
