// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { useTranslations, useLocale } from "next-intl";

const linkKeys = [
  { href: "/admin/devices", key: "devices" as const, icon: "◻" },
  { href: "/admin/content", key: "content" as const, icon: "▤" },
  { href: "/admin/providers", key: "providers" as const, icon: "⚡" },
  { href: "/admin/themes", key: "themes" as const, icon: "◑" },
  { href: "/admin/profiles", key: "profiles" as const, icon: "↻" },
  { href: "/admin/firmware", key: "firmware" as const, icon: "↑" },
];

const LOCALES = [
  { code: "de", flag: "🇩🇪", label: "Deutsch" },
  { code: "en", flag: "🇬🇧", label: "English" },
  { code: "fr", flag: "🇫🇷", label: "Français" },
  { code: "it", flag: "🇮🇹", label: "Italiano" },
  { code: "es", flag: "🇪🇸", label: "Español" },
];

function logout() {
  document.cookie = "admin_session=; path=/; max-age=0";
  window.location.href = "/login";
}

/**
 * Main navigation sidebar for the admin dashboard.
 *
 * Implements a responsive, glassmorphism-styled navigation menu.
 * On mobile, it acts as a slide-out drawer with a hamburger toggle.
 * It also includes controls for locale selection and dark/light mode toggling.
 *
 * @returns {JSX.Element} The rendered navigation component.
 */
export function AdminNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const t = useTranslations("nav");
  const currentLocale = useLocale();
  const [dark, setDark] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    if (stored === "light") {
      setDark(false);
      document.documentElement.classList.remove("dark");
    } else {
      document.documentElement.classList.add("dark");
    }
  }, []);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    localStorage.setItem("theme", next ? "dark" : "light");
    document.documentElement.classList.toggle("dark", next);
  }

  function setLocale(locale: string) {
    document.cookie = `locale=${locale}; path=/; max-age=31536000`;
    window.location.reload();
  }

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className="md:hidden fixed top-4 left-4 z-50 bg-gray-900 text-white px-3 py-2 rounded-lg border-none text-lg cursor-pointer shadow-md"
        aria-label="Toggle menu"
      >
        {open ? "✕" : "☰"}
      </button>
      {open && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 backdrop-blur-sm z-30"
          onClick={() => setOpen(false)}
        />
      )}
      <nav
        className={`flex flex-col shrink-0 w-56 min-h-screen bg-[#0a0c14]/90 backdrop-blur-xl border-r border-[#1e2030] max-md:fixed max-md:top-0 max-md:left-0 max-md:bottom-0 max-md:z-40 max-md:transition-transform max-md:duration-200 ${open ? "max-md:translate-x-0" : "max-md:-translate-x-full"}`}
      >
        {/* Logo */}
        <div
          style={{
            padding: "16px 16px 12px",
            fontSize: 18,
            fontWeight: 700,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <img
            src="/vellum-icon.svg"
            alt=""
            width={40}
            height={40}
            style={{ filter: "brightness(0) invert(1)" }}
          />
          {t("title")}
        </div>

        {/* Controls: language, theme, logout */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 12px 12px",
            borderBottom: "1px solid #374151",
          }}
        >
          {/* Language dropdown with flags */}
          <select
            value={currentLocale}
            onChange={(e) => setLocale(e.target.value)}
            aria-label="Language"
            style={{
              background: "#1f2937",
              color: "#fff",
              border: "1px solid #374151",
              borderRadius: 4,
              padding: "4px 6px",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            {LOCALES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.flag} {l.label}
              </option>
            ))}
          </select>
          <div style={{ flex: 1 }} />
          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            title={dark ? t("lightMode") : t("darkMode")}
            style={{
              fontSize: 14,
              padding: "4px 6px",
              borderRadius: 4,
              border: "none",
              background: "transparent",
              color: "#9ca3af",
              cursor: "pointer",
            }}
          >
            {dark ? "☀️" : "🌙"}
          </button>
          {/* Logout */}
          <button
            onClick={logout}
            title={t("logout")}
            style={{
              fontSize: 14,
              padding: "4px 6px",
              borderRadius: 4,
              border: "none",
              background: "transparent",
              color: "#9ca3af",
              cursor: "pointer",
            }}
          >
            ⏻
          </button>
        </div>

        {/* Navigation links */}
        <div style={{ flex: 1, paddingTop: 4 }}>
          {linkKeys.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "12px 16px",
                fontSize: 14,
                color: pathname.startsWith(l.href) ? "#fff" : "#9ca3af",
                background: pathname.startsWith(l.href)
                  ? "#1f2937"
                  : "transparent",
                textDecoration: "none",
              }}
            >
              <span style={{ fontSize: 16 }}>{l.icon}</span>
              {t(l.key)}
            </Link>
          ))}
        </div>
      </nav>
    </>
  );
}
