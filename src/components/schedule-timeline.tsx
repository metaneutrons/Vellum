// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";
import { useTranslations } from "next-intl";
import { fmtInterval } from "@/lib/duration";
import type { ScheduleRule } from "@/lib/sleep";
import { TZDate } from "@date-fns/tz";

function describeRule(rule: ScheduleRule, fallback: number): string {
  const usb = rule.usb?.intervalS ?? rule.intervalS ?? fallback;
  const battery = rule.battery?.intervalS ?? rule.intervalS ?? fallback;
  return `${fmtInterval(usb)} / ${fmtInterval(battery)}`;
}

const COLORS = [
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#6366f1",
  "#14b8a6",
];

function isOvernight(r: ScheduleRule): boolean {
  return r.startHour > r.endHour;
}

function matchesLocal(rule: ScheduleRule, day: number, hour: number): boolean {
  if (rule.startHour === rule.endHour) {
    return rule.days.length === 0 || rule.days.includes(day);
  }
  if (rule.startHour < rule.endHour) {
    return (
      (rule.days.length === 0 || rule.days.includes(day)) &&
      hour >= rule.startHour &&
      hour < rule.endHour
    );
  }
  const phaseDay = hour < rule.endHour ? (day + 6) % 7 : day;
  return (
    (rule.days.length === 0 || rule.days.includes(phaseDay)) &&
    (hour >= rule.startHour || hour < rule.endHour)
  );
}

function slots(rule: ScheduleRule): Set<number> {
  const result = new Set<number>();
  for (let day = 0; day < 7; day++) {
    for (let quarter = 0; quarter < 96; quarter++) {
      const hour = quarter / 4;
      if (matchesLocal(rule, day, hour)) result.add(day * 96 + quarter);
    }
  }
  return result;
}

function rulesOverlap(a: ScheduleRule, b: ScheduleRule): boolean {
  const aSlots = slots(a);
  return [...slots(b)].some((slot) => aSlots.has(slot));
}

function matchesNow(rule: ScheduleRule, now: Date): boolean {
  const day = now.getDay();
  const hour = now.getHours();
  return matchesLocal(rule, day, hour);
}

function blocksForDay(rule: ScheduleRule, day: number): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];
  let start: number | null = null;
  for (let quarter = 0; quarter <= 96; quarter++) {
    const hour = quarter / 4;
    const active = hour < 24 && matchesLocal(rule, day, hour);
    if (active && start === null) start = hour;
    if (!active && start !== null) {
      blocks.push({ start, end: hour });
      start = null;
    }
  }
  return blocks;
}

export function ScheduleTimeline({
  rules,
  defaultUsbIntervalS,
  defaultBatteryIntervalS,
  timezone,
}: {
  rules: ScheduleRule[];
  defaultUsbIntervalS: number;
  defaultBatteryIntervalS: number;
  timezone: string;
}) {
  const t = useTranslations("profiles");
  if (rules.length === 0) return null;

  let now: Date;
  try {
    now = new TZDate(new Date(), timezone);
  } catch {
    now = new Date();
  }
  const nowHour = now.getHours() + now.getMinutes() / 60;
  const today = now.getDay();

  // Detect overlaps
  const overlaps: [number, number][] = [];
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const left = rules[i];
      const right = rules[j];
      if (left && right && rulesOverlap(left, right)) overlaps.push([i, j]);
    }
  }

  return (
    <div className="mt-4 mb-2">
      <div className="flex justify-between items-center mb-2">
        <span className="text-xs font-medium">{t("timelineToday")}</span>
        <span className="text-xs text-label-secondary">
          {t("timelineDefault", {
            interval: `${fmtInterval(defaultUsbIntervalS)} / ${fmtInterval(defaultBatteryIntervalS)}`,
          })}{" "}
          · {timezone}
        </span>
      </div>

      {/* Timeline bar */}
      <div
        className="relative h-8 rounded overflow-hidden border"
        style={{ background: "#1a1a2e" }}
      >
        {/* Hour markers */}
        {[0, 6, 12, 18].map((h) => (
          <div
            key={h}
            className="absolute top-0 bottom-0 border-l border-white/15"
            style={{ left: `${(h / 24) * 100}%` }}
          >
            <span
              className="absolute -top-4 text-[9px] text-label-secondary"
              style={{ transform: "translateX(-50%)" }}
            >
              {h}:00
            </span>
          </div>
        ))}

        {/* Rule blocks */}
        {rules.map((rule, i) => {
          const color = COLORS[i % COLORS.length];
          return (
            <span key={i}>
              {blocksForDay(rule, today).map((block) => (
                <div
                  key={`${block.start}-${block.end}`}
                  className="absolute top-1 bottom-1 rounded-sm opacity-80"
                  title={`${rule.name}: ${describeRule(rule, defaultBatteryIntervalS)}`}
                  style={{
                    left: `${(block.start / 24) * 100}%`,
                    width: `${((block.end - block.start) / 24) * 100}%`,
                    background: color,
                  }}
                />
              ))}
            </span>
          );
        })}

        {/* Now indicator */}
        <div
          className="absolute top-0 bottom-0 z-10 w-0.5 bg-orange"
          style={{ left: `${(nowHour / 24) * 100}%` }}
        />
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
        {rules.map((rule, i) => {
          const active = matchesNow(rule, now);
          const hasOverlap = overlaps.some(([a, b]) => a === i || b === i);
          return (
            <div key={i} className="flex items-center gap-1">
              <div
                className="w-2.5 h-2.5 rounded-sm"
                style={{ background: COLORS[i % COLORS.length] }}
              />
              <span
                className={`text-[10px] ${active ? "font-bold text-label" : "text-label-secondary"}`}
              >
                {rule.name || t("ruleFallback", { number: i + 1 })} (
                {describeRule(rule, defaultBatteryIntervalS)})
                {active && <span className="ml-1 text-orange">● {t("active")}</span>}
                {isOvernight(rule) && <span className="ml-1">🌙</span>}
              </span>
              {hasOverlap && (
                <span className="text-[10px] text-orange" title={t("overlapHint")}>
                  ⚠
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Overlap warnings */}
      {overlaps.length > 0 && (
        <div className="mt-2 text-[10px] text-orange">
          ⚠{" "}
          {t("overlapSummary", {
            pairs: overlaps.map(([a, b]) => `#${a + 1}↔#${b + 1}`).join(", "),
          })}
        </div>
      )}
    </div>
  );
}
