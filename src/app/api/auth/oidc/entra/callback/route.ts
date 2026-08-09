// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { SESSION_COOKIE } from "@/lib/session";
import { log } from "@/lib/logger";
import { completeEntraLogin, entraRedirectUri, isEntraConfigured, oidcTransactionCookieOptions, resolveEntraUser, TX_COOKIE } from "@/lib/access/entra-oidc";
import { createUserSession } from "@/lib/access";

export async function GET(request: NextRequest) {
  if (!isEntraConfigured()) return new NextResponse("Microsoft Entra login is not configured", { status: 503 });
  // Traefik may forward the backend bind host (for example 0.0.0.0:3000).
  // The authorization code is bound to the public redirect URI, so retain
  // only the query parameters from the request and use that canonical URI.
  const callbackUrl = new URL(entraRedirectUri());
  callbackUrl.search = request.nextUrl.search;
  const appOrigin = new URL(entraRedirectUri()).origin;
  try {
    const identity = await completeEntraLogin(callbackUrl, request.cookies.get(TX_COOKIE)?.value);
    const user = identity ? await resolveEntraUser(identity) : null;
    const response = NextResponse.redirect(new URL(user ? "/admin" : "/login?error=oidc_denied", appOrigin));
    response.cookies.set(TX_COOKIE, "", { ...oidcTransactionCookieOptions(), maxAge: 0 });
    if (user) response.cookies.set(SESSION_COOKIE, await createUserSession(user.id, { ip: request.headers.get("x-forwarded-for") ?? undefined, userAgent: request.headers.get("user-agent") ?? undefined }), { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax", maxAge: 8 * 60 * 60, path: "/" });
    return response;
  } catch (error) {
    // Do not log error text: OAuth providers can include response details in it.
    log.warn("Entra OIDC sign-in failed", { errorType: error instanceof Error ? error.name : "unknown" });
    return NextResponse.redirect(new URL("/login?error=oidc_failed", appOrigin));
  }
}
