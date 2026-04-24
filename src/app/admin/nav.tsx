"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const links = [
  { href: "/admin/devices", label: "Devices", icon: "📡" },
  { href: "/admin/content", label: "Content", icon: "📋" },
  { href: "/admin/providers", label: "Data Providers", icon: "🔌" },
  { href: "/admin/themes", label: "Themes", icon: "🎨" },
  { href: "/admin/profiles", label: "Refresh Profiles", icon: "⏱" },
  { href: "/admin/telemetry", label: "Telemetry", icon: "📊" },
];

function logout() {
  document.cookie = "admin_session=; path=/; max-age=0";
  window.location.href = "/login";
}

export function AdminNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Hamburger — only on small screens via CSS */}
      <button
        onClick={() => setOpen(!open)}
        style={{ display: "none" }}
        className="mobile-hamburger"
        id="hamburger"
      >
        {open ? "✕" : "☰"}
      </button>

      {/* Overlay */}
      {open && <div className="sidebar-overlay" onClick={() => setOpen(false)} />}

      {/* Sidebar */}
      <nav
        className={`sidebar ${open ? "sidebar-open" : ""}`}
      >
        <div style={{ padding: 16, fontSize: 18, fontWeight: 700, color: "#fff", borderBottom: "1px solid #374151", display: "flex", alignItems: "center", gap: 10 }}>
          <img src="/vellum-icon.svg" alt="" width={48} height={48} style={{ filter: "brightness(0) invert(1)" }} />
          Vellum Admin
        </div>
        <div style={{ flex: 1, paddingTop: 8 }}>
          {links.map((l) => (
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
                background: pathname.startsWith(l.href) ? "#1f2937" : "transparent",
                textDecoration: "none",
              }}
            >
              <span style={{ fontSize: 16 }}>{l.icon}</span>
              {l.label}
            </Link>
          ))}
        </div>
        <button
          onClick={logout}
          style={{
            padding: "12px 16px", fontSize: 14, color: "#6b7280",
            borderTop: "1px solid #374151", textAlign: "left", background: "none", border: "none",
            borderTopStyle: "solid", borderTopWidth: 1, borderTopColor: "#374151", cursor: "pointer", width: "100%",
          }}
        >
          Logout
        </button>
      </nav>

      <style>{`
        .sidebar {
          width: 224px;
          min-height: 100vh;
          background: #0a0c14;
          display: flex;
          flex-direction: column;
          flex-shrink: 0;
          border-right: 1px solid #1e2030;
        }
        .sidebar-overlay { display: none; }

        @media (max-width: 767px) {
          .sidebar {
            position: fixed;
            top: 0;
            left: 0;
            bottom: 0;
            z-index: 40;
            transform: translateX(-100%);
            transition: transform 0.2s;
          }
          .sidebar.sidebar-open {
            transform: translateX(0);
          }
          .sidebar-overlay {
            display: block;
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.5);
            z-index: 39;
          }
          #hamburger {
            display: block !important;
            position: fixed;
            top: 16px;
            left: 16px;
            z-index: 50;
            background: #111827;
            color: #fff;
            padding: 8px 12px;
            border-radius: 8px;
            border: none;
            font-size: 18px;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3);
          }
        }
      `}</style>
    </>
  );
}
