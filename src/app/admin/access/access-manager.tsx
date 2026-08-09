// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useTransition } from "react";
import { KeyRound, ShieldCheck, UserPlus, Users } from "lucide-react";
import { changeUserRole, createAutomationAccount, inviteUser, revokeAutomationAccount, suspendUser, updateOidcProvisioningPolicy } from "./actions";
import { PERMISSIONS, type Permission } from "@/lib/access/permissions";

type Directory = Awaited<ReturnType<typeof import("./actions").getAccessDirectory>>;
type Labels = Record<"title" | "description" | "people" | "serviceAccounts" | "audit" | "invite" | "name" | "email" | "role" | "status" | "lastLogin" | "createAccount" | "permissions" | "copyToken" | "revoke" | "suspend" | "active" | "suspended" | "never" | "created" | "inviteCreated" | "accountCreated" | "oidc" | "autoProvision" | "defaultRole" | "savePolicy", string>;

function date(value: Date | null, never: string) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : never;
}

export function AccessManager({ directory, labels }: { directory: Directory; labels: Labels }) {
  const [pending, startTransition] = useTransition();
  const [token, setToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const assignments = new Map(directory.assignments.map((assignment) => [assignment.userId, assignment]));

  function run(action: () => Promise<void>) {
    startTransition(async () => {
      try { await action(); setNotice(null); } catch (error) { setNotice(error instanceof Error ? error.message : "Request failed"); }
    });
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <header className="flex items-start gap-4">
        <div className="size-11 shrink-0 rounded-xl bg-accent-soft text-accent grid place-items-center"><ShieldCheck size={22} /></div>
        <div><h1 className="text-2xl font-semibold tracking-tight">{labels.title}</h1><p className="mt-1 text-label-secondary">{labels.description}</p></div>
      </header>
      {notice && <p role="alert" className="rounded-lg border border-red/30 bg-red/10 px-4 py-3 text-sm text-red">{notice}</p>}
      {token && <div className="rounded-xl border border-accent/30 bg-accent-soft p-4"><p className="font-medium">{labels.copyToken}</p><code className="mt-2 block break-all select-all rounded-md bg-surface px-3 py-2 text-sm">{token}</code></div>}

      <section className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="rounded-xl border border-separator bg-surface overflow-hidden">
          <div className="flex items-center gap-2 border-b border-separator px-5 py-4"><Users size={18} /><h2 className="font-semibold">{labels.people}</h2></div>
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-fill-tertiary text-label-secondary"><tr><th className="px-5 py-3 font-medium">{labels.name}</th><th className="px-5 py-3 font-medium">{labels.role}</th><th className="px-5 py-3 font-medium">{labels.status}</th><th className="px-5 py-3 font-medium">{labels.lastLogin}</th><th className="px-5 py-3" /></tr></thead><tbody>{directory.users.map((user) => {
            const assignment = assignments.get(user.id);
            return <tr key={user.id} className="border-t border-separator"><td className="px-5 py-3"><div className="font-medium">{user.displayName}</div><div className="text-label-tertiary">{user.email}</div></td><td className="px-5 py-3"><select disabled={pending || user.status !== "active"} value={assignment?.roleId ?? "viewer"} onChange={(event) => run(() => changeUserRole(user.id, event.target.value))} className="rounded-md border border-separator bg-surface px-2 py-1.5 focus-ring">{directory.roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></td><td className="px-5 py-3"><span className={user.status === "active" ? "text-green" : "text-red"}>{user.status === "active" ? labels.active : labels.suspended}</span></td><td className="px-5 py-3 text-label-secondary">{date(user.lastLoginAt, labels.never)}</td><td className="px-5 py-3 text-right">{user.status === "active" && <button disabled={pending} onClick={() => run(() => suspendUser(user.id))} className="text-sm text-red hover:underline focus-ring rounded">{labels.suspend}</button>}</td></tr>;
          })}</tbody></table></div>
        </div>
        <form action={(form) => run(async () => { const result = await inviteUser({ email: String(form.get("email")), displayName: String(form.get("name")), roleId: String(form.get("role")) }); setToken(`${window.location.origin}/invite/${result}`); setNotice(labels.inviteCreated); })} className="rounded-xl border border-separator bg-surface p-5 space-y-3"><div className="flex items-center gap-2"><UserPlus size={18} /><h2 className="font-semibold">{labels.invite}</h2></div><input required name="name" placeholder={labels.name} className="w-full rounded-md border border-separator bg-surface px-3 py-2 focus-ring"/><input required type="email" name="email" placeholder={labels.email} className="w-full rounded-md border border-separator bg-surface px-3 py-2 focus-ring"/><select name="role" className="w-full rounded-md border border-separator bg-surface px-3 py-2 focus-ring">{directory.roles.filter((role) => role.id !== "owner").map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select><button disabled={pending} className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white focus-ring disabled:opacity-50">{labels.invite}</button></form>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-separator bg-surface overflow-hidden"><div className="flex items-center gap-2 border-b border-separator px-5 py-4"><KeyRound size={18} /><h2 className="font-semibold">{labels.serviceAccounts}</h2></div><div className="divide-y divide-separator">{directory.accounts.map((account) => <div key={account.id} className="flex items-center justify-between px-5 py-3"><div><div className="font-medium">{account.name}</div><div className="text-xs text-label-tertiary">{account.tokenPrefix}… · {date(account.lastUsedAt, labels.never)}</div></div>{account.status === "active" && <button disabled={pending} onClick={() => run(() => revokeAutomationAccount(account.id))} className="text-sm text-red hover:underline focus-ring rounded">{labels.revoke}</button>}</div>)}</div><form action={(form) => run(async () => { const permissions = form.getAll("permission").filter((value): value is Permission => typeof value === "string" && PERMISSIONS.includes(value as Permission)); const result = await createAutomationAccount(String(form.get("name")), permissions); setToken(result.token); setNotice(labels.accountCreated); })} className="border-t border-separator p-4"><div className="flex gap-2"><input required name="name" placeholder={labels.name} className="min-w-0 flex-1 rounded-md border border-separator bg-surface px-3 py-2 focus-ring"/><button disabled={pending} className="rounded-md bg-fill-tertiary px-3 text-sm font-medium focus-ring">{labels.createAccount}</button></div><fieldset className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2"><legend className="sr-only">{labels.permissions}</legend>{PERMISSIONS.map((permission) => <label key={permission} className="flex items-center gap-2 text-xs text-label-secondary"><input name="permission" type="checkbox" value={permission} defaultChecked={permission === "devices.approve"} />{permission}</label>)}</fieldset></form></div>
        <div className="rounded-xl border border-separator bg-surface overflow-hidden"><div className="flex items-center gap-2 border-b border-separator px-5 py-4"><ShieldCheck size={18} /><h2 className="font-semibold">{labels.audit}</h2></div><ol className="divide-y divide-separator">{directory.events.map((event) => <li key={event.id} className="px-5 py-3 text-sm"><div className="font-medium">{event.action}</div><div className="mt-0.5 text-label-tertiary">{event.actorType} · {event.targetType} · {date(event.createdAt, labels.never)}</div></li>)}</ol></div>
      </section>
      <section className="rounded-xl border border-separator bg-surface p-5"><h2 className="font-semibold">{labels.oidc}</h2><form action={(form) => run(async () => { await updateOidcProvisioningPolicy(form.get("autoProvision") === "on", String(form.get("defaultRole"))); setNotice(null); })} className="mt-4 flex flex-wrap items-center gap-4"><label className="flex items-center gap-2 text-sm"><input name="autoProvision" type="checkbox" defaultChecked={directory.policy["access.oidcAutoProvision"] === true} />{labels.autoProvision}</label><label className="flex items-center gap-2 text-sm">{labels.defaultRole}<select name="defaultRole" defaultValue={String(directory.policy["access.oidcDefaultRole"] ?? "viewer")} className="rounded-md border border-separator bg-surface px-2 py-1.5 focus-ring">{directory.roles.filter((role) => role.id !== "owner").map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label><button disabled={pending} className="rounded-md bg-fill-tertiary px-3 py-2 text-sm font-medium focus-ring">{labels.savePolicy}</button></form></section>
      <p className="text-xs text-label-tertiary">{PERMISSIONS.length} {labels.permissions.toLocaleLowerCase()}</p>
    </div>
  );
}
