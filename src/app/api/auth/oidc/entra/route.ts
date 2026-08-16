// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { NextResponse } from "next/server";
import {
  beginEntraLogin,
  isEntraConfigured,
  oidcTransactionCookieOptions,
  TX_COOKIE,
} from "@/lib/access/entra-oidc";

export async function GET() {
  if (!isEntraConfigured())
    return new NextResponse("Microsoft Entra login is not configured", { status: 503 });
  const { url, transaction } = await beginEntraLogin();
  const response = NextResponse.redirect(url);
  response.cookies.set(TX_COOKIE, transaction, oidcTransactionCookieOptions());
  return response;
}
