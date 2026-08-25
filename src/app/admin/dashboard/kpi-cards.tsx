// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useTranslations } from "next-intl";

import Link from "next/link";
import { MonitorSmartphone, Wifi, UserCheck, AlertTriangle, type LucideIcon } from "lucide-react";
import type { DashboardData } from "../dashboard-data";

type ChipTone = "accent" | "green" | "orange" | "red";

const chipTones: Record<ChipTone, string> = {
  accent: "bg-accent-soft text-accent",
  green: "bg-green/10 text-green",
  orange: "bg-orange/10 text-orange",
  red: "bg-red/10 text-red",
};

interface TileProps {
  icon: LucideIcon;
  chipTone: ChipTone;
  value: number;
  label: string;
  sub: string;
  /** Tint the big figure to match a status (e.g. red when attention > 0). */
  valueTone?: "label" | "red";
  href?: string;
}

const TILE_BASE =
  "flex flex-col gap-3 bg-surface rounded-2xl border border-separator/60 shadow-e1 p-5";

function TileInner({ icon: Icon, chipTone, value, label, sub, valueTone = "label" }: TileProps) {
  return (
    <>
      <span
        className={`size-9 rounded-full grid place-items-center shrink-0 ${chipTones[chipTone]}`}
        aria-hidden="true"
      >
        <Icon size={18} />
      </span>
      <div className="flex flex-col gap-0.5">
        <span
          className={`text-3xl font-semibold leading-none tabular-nums ${
            valueTone === "red" ? "text-red" : "text-label"
          }`}
        >
          {value.toLocaleString()}
        </span>
        <span className="text-sm font-medium text-label-secondary">{label}</span>
        <span className="text-xs text-label-tertiary">{sub}</span>
      </div>
    </>
  );
}

function Tile(props: TileProps) {
  if (props.href) {
    return (
      <Link
        href={props.href}
        className={`${TILE_BASE} focus-ring transition-shadow hover:shadow-e2`}
      >
        <TileInner {...props} />
      </Link>
    );
  }
  return (
    <div className={TILE_BASE}>
      <TileInner {...props} />
    </div>
  );
}

/**
 * The hero KPI row — four standalone stat tiles giving an at-a-glance read on
 * fleet health. Linked tiles (pending, attention) lift on hover and deep-link
 * into the device table. All figures come straight from server-aggregated props.
 */
export function KpiCards({
  fleet,
  attentionCount,
}: {
  fleet: DashboardData["fleet"];
  attentionCount: number;
}) {
  const t = useTranslations("dashboard");
  const onlinePct = fleet.total ? Math.round((fleet.online / fleet.total) * 100) : 0;
  const hasPending = fleet.pending > 0;
  const hasAttention = attentionCount > 0;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Tile
        icon={MonitorSmartphone}
        chipTone="accent"
        value={fleet.total}
        label={t("totalDevices")}
        sub={`${fleet.approved.toLocaleString()} approved`}
      />
      <Tile
        icon={Wifi}
        chipTone="green"
        value={fleet.online}
        label={t("onlineNow")}
        sub={`${onlinePct}% · ${fleet.offline.toLocaleString()} offline`}
      />
      <Tile
        icon={UserCheck}
        chipTone={hasPending ? "orange" : "accent"}
        value={fleet.pending}
        label={t("pendingApprovals")}
        sub="awaiting approval"
        href={hasPending ? "/admin/devices" : undefined}
      />
      <Tile
        icon={AlertTriangle}
        chipTone={hasAttention ? "red" : "green"}
        value={attentionCount}
        label={t("needsAttention")}
        sub={`${fleet.lowBattery.toLocaleString()} low battery · ${fleet.weakSignal.toLocaleString()} weak signal`}
        valueTone={hasAttention ? "red" : "label"}
        href={hasAttention ? "/admin/devices" : undefined}
      />
    </div>
  );
}
