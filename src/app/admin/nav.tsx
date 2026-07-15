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
  LogOut,
  Menu,
  X,
  type LucideIcon,
} from "lucide-react";
import { ThemeToggle } from "@/components/ui/theme-toggle";

const links: { href: string; key: "overview" | "devices" | "content" | "providers" | "themes" | "profiles" | "firmware"; Icon: LucideIcon }[] = [
  { href: "/admin", key: "overview", Icon: LayoutDashboard },
  { href: "/admin/devices", key: "devices", Icon: MonitorSmartphone },
  { href: "/admin/content", key: "content", Icon: FileText },
  { href: "/admin/providers", key: "providers", Icon: Plug },
  { href: "/admin/themes", key: "themes", Icon: Palette },
  { href: "/admin/profiles", key: "profiles", Icon: Timer },
  { href: "/admin/firmware", key: "firmware", Icon: Cpu },
];

const LOCALES = [
  { code: "de", label: "Deutsch" },
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "it", label: "Italiano" },
  { code: "es", label: "Español" },
];

function logout() {
  document.cookie = "admin_session=; path=/; max-age=0";
  window.location.href = "/login";
}

export function AdminNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const t = useTranslations("nav");
  const locale = useLocale();

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
          <img src="/vellum-icon.svg" alt="" width={28} height={28} className="dark:invert" />
          <span className="text-[17px] font-semibold tracking-tight text-label">{t("title")}</span>
        </Link>

        <div className="flex flex-col gap-0.5">
          {links.map(({ href, key, Icon }) => {
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

        <div className="mt-auto flex flex-col gap-3 pt-3 border-t border-separator">
          <ThemeToggle />
          <div className="flex items-center gap-2">
            <select
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
              aria-label="Language"
              className="flex-1 min-h-9 px-2.5 rounded-md bg-surface-secondary border border-separator text-sm text-label focus-ring"
            >
              {LOCALES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
            <button
              onClick={logout}
              aria-label={t("logout")}
              title={t("logout")}
              className="size-9 grid place-items-center rounded-md text-label-secondary hover:bg-fill-tertiary hover:text-red focus-ring transition"
            >
              <LogOut size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
      </nav>
    </>
  );
}
