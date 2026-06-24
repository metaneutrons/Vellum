// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/** Shared formatting helpers for the dashboard widgets. */

import { parseDeviceTs } from "@/app/admin/dashboard/ts";

/**
 * Compact relative time ("just now", "5m ago", "3h ago", "2d ago").
 * `now` is passed in (from the data snapshot's generatedAt) so server and
 * client render identically — no hydration mismatch on live timestamps.
 */
export function relativeTime(ts: string | null, now: number): string {
  const ms = parseDeviceTs(ts);
  if (ms === null) return "never";
  const diff = Math.max(0, now - ms);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

/** Last 8 hex chars of a MAC for compact display (full value via title attr). */
export function shortMac(mac: string): string {
  const clean = mac.replace(/[^0-9a-fA-F]/g, "");
  return clean.length > 8 ? clean.slice(-8).toUpperCase() : mac.toUpperCase();
}

/** Tone bucket for a battery percentage. */
export function batteryTone(pct: number | null): "green" | "orange" | "red" | "muted" {
  if (pct === null) return "muted";
  if (pct < 20) return "red";
  if (pct < 40) return "orange";
  return "green";
}

/** Tone bucket for a Wi-Fi RSSI (dBm). */
export function signalTone(rssi: number | null): "green" | "orange" | "red" | "muted" {
  if (rssi === null) return "muted";
  if (rssi < -80) return "red";
  if (rssi < -70) return "orange";
  return "green";
}

export const ATTENTION_LABELS: Record<string, string> = {
  offline: "Offline",
  lowBattery: "Low battery",
  weakSignal: "Weak signal",
  noContent: "No content",
};
