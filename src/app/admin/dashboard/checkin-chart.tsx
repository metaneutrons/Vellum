// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use client";

import { useId } from "react";
import { Activity } from "lucide-react";
import { DashCard } from "./card";

interface Checkin {
  day: string;
  count: number;
}

/**
 * Gradient area chart of device check-ins over the last 14 days.
 *
 * `checkins` is zero-filled and ordered oldest→newest by the server data layer,
 * so we can plot the points directly. All figures are real counts — the empty
 * case (no telemetry at all) falls back to a flat baseline plus a friendly hint.
 */
export function CheckinChart({ checkins }: { checkins: Checkin[] }) {
  // SVG geometry — generous inner padding leaves room for axis labels.
  const W = 600;
  const H = 200;
  const PAD_L = 12;
  const PAD_R = 12;
  const PAD_T = 16;
  const PAD_B = 26;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const gradientId = useId();

  const points = checkins;
  const n = points.length;

  const counts = points.map((p) => p.count);
  const total = counts.reduce((a, b) => a + b, 0);
  const peak = counts.length ? Math.max(...counts) : 0;

  // Scale y to the peak; clamp the divisor so all-zero data never divides by 0.
  const yMax = Math.max(peak, 1);

  // Map a data index / count into SVG coordinates.
  const toX = (i: number) => (n <= 1 ? PAD_L + plotW / 2 : PAD_L + (i / (n - 1)) * plotW);
  const toY = (c: number) => PAD_T + plotH - (c / yMax) * plotH;

  const coords = points.map((p, i) => ({ x: toX(i), y: toY(p.count) }));

  // Build a smooth line through the points with a Catmull-Rom → cubic-Bézier
  // conversion, keeping the curve gentle (tension factor 6).
  function smoothPath(pts: { x: number; y: number }[]): string {
    if (pts.length === 0) return "";
    if (pts.length === 1) return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] ?? p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return d;
  }

  const linePath = smoothPath(coords);
  // Close the line path down to the baseline to form the filled area.
  const baseline = PAD_T + plotH;
  const areaPath =
    coords.length > 0
      ? `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${baseline.toFixed(1)} L ${coords[0].x.toFixed(1)} ${baseline.toFixed(1)} Z`
      : "";

  // Three faint gridlines at 0 / 50 / 100% of the plot height.
  const gridFractions = [0, 0.5, 1];

  // X-axis labels: roughly every 4th day (and always the last day).
  const labelIdxs: number[] = [];
  for (let i = 0; i < n; i += 4) labelIdxs.push(i);
  if (n > 0 && labelIdxs[labelIdxs.length - 1] !== n - 1) labelIdxs.push(n - 1);

  function formatDay(day: string): string {
    // day is "YYYY-MM-DD" — render as "DD.MM".
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!m) return day;
    return `${m[3]}.${m[2]}`;
  }

  const last = coords[coords.length - 1];
  const hasData = total > 0;

  return (
    <DashCard title="Check-in activity" subtitle="Last 14 days" icon={<Activity size={16} />}>
      {/* Headline stats */}
      <div className="flex items-end gap-8 mb-4">
        <div>
          <div className="text-3xl font-semibold tabular-nums text-label leading-none">{total.toLocaleString()}</div>
          <div className="text-xs text-label-secondary mt-1.5">Total check-ins</div>
        </div>
        <div>
          <div className="text-3xl font-semibold tabular-nums text-label leading-none">{peak.toLocaleString()}</div>
          <div className="text-xs text-label-secondary mt-1.5">Peak / day</div>
        </div>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-44"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Device check-ins over the last ${n} days. Total ${total}, peak ${peak} per day.`}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* Gridlines */}
          {gridFractions.map((f) => {
            const y = PAD_T + plotH * f;
            return (
              <line
                key={f}
                x1={PAD_L}
                y1={y}
                x2={W - PAD_R}
                y2={y}
                stroke="var(--color-separator)"
                strokeWidth="1"
                strokeOpacity="0.4"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {/* Filled gradient area */}
          {hasData && areaPath && <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />}

          {/* Line on top */}
          {hasData && linePath && (
            <path
              d={linePath}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* Last-point dot */}
          {hasData && last && (
            <>
              <circle cx={last.x} cy={last.y} r="5" fill="var(--color-accent)" fillOpacity="0.18" />
              <circle cx={last.x} cy={last.y} r="3" fill="var(--color-accent)" />
            </>
          )}

          {/* X-axis day labels */}
          {n > 0 &&
            labelIdxs.map((i) => {
              const x = toX(i);
              const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
              return (
                <text
                  key={i}
                  x={x}
                  y={H - 8}
                  textAnchor={anchor}
                  className="fill-label-tertiary text-[10px]"
                  fontSize="10"
                >
                  {formatDay(points[i].day)}
                </text>
              );
            })}
        </svg>

        {!hasData && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <div className="text-center">
              <p className="text-[13px] font-medium text-label-secondary">No check-ins yet</p>
              <p className="text-xs text-label-tertiary mt-0.5">Activity will appear once devices report in.</p>
            </div>
          </div>
        )}
      </div>
    </DashCard>
  );
}
