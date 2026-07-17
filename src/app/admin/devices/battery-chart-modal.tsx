// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useState, useEffect } from "react";
import { Modal } from "@/components/modal";
import { TrendingDown } from "lucide-react";
import { useTranslations } from "next-intl";

interface DataPoint { voltage: number | null; level: number | null; timestamp: string; }

interface Props {
  mac: string;
  open: boolean;
  onClose: () => void;
}

type Metric = "voltage" | "level";
type TimeRange = "7" | "14" | "30" | "90";

const selectCls =
  "min-h-8 px-2.5 rounded-md bg-surface-secondary border border-separator text-[13px] text-label focus-ring";

export function BatteryChartModal({ mac, open, onClose }: Props) {
  const t = useTranslations("devices");
  const [data, setData] = useState<DataPoint[]>([]);
  const [metric, setMetric] = useState<Metric>("voltage");
  const [range, setRange] = useState<TimeRange>("30");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(`/api/v1/admin/battery-history?mac=${mac}&days=${range}`)
      .then(r => r.json())
      .then(setData)
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [mac, open, range]);

  const points = data
    .map(d => ({ t: new Date(d.timestamp).getTime(), v: metric === "voltage" ? d.voltage : d.level }))
    .filter((p): p is { t: number; v: number } => p.v !== null);

  // Chart dimensions
  const W = 600, H = 200, PAD = 40;
  const chartW = W - PAD * 2, chartH = H - PAD * 1.5;

  let minV = 0, maxV = 100;
  if (metric === "voltage") {
    minV = 3.0; maxV = 4.3;
  } else {
    minV = 0; maxV = 100;
  }

  if (points.length > 0) {
    const vals = points.map(p => p.v);
    const dataMin = Math.min(...vals);
    const dataMax = Math.max(...vals);
    if (metric === "voltage") {
      minV = Math.min(minV, Math.floor(dataMin * 10) / 10);
      maxV = Math.max(maxV, Math.ceil(dataMax * 10) / 10);
    }
  }

  const tMin = points.length > 0 ? points[0].t : Date.now() - 86400000;
  const tMax = points.length > 0 ? points[points.length - 1].t : Date.now();
  const tRange = Math.max(tMax - tMin, 1);

  const toX = (t: number) => PAD + ((t - tMin) / tRange) * chartW;
  const toY = (v: number) => PAD + chartH - ((v - minV) / (maxV - minV)) * chartH;

  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${toX(p.t).toFixed(1)} ${toY(p.v).toFixed(1)}`).join(" ");

  // Y-axis labels
  const ySteps = 5;
  const yLabels = Array.from({ length: ySteps + 1 }, (_, i) => minV + (maxV - minV) * (i / ySteps));

  // X-axis labels (dates)
  const xSteps = Math.min(points.length > 0 ? 5 : 0, 5);
  const xLabels = Array.from({ length: xSteps }, (_, i) => {
    const t = tMin + (tRange * (i + 1)) / (xSteps + 1);
    return { t, label: new Date(t).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) };
  });

  const unit = metric === "voltage" ? "V" : "%";
  const title = metric === "voltage" ? t("voltage") : t("capacity");

  return (
    <Modal open={open} onClose={onClose} title={`${title} — ${mac}`} wide>
      <div className="flex items-center gap-3 mb-4">
        <select value={metric} onChange={e => setMetric(e.target.value as Metric)}
          className={selectCls}>
          <option value="voltage">{t("voltage")} (V)</option>
          <option value="level">{t("capacity")} (%)</option>
        </select>
        <select value={range} onChange={e => setRange(e.target.value as TimeRange)}
          className={selectCls}>
          <option value="7">7 Tage</option>
          <option value="14">14 Tage</option>
          <option value="30">30 Tage</option>
          <option value="90">90 Tage</option>
        </select>
        <span className="text-xs text-label-secondary">{points.length} {t("dataPoints")}</span>
      </div>

      {loading ? (
        <div className="h-52 flex items-center justify-center text-label-tertiary">{t("loadingData")}</div>
      ) : points.length === 0 ? (
        <div className="h-52 flex items-center justify-center text-label-tertiary">{t("noData")}</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full border border-separator rounded bg-surface">
          {/* Grid lines */}
          {yLabels.map((v, i) => (
            <g key={i}>
              <line x1={PAD} y1={toY(v)} x2={W - PAD} y2={toY(v)} stroke="var(--color-separator)" strokeWidth="0.5" />
              <text x={PAD - 4} y={toY(v) + 3} textAnchor="end" fontSize="9" fill="var(--color-label-tertiary)">
                {metric === "voltage" ? v.toFixed(1) : Math.round(v)}{unit}
              </text>
            </g>
          ))}
          {/* X-axis labels */}
          {xLabels.map((x, i) => (
            <text key={i} x={toX(x.t)} y={H - 5} textAnchor="middle" fontSize="9" fill="var(--color-label-tertiary)">{x.label}</text>
          ))}
          {/* Data line */}
          <path d={pathD} fill="none" stroke="var(--color-accent)" strokeWidth="1.5" strokeLinejoin="round" />
          {/* Current value */}
          {points.length > 0 && (
            <circle cx={toX(points[points.length - 1].t)} cy={toY(points[points.length - 1].v)} r="3" fill="var(--color-accent)" />
          )}
        </svg>
      )}

      {/* Prediction */}
      {points.length >= 10 && metric === "voltage" && (() => {
        const recent = points.slice(-Math.min(points.length, 50));
        const n = recent.length;
        const sumX = recent.reduce((s, p, i) => s + i, 0);
        const sumY = recent.reduce((s, p) => s + p.v, 0);
        const sumXY = recent.reduce((s, p, i) => s + i * p.v, 0);
        const sumX2 = recent.reduce((s, _, i) => s + i * i, 0);
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const avgInterval = (recent[n - 1].t - recent[0].t) / (n - 1);
        const currentV = recent[n - 1].v;
        const targetV = 3.3;
        if (slope < 0) {
          const stepsToEmpty = (targetV - currentV) / slope;
          const daysLeft = Math.round((stepsToEmpty * avgInterval) / 86400000);
          if (daysLeft > 0 && daysLeft < 365) {
            return (
              <div className="mt-3 p-2 bg-accent-soft text-label rounded text-sm flex items-center gap-2">
                <TrendingDown size={16} aria-hidden="true" className="text-accent shrink-0" />
                <span>{t("prediction", { days: daysLeft })}</span>
              </div>
            );
          }
        }
        return null;
      })()}
    </Modal>
  );
}
