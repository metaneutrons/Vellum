// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { Cpu, PackageX } from "lucide-react";
import { DashCard } from "./card";
import type { DashboardData } from "../dashboard-data";

export function FirmwarePanel({ firmware }: { firmware: DashboardData["firmware"] }) {
  const { latestStable, latestBeta, upToDate, behind, unknown, byVersion } = firmware;

  const rated = upToDate + behind + unknown;
  const hasVersions = byVersion.length > 0;
  const isEmpty = !latestStable && !latestBeta && rated === 0 && !hasVersions;

  // Ratio bar widths (only known states fill the bar; unknown sits in the track).
  const total = Math.max(rated, 1);
  const upPct = (upToDate / total) * 100;
  const behindPct = (behind / total) * 100;

  const maxVersionCount = hasVersions ? Math.max(...byVersion.map((v) => v.count)) : 0;

  return (
    <DashCard title="Firmware" icon={<Cpu size={16} />} action={{ label: "Manage", href: "/admin/firmware" }}>
      {isEmpty ? (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
          <span className="size-10 rounded-full bg-surface-secondary text-label-tertiary grid place-items-center" aria-hidden="true">
            <PackageX size={18} />
          </span>
          <p className="text-sm text-label-secondary">No firmware data yet</p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {/* Latest versions */}
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-label-secondary">Latest stable</span>
              {latestStable ? (
                <span className="font-mono text-label bg-surface-secondary rounded-md px-2 py-0.5 text-[15px] leading-snug w-fit">
                  {latestStable}
                </span>
              ) : (
                <span className="text-sm text-label-tertiary">—</span>
              )}
            </div>
            {latestBeta && (
              <div className="flex flex-col gap-1.5 items-start sm:items-end">
                <span className="text-xs font-medium text-label-tertiary">Latest beta</span>
                <span className="font-mono text-label-secondary bg-surface-secondary rounded-md px-2 py-0.5 text-xs leading-snug w-fit">
                  {latestBeta}
                </span>
              </div>
            )}
          </div>

          {/* Stacked ratio bar */}
          <div className="flex flex-col gap-3">
            <div
              className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-secondary"
              role="img"
              aria-label={`${upToDate} devices up to date, ${behind} behind, ${unknown} unknown`}
            >
              {upToDate > 0 && (
                <div className="h-full bg-green transition-[width] duration-500" style={{ width: `${upPct}%` }} />
              )}
              {behind > 0 && (
                <div className="h-full bg-orange transition-[width] duration-500" style={{ width: `${behindPct}%` }} />
              )}
            </div>

            <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-label-secondary">
              <LegendItem dotClass="bg-green" count={upToDate} label="up to date" />
              <LegendItem dotClass="bg-orange" count={behind} label="behind" />
              <LegendItem dotClass="bg-surface-secondary ring-1 ring-separator" count={unknown} label="unknown" />
            </ul>
          </div>

          {/* By version */}
          {hasVersions && (
            <div className="flex flex-col gap-2.5 border-t border-separator/60 pt-4">
              <span className="text-xs font-medium text-label-secondary">By version</span>
              <ul className="flex flex-col gap-2">
                {byVersion.map((v) => (
                  <li key={v.version} className="flex items-center gap-3">
                    <span className="font-mono text-xs text-label w-20 shrink-0 truncate" title={v.version}>
                      {v.version}
                    </span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-secondary">
                      <div
                        className="h-full rounded-full bg-accent-soft transition-[width] duration-500"
                        style={{ width: `${maxVersionCount ? (v.count / maxVersionCount) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-xs tabular-nums text-label-secondary w-8 text-right shrink-0">
                      {v.count}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </DashCard>
  );
}

function LegendItem({ dotClass, count, label }: { dotClass: string; count: number; label: string }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      <span className={`size-2 rounded-full shrink-0 ${dotClass}`} aria-hidden="true" />
      <span className="tabular-nums font-medium text-label">{count}</span>
      <span className="text-label-tertiary">{label}</span>
    </li>
  );
}
