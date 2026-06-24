// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

interface DashCardProps {
  title?: string;
  subtitle?: string;
  icon?: ReactNode;
  /** Optional "see more" link rendered top-right of the header. */
  action?: { label: string; href: string };
  /** Drop the default body padding (e.g. for edge-to-edge charts/lists). */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * The single card chrome for every dashboard widget — consistent surface,
 * radius, border, shadow, and header treatment so the grid reads as one piece.
 */
export function DashCard({ title, subtitle, icon, action, flush, className = "", children }: DashCardProps) {
  return (
    <section className={`flex flex-col bg-surface rounded-2xl border border-separator/60 shadow-e1 overflow-hidden ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
          <div className="flex items-center gap-2 min-w-0">
            {icon && <span className="text-label-secondary shrink-0" aria-hidden="true">{icon}</span>}
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-label leading-tight truncate">{title}</h2>
              {subtitle && <p className="text-xs text-label-tertiary truncate">{subtitle}</p>}
            </div>
          </div>
          {action && (
            <Link
              href={action.href}
              className="inline-flex items-center gap-0.5 text-[13px] font-medium text-accent hover:opacity-80 focus-ring rounded px-1 -mr-1 shrink-0"
            >
              {action.label}
              <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          )}
        </header>
      )}
      <div className={flush ? "flex-1" : "flex-1 px-5 pb-5"}>{children}</div>
    </section>
  );
}
