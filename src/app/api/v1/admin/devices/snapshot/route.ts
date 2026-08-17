// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest } from "next/server";
import { requestHasPermission } from "@/lib/access";
import { getDeviceSnapshots } from "@/lib/device-snapshot";

const MAC_RE = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;
const MAX_BATCH = 100;

export async function GET(request: NextRequest) {
  if (!(await requestHasPermission(request, "devices.read")))
    return Response.json({ error: "Forbidden" }, { status: 403 });

  const requested = request.nextUrl.searchParams.getAll("mac");
  const macs = [...new Set(requested.map((mac) => mac.trim()))];
  if (macs.length > MAX_BATCH || macs.some((mac) => !MAC_RE.test(mac))) {
    return Response.json({ error: "Invalid device selection" }, { status: 400 });
  }

  const devices = await getDeviceSnapshots(macs.length > 0 ? macs : undefined);
  return Response.json({ devices }, { headers: { "Cache-Control": "private, no-store" } });
}
