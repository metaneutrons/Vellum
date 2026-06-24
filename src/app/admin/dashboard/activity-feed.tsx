// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { History, AlertCircle, Inbox } from "lucide-react";
import { DashCard } from "./card";
import { relativeTime, shortMac, batteryTone } from "./util";
import { StatusPill } from "@/components/ui/badge";
import type { DashboardData, RecentDevice } from "../dashboard-data";

/** Status string → StatusPill tone. */
function statusTone(status: string): "green" | "orange" | "red" {
  if (status === "approved") return "green";
  if (status === "pending") return "orange";
  return "red";
}

/** batteryTone bucket → label text color (muted falls back to tertiary). */
const BATTERY_TEXT: Record<ReturnType<typeof batteryTone>, string> = {
  green: "text-green",
  orange: "text-orange",
  red: "text-red",
  muted: "text-label-tertiary",
};

const SECTION_HEADING =
  "text-xs font-semibold uppercase tracking-wide text-label-tertiary px-5 pt-3 pb-1.5";

export function ActivityFeed({
  recent,
  reports,
  now,
}: {
  recent: RecentDevice[];
  reports: DashboardData["reports"];
  now: number;
}) {
  const hasRecent = recent.length > 0;
  const hasReports = reports.length > 0;

  return (
    <DashCard title="Recent activity" icon={<History size={16} />} flush>
      {!hasRecent && !hasReports ? (
        <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center">
          <span className="size-10 rounded-full bg-accent-soft text-accent grid place-items-center">
            <Inbox size={18} aria-hidden="true" />
          </span>
          <p className="text-[13px] text-label-secondary">No recent activity yet</p>
        </div>
      ) : (
        <div className="pb-2">
          {/* (A) Latest check-ins */}
          {hasRecent && (
            <section>
              <h3 className={SECTION_HEADING}>Latest check-ins</h3>
              <ul className="divide-y divide-separator">
                {recent.map((d) => {
                  const tone = batteryTone(d.batteryLevel);
                  return (
                    <li
                      key={d.mac}
                      className="flex items-center gap-3 px-5 py-2.5"
                    >
                      <span
                        className={`size-2 rounded-full shrink-0 ${
                          d.online ? "bg-green" : "bg-separator"
                        }`}
                        aria-label={d.online ? "Online" : "Offline"}
                      />
                      <span
                        className="font-mono text-[13px] font-medium text-label tracking-tight shrink-0"
                        title={d.mac}
                      >
                        {shortMac(d.mac)}
                      </span>
                      <StatusPill tone={statusTone(d.status)}>{d.status}</StatusPill>
                      {d.batteryLevel !== null && (
                        <span
                          className={`text-[13px] font-medium tabular-nums shrink-0 ${BATTERY_TEXT[tone]}`}
                        >
                          {d.batteryLevel}%
                        </span>
                      )}
                      <span className="ml-auto text-xs text-label-tertiary tabular-nums shrink-0">
                        {relativeTime(d.lastSeen, now)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {/* (B) Reports */}
          {hasReports && (
            <section>
              <h3 className={SECTION_HEADING}>Reports</h3>
              <ul className="divide-y divide-separator">
                {reports.map((r, i) => (
                  <li
                    key={`${r.mac}-${r.timestamp}-${i}`}
                    className="flex items-center gap-3 px-5 py-2.5"
                  >
                    <AlertCircle
                      size={15}
                      className="text-orange shrink-0"
                      aria-hidden="true"
                    />
                    <span className="flex-1 min-w-0 truncate text-[13px] text-label">
                      {r.issue ?? (
                        <span className="text-label-tertiary italic">(no detail)</span>
                      )}
                    </span>
                    <span
                      className="font-mono text-xs text-label-tertiary tracking-tight shrink-0"
                      title={r.mac}
                    >
                      {shortMac(r.mac)}
                    </span>
                    <span className="text-xs text-label-tertiary tabular-nums shrink-0">
                      {relativeTime(r.timestamp, now)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </DashCard>
  );
}
