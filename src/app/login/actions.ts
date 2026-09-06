// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { SESSION_COOKIE } from "@/lib/session";
import { loginLimiter, getClientIp } from "@/lib/rate-limit";
import { log } from "@/lib/logger";
import { authenticateLocalUser, createUserSession } from "@/lib/access";
import { formString, formTrimmed } from "@/lib/form-data";

export async function loginAction(_prev: unknown, formData: FormData) {
  // Rate-limit by client IP to blunt brute-force attempts.
  const ip = getClientIp(new Request("http://local", { headers: await headers() }));
  if (!loginLimiter.check(ip).allowed) {
    log.warn("Login rate limited", { ip });
    return { error: "Too many attempts. Try again later." };
  }

  const identity = formTrimmed(formData, "user");
  const pass = formString(formData, "pass");

  const principal = identity && pass ? await authenticateLocalUser(identity, pass) : null;
  if (!principal) {
    log.warn("Failed admin login", { ip });
    return { error: "Invalid credentials" };
  }

  const cookieStore = await cookies();
  const token = await createUserSession(principal.id, {
    ip,
    userAgent: (await headers()).get("user-agent") ?? undefined,
  });
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 8 * 60 * 60,
    path: "/",
  });

  redirect("/admin");
}
