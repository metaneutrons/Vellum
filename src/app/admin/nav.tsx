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

export function AdminNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const t = useTranslations("nav");
  const currentLocale = useLocale();
  const [dark, setDark] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    if (stored === "light") { setDark(false); document.documentElement.classList.remove("dark"); }
    else { document.documentElement.classList.add("dark"); }
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
      <button onClick={() => setOpen(!open)} style={{ display: "none" }} className="mobile-hamburger" id="hamburger" aria-label="Toggle menu">
        {open ? "✕" : "☰"}
      </button>
      {open && <div className="sidebar-overlay" onClick={() => setOpen(false)} />}
      <nav className={`sidebar ${open ? "sidebar-open" : ""}`}>
        {/* Logo */}
        <div style={{ padding: "16px 16px 12px", fontSize: 18, fontWeight: 700, color: "#fff", display: "flex", alignItems: "center", gap: 10 }}>
          <img src="/vellum-icon.svg" alt="" width={40} height={40} style={{ filter: "brightness(0) invert(1)" }} />
          {t("title")}
        </div>

        {/* Controls: language, theme, logout */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 12px 12px", borderBottom: "1px solid #374151" }}>
          {/* Language dropdown with flags */}
          <select value={currentLocale} onChange={(e) => setLocale(e.target.value)}
            aria-label="Language"
            style={{ background: "#1f2937", color: "#fff", border: "1px solid #374151", borderRadius: 4, padding: "4px 6px", fontSize: 14, cursor: "pointer" }}>
            {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}
          </select>
          <div style={{ flex: 1 }} />
          {/* Theme toggle */}
          <button onClick={toggleTheme} title={dark ? "Light mode" : "Dark mode"}
            style={{ fontSize: 14, padding: "4px 6px", borderRadius: 4, border: "none", background: "transparent", color: "#9ca3af", cursor: "pointer" }}>
            {dark ? "☀️" : "🌙"}
          </button>
          {/* Logout */}
          <button onClick={logout} title={t("logout")}
            style={{ fontSize: 14, padding: "4px 6px", borderRadius: 4, border: "none", background: "transparent", color: "#9ca3af", cursor: "pointer" }}>
            ⏻
          </button>
        </div>

        {/* Navigation links */}
        <div style={{ flex: 1, paddingTop: 4 }}>
          {linkKeys.map((l) => (
            <Link key={l.href} href={l.href} onClick={() => setOpen(false)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", fontSize: 14, color: pathname.startsWith(l.href) ? "#fff" : "#9ca3af", background: pathname.startsWith(l.href) ? "#1f2937" : "transparent", textDecoration: "none" }}>
              <span style={{ fontSize: 16 }}>{l.icon}</span>
              {t(l.key)}
            </Link>
          ))}
        </div>
      </nav>
      <style>{`
        .sidebar { width: 224px; min-height: 100vh; background: #0a0c14; display: flex; flex-direction: column; flex-shrink: 0; border-right: 1px solid #1e2030; }
        .sidebar-overlay { display: none; }
        @media (max-width: 767px) {
          .sidebar { position: fixed; top: 0; left: 0; bottom: 0; z-index: 40; transform: translateX(-100%); transition: transform 0.2s; }
          .sidebar.sidebar-open { transform: translateX(0); }
          .sidebar-overlay { display: block; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 39; }
          #hamburger { display: block !important; position: fixed; top: 16px; left: 16px; z-index: 50; background: #111827; color: #fff; padding: 8px 12px; border-radius: 8px; border: none; font-size: 18px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
        }
      `}</style>
    </>
  );
}
