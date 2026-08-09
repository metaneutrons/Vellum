// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { acceptInvitation, createUserSession } from "@/lib/access";
import { SESSION_COOKIE } from "@/lib/session";

export async function acceptInvitationAction(token: string, _previous: { error?: string } | null, formData: FormData) {
  const password = String(formData.get("password") ?? "");
  try {
    const user = await acceptInvitation(token, password);
    if (!user) return { error: "invalid" };
    const cookieStore = await cookies();
    const session = await createUserSession(user.id);
    cookieStore.set(SESSION_COOKIE, session, { httpOnly: true, secure: env.NODE_ENV === "production", sameSite: "lax", maxAge: 8 * 60 * 60, path: "/" });
  } catch {
    return { error: "invalid" };
  }
  redirect("/admin");
}
