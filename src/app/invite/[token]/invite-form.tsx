// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";
import { useActionState } from "react";
import { acceptInvitationAction } from "./actions";

export function InviteForm({ token, labels }: { token: string; labels: { accept: string; hint: string; password: string; submit: string; invalid: string } }) {
  const [state, action, pending] = useActionState(acceptInvitationAction.bind(null, token), null);
  return <form action={action} className="mt-6 flex flex-col gap-4 rounded-2xl border border-separator bg-surface p-7 shadow-e2">
    <p className="text-sm text-label-secondary">{labels.hint}</p>
    {state?.error && <p role="alert" className="rounded-md bg-red/10 px-3 py-2 text-sm text-red">{labels.invalid}</p>}
    <label className="text-sm font-medium">{labels.password}<input required minLength={12} autoComplete="new-password" name="password" type="password" className="mt-1.5 w-full rounded-md border border-separator bg-surface px-3 py-2 focus-ring" /></label>
    <button disabled={pending} className="rounded-md bg-accent px-3 py-2.5 font-medium text-white focus-ring disabled:opacity-50">{labels.submit}</button>
  </form>;
}
