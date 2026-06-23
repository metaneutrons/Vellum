// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { constantTimeEqual } from "@/lib/constant-time";
import { createSessionToken, SESSION_COOKIE } from "@/lib/session";
import { loginLimiter, getClientIp } from "@/lib/rate-limit";
import { log } from "@/lib/logger";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export async function loginAction(_prev: unknown, formData: FormData) {
  // Rate-limit by client IP to blunt brute-force attempts.
  const ip = getClientIp(new Request("http://local", { headers: await headers() }));
  if (!loginLimiter.check(ip).allowed) {
    log.warn("Login rate limited", { ip });
    return { error: "Too many attempts. Try again later." };
  }

  const user = formData.get("user") as string;
  const pass = formData.get("pass") as string;

  if (!user || !pass || user !== env.ADMIN_USER || !constantTimeEqual(env.ADMIN_PASS, pass)) {
    log.warn("Failed admin login", { ip });
    return { error: "Invalid credentials" };
  }

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, await createSessionToken(SESSION_TTL_MS), {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_MS / 1000,
    path: "/",
  });

  redirect("/admin");
}
