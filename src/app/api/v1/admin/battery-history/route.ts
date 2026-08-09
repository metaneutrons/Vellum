// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { db, withDb } from "@/db";
import { telemetry } from "@/db/schema";
import { eq, and, gte } from "drizzle-orm";
import { requestHasPermission } from "@/lib/access";

export async function GET(request: NextRequest) {
  if (!(await requestHasPermission(request, "devices.read"))) return Response.json({ error: "Forbidden" }, { status: 403 });
  const mac = request.nextUrl.searchParams.get("mac");
  const days = parseInt(request.nextUrl.searchParams.get("days") ?? "30") || 30;

  if (!mac) return Response.json({ error: "Missing mac" }, { status: 400 });

  const since = new Date(Date.now() - days * 86400_000);

  const rows = await withDb(() => db.select({
    voltage: telemetry.batteryVoltage,
    level: telemetry.batteryLevel,
    timestamp: telemetry.timestamp,
  })
    .from(telemetry)
    .where(and(eq(telemetry.mac, mac), gte(telemetry.timestamp, since)))
    .orderBy(telemetry.timestamp)
    .limit(1000), "get-battery-history");

  return Response.json(rows);
}
