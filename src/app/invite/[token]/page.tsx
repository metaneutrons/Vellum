// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { getTranslations } from "next-intl/server";
import { InviteForm } from "./invite-form";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const access = await getTranslations("access");
  const login = await getTranslations("login");
  return <main className="min-h-dvh bg-bg-secondary px-4 py-16"><div className="mx-auto max-w-md"><img src="/vellum-logo.svg" alt="Vellum" width={136} height={136} className="dark:invert" /><h1 className="mt-6 text-2xl font-semibold">{access("acceptInvite")}</h1><InviteForm token={token} labels={{ accept: access("acceptInvite"), hint: access("acceptInviteHint"), password: login("password"), submit: access("acceptInvite"), invalid: access("invalidInvite") }} /></div></main>;
}
