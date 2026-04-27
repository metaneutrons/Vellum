// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { constantTimeEqual } from "@/lib/constant-time";

export async function loginAction(_prev: unknown, formData: FormData) {
  const user = formData.get("user") as string;
  const pass = formData.get("pass") as string;

  if (!user || !pass || user !== env.ADMIN_USER || !constantTimeEqual(env.ADMIN_PASS, pass)) {
    return { error: "Invalid credentials" };
  }

  const cookieStore = await cookies();
  cookieStore.set("admin_session", "authenticated", {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 8, // 8 hours
    path: "/",
  });

  redirect("/admin");
}
