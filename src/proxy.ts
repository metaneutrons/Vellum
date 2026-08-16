// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Edge proxy (Next.js 16; formerly "middleware") — single chokepoint for admin
 * authorization.
 *
 * Previously only `admin/layout.tsx` guarded the React pages; every
 * `/api/v1/admin/*` route handler was reachable unauthenticated. This guards
 * both surfaces centrally:
 *   - /admin/*          → must have a valid signed session cookie, else /login
 *   - /api/v1/admin/*   → valid session cookie OR a valid x-api-key, else 401
 *
 * Individual routes keep their own checks (defence in depth).
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken, safeEqualSecret } from "@/lib/session";

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token)) {
    return NextResponse.next();
  }

  if (isApi) {
    const key = req.headers.get("x-api-key") ?? "";
    const apiKey = process.env.ADMIN_API_KEY ?? "";
    if (key && apiKey && (await safeEqualSecret(key, apiKey))) {
      return NextResponse.next();
    }
    return NextResponse.json(
      { status: "error", data: null, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/admin/:path*", "/api/v1/admin/:path*"],
};
