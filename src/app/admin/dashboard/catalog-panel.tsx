"use client";

import { useTranslations } from "next-intl";
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

import Link from "next/link";
import { FileText, Plug, Palette, Timer, type LucideIcon } from "lucide-react";
import type { DashboardData } from "../dashboard-data";

interface TileProps {
  href: string;
  icon: LucideIcon;
  label: string;
  value: number;
  children?: React.ReactNode;
}

function Tile({ href, icon: Icon, label, value, children }: TileProps) {
  return (
    <Link
      href={href}
      className="group flex flex-col bg-surface rounded-2xl border border-separator/60 shadow-e1 p-5 transition-shadow hover:shadow-e2 focus-ring"
    >
      <span
        className="size-9 rounded-full bg-accent-soft text-accent grid place-items-center mb-4"
        aria-hidden="true"
      >
        <Icon size={18} />
      </span>
      <span className="text-3xl font-semibold text-label tabular-nums leading-none">
        {value.toLocaleString()}
      </span>
      <span className="mt-1.5 text-sm text-label-secondary">{label}</span>
      {children}
    </Link>
  );
}

/**
 * Full-width row of four catalog stat tiles — content, providers, themes, and
 * refresh profiles. Each tile links to its management page. Real counts only;
 * zero renders cleanly as "0".
 */
export function CatalogPanel({ catalog }: { catalog: DashboardData["catalog"] }) {
  const t = useTranslations("dashboard");
  const tNav = useTranslations("nav");
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Tile
        href="/admin/content"
        icon={FileText}
        label={t("contentInstances")}
        value={catalog.contentInstances}
      />

      <Tile href="/admin/providers" icon={Plug} label={tNav("providers")} value={catalog.providers}>
        {catalog.providersByType.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {catalog.providersByType.map((p) => (
              <span
                key={p.type}
                className="inline-flex items-center bg-surface-secondary text-label-secondary rounded-full px-2 py-0.5 text-xs"
              >
                {p.type} ·{p.count}
              </span>
            ))}
          </div>
        )}
      </Tile>

      <Tile href="/admin/themes" icon={Palette} label={tNav("themes")} value={catalog.themes} />

      <Tile
        href="/admin/profiles"
        icon={Timer}
        label={t("refreshProfiles")}
        value={catalog.profiles}
      />
    </div>
  );
}
