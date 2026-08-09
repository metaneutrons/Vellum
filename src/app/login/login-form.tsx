// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";
import { useActionState } from "react";
import { loginAction } from "./actions";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/field";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { AppFooter } from "@/components/app-footer";
import { useTranslations } from "next-intl";

export function LoginForm({ entraEnabled }: { entraEnabled: boolean }) {
  const t = useTranslations("login");
  const [state, formAction, pending] = useActionState(loginAction, null);
  return <div className="relative min-h-screen flex items-center justify-center bg-bg-secondary px-4"><div className="absolute top-4 right-4"><ThemeToggle /></div><div className="w-full max-w-[400px]"><div className="flex flex-col items-center gap-3 mb-8"><img src="/vellum-logo.svg" alt="Vellum" width={160} height={160} className="dark:invert" /><p className="text-[15px] text-label-secondary">{t("subtitle")}</p></div><form action={formAction} className="bg-surface rounded-2xl shadow-e2 border border-separator/60 p-7 flex flex-col gap-4">{state?.error && <div role="alert" className="rounded-md bg-red/10 px-3.5 py-2.5 text-sm text-red text-center">{state.error}</div>}<Field label={t("username")} htmlFor="user"><Input id="user" name="user" type="text" required autoFocus autoComplete="username" /></Field><Field label={t("password")} htmlFor="pass"><Input id="pass" name="pass" type="password" required autoComplete="current-password" /></Field><Button type="submit" loading={pending} size="lg" className="w-full mt-1">{pending ? t("signingIn") : t("submit")}</Button>{entraEnabled && <><div className="relative text-center text-xs text-label-tertiary before:absolute before:inset-x-0 before:top-1/2 before:border-t before:border-separator"><span className="relative bg-surface px-2">{t("or")}</span></div><a href="/api/auth/oidc/entra" className="w-full rounded-md border border-separator px-3 py-2.5 text-center text-sm font-medium text-label hover:bg-fill-tertiary focus-ring">{t("signInWithMicrosoft")}</a></>}</form><AppFooter className="mt-8 text-label-tertiary" /></div></div>;
}
