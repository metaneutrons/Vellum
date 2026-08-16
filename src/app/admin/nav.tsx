// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import {
  LayoutDashboard,
  MonitorSmartphone,
  FileText,
  Plug,
  Palette,
  Timer,
  Cpu,
  Settings,
  ShieldCheck,
  LogOut,
  Menu,
  X,
  type LucideIcon,
} from "lucide-react";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { VellumMark } from "@/components/vellum-brand";

const links: { href: string; key: "overview" | "devices" | "content" | "providers" | "themes" | "profiles" | "firmware" | "system" | "access"; Icon: LucideIcon }[] = [
  { href: "/admin", key: "overview", Icon: LayoutDashboard },
  { href: "/admin/devices", key: "devices", Icon: MonitorSmartphone },
  { href: "/admin/content", key: "content", Icon: FileText },
  { href: "/admin/providers", key: "providers", Icon: Plug },
  { href: "/admin/themes", key: "themes", Icon: Palette },
  { href: "/admin/profiles", key: "profiles", Icon: Timer },
  { href: "/admin/firmware", key: "firmware", Icon: Cpu },
  { href: "/admin/system", key: "system", Icon: Settings },
  { href: "/admin/access", key: "access", Icon: ShieldCheck },
];

const LOCALES = [
  { code: "de", label: "Deutsch" },
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "it", label: "Italiano" },
  { code: "es", label: "Español" },
] as const;

function logout() {
  document.cookie = "admin_session=; path=/; max-age=0";
  window.location.href = "/login";
}

export function AdminNav({ canAccessManagement, canReadSystem }: {
  canAccessManagement: boolean;
  canReadSystem: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const t = useTranslations("nav");
  const locale = useLocale();
  const activeLocale = LOCALES.find(({ code }) => code === locale) ?? LOCALES[0];

  function setLocale(next: string) {
    document.cookie = `locale=${next}; path=/; max-age=31536000`;
    window.location.reload();
  }

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        aria-label={t("title")}
        className="md:hidden fixed top-3 left-3 z-50 size-10 grid place-items-center rounded-md material-bar border border-separator text-label focus-ring"
      >
        {open ? <X size={20} /> : <Menu size={20} />}
      </button>

      {open && (
        <div className="md:hidden fixed inset-0 z-30 material-overlay" onClick={() => setOpen(false)} aria-hidden="true" />
      )}

      <nav
        className={`material-sidebar fixed md:sticky top-0 z-40 h-dvh w-[248px] shrink-0 border-r border-separator
          flex flex-col px-3 py-4 transition-transform duration-300
          ${open ? "translate-x-0" : "-translate-x-full"} md:translate-x-0`}
      >
        <Link
          href="/admin"
          onClick={() => setOpen(false)}
          className="flex items-center gap-2.5 px-2 pb-4 rounded-lg focus-ring"
        >
          <VellumMark alt="" width={28} height={28} className="size-7" />
          <span className="text-[17px] font-semibold tracking-tight text-label">{t("title")}</span>
        </Link>

        <div className="flex flex-col gap-0.5">
          {links.filter((link) => (link.key !== "access" || canAccessManagement) &&
            (link.key !== "system" || canReadSystem)).map(({ href, key, Icon }) => {
            // Overview (/admin) is the index — exact match so it isn't perma-active
            // under every sub-route. Sub-pages match themselves or a nested route,
            // with a path boundary so e.g. /admin/devices doesn't light up for a
            // hypothetical /admin/devices-settings.
            const active =
              href === "/admin"
                ? pathname === "/admin"
                : pathname === href || pathname.startsWith(href + "/");
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-3 min-h-9 px-3 rounded-lg text-[15px] focus-ring transition
                  ${active ? "bg-accent-soft text-accent font-medium" : "text-label-secondary hover:bg-fill-tertiary hover:text-label"}`}
              >
                <Icon size={18} aria-hidden="true" />
                {t(key)}
              </Link>
            );
          })}
        </div>

        <div className="mt-auto flex items-center justify-between gap-1.5 pt-3 border-t border-separator whitespace-nowrap">
          <ThemeToggle />
          <select
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
            aria-label={`${t("language")}: ${activeLocale.label}`}
            title={activeLocale.label}
            className="h-8 w-[3.75rem] shrink-0 rounded-md border border-separator bg-surface-secondary px-2 text-center text-xs font-semibold uppercase tracking-wide text-label focus-ring"
          >
            {LOCALES.map(({ code, label }) => (
              <option key={code} value={code} lang={code} aria-label={label}>
                {code.toUpperCase()}
              </option>
            ))}
          </select>
          <button
            onClick={logout}
            aria-label={t("logout")}
            title={t("logout")}
            className="size-8 shrink-0 grid place-items-center rounded-md text-label-secondary hover:bg-fill-tertiary hover:text-red focus-ring transition"
          >
            <LogOut size={17} aria-hidden="true" />
          </button>
        </div>
      </nav>
    </>
  );
}
