// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { checkDbHealth } from "@/db";
import { log } from "@/lib/logger";

export async function GET() {
  try {
    await checkDbHealth();
    return Response.json({ status: "ok", db: "connected" });
  } catch (err) {
    log.error("Health check failed", { error: String(err) });
    return Response.json({ status: "error", db: "disconnected" }, { status: 503 });
  }
}
