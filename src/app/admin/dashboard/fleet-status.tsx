// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { Activity, Battery, BatteryLow, WifiOff, MonitorSmartphone } from "lucide-react";
import { DashCard } from "./card";
import { useTranslations } from "next-intl";
import type { DashboardData } from "../dashboard-data";

/** Geometry for the donut — a single SVG circle styled with stroke-dasharray. */
const SIZE = 160;
const STROKE = 16;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const CENTER = SIZE / 2;

interface MiniStatProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  tone: "green" | "orange" | "red" | "muted";
}

const TONE_CHIP: Record<MiniStatProps["tone"], string> = {
  green: "bg-green/10 text-green",
  orange: "bg-orange/10 text-orange",
  red: "bg-red/10 text-red",
  muted: "bg-bg-secondary text-label-tertiary",
};

function MiniStat({ icon, label, value, tone }: MiniStatProps) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-xl bg-surface-secondary px-2 py-3 text-center">
      <span
        className={`size-8 rounded-full grid place-items-center ${TONE_CHIP[tone]}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="text-lg font-semibold text-label tabular-nums leading-none">{value}</span>
      <span className="text-[11px] font-medium text-label-secondary leading-tight">{label}</span>
    </div>
  );
}

export function FleetStatus({ fleet }: { fleet: DashboardData["fleet"] }) {
  const t = useTranslations("dashboard");
  const { total, online, late, offline, never, avgBattery, lowBattery, weakSignal } = fleet;
  const hasDevices = total > 0;

  const pct = hasDevices ? Math.round((online / total) * 100) : 0;
  // Fraction of the ring devoted to the "online" arc.
  const onlineFraction = hasDevices ? online / total : 0;
  const onlineDash = CIRCUMFERENCE * onlineFraction;

  // Tint the centre figure and online arc by overall health.
  const healthTone = pct >= 80 ? "green" : pct >= 50 ? "orange" : "red";
  const healthStroke =
    healthTone === "green"
      ? "var(--color-green)"
      : healthTone === "orange"
        ? "var(--color-orange)"
        : "var(--color-red)";
  const healthText =
    healthTone === "green" ? "text-green" : healthTone === "orange" ? "text-orange" : "text-red";

  // Mini-stat severity tones mirror the device-table thresholds.
  const batteryTone =
    avgBattery === null ? "muted" : avgBattery < 20 ? "red" : avgBattery < 40 ? "orange" : "green";

  return (
    <DashCard title={t("fleetHealth")} icon={<Activity size={16} />}>
      {!hasDevices ? (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
          <span className="size-12 rounded-full bg-accent-soft text-accent grid place-items-center" aria-hidden="true">
            <MonitorSmartphone size={22} />
          </span>
          <div>
            <p className="text-[15px] font-semibold text-label">{t("noDevices")}</p>
            <p className="text-[13px] text-label-secondary mt-0.5">
              {t("fleetHint")}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center">
          {/* ── Donut ── */}
          <div className="relative" style={{ width: SIZE, height: SIZE }}>
            <svg
              width={SIZE}
              height={SIZE}
              viewBox={`0 0 ${SIZE} ${SIZE}`}
              className="-rotate-90"
              role="img"
              aria-label={`${pct}% of devices online (${online} of ${total})`}
            >
              {/* Subtle track behind everything */}
              <circle
                cx={CENTER}
                cy={CENTER}
                r={RADIUS}
                fill="none"
                stroke="var(--color-bg-secondary)"
                strokeWidth={STROKE}
              />
              {/* Offline remainder — muted separator */}
              <circle
                cx={CENTER}
                cy={CENTER}
                r={RADIUS}
                fill="none"
                stroke="var(--color-separator)"
                strokeWidth={STROKE}
                strokeLinecap="round"
                strokeDasharray={`${CIRCUMFERENCE} ${CIRCUMFERENCE}`}
              />
              {/* Online arc — health-tinted, drawn on top */}
              <circle
                cx={CENTER}
                cy={CENTER}
                r={RADIUS}
                fill="none"
                stroke={healthStroke}
                strokeWidth={STROKE}
                strokeLinecap="round"
                strokeDasharray={`${onlineDash} ${CIRCUMFERENCE}`}
                className="transition-[stroke-dasharray] duration-700 ease-out"
              />
            </svg>
            {/* Centre label */}
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className={`text-3xl font-bold tabular-nums leading-none ${healthText}`}>
                {pct}
                <span className="text-xl align-top">%</span>
              </span>
              <span className="text-[11px] font-medium uppercase tracking-wide text-label-tertiary mt-1">
                online
              </span>
            </div>
          </div>

          {/* ── Legend ── */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 text-[13px]">
            <span className="inline-flex items-center gap-1.5 text-label-secondary">
              <span className="size-2.5 rounded-full" style={{ backgroundColor: healthStroke }} aria-hidden="true" />
              <span className="font-medium text-label tabular-nums">{online}</span> online
            </span>
            <span className="inline-flex items-center gap-1.5 text-label-secondary">
              <span className="size-2.5 rounded-full" style={{ backgroundColor: "var(--color-orange)" }} aria-hidden="true" />
              <span className="font-medium text-label tabular-nums">{late}</span> late
            </span>
            <span className="inline-flex items-center gap-1.5 text-label-secondary">
              <span className="size-2.5 rounded-full" style={{ backgroundColor: "var(--color-red)" }} aria-hidden="true" />
              <span className="font-medium text-label tabular-nums">{offline}</span> offline
            </span>
            <span className="inline-flex items-center gap-1.5 text-label-secondary">
              <span className="size-2.5 rounded-full" style={{ backgroundColor: "var(--color-separator)" }} aria-hidden="true" />
              <span className="font-medium text-label tabular-nums">{never}</span> never seen
            </span>
          </div>

          {/* ── Mini-stats ── */}
          <div className="mt-5 grid w-full grid-cols-3 gap-2.5">
            <MiniStat
              icon={<Battery size={16} aria-hidden="true" />}
              label="Avg battery"
              value={avgBattery === null ? "—" : `${avgBattery}%`}
              tone={batteryTone}
            />
            <MiniStat
              icon={<BatteryLow size={16} aria-hidden="true" />}
              label="Low battery"
              value={lowBattery}
              tone={lowBattery > 0 ? "orange" : "green"}
            />
            <MiniStat
              icon={<WifiOff size={16} aria-hidden="true" />}
              label="Weak signal"
              value={weakSignal}
              tone={weakSignal > 0 ? "orange" : "green"}
            />
          </div>
        </div>
      )}
    </DashCard>
  );
}
