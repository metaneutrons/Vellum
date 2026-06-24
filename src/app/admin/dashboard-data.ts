// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Server-side aggregation for the admin overview dashboard.
 *
 * SSOT: every metric is derived here from the database + firmware manifest, so
 * the dashboard widgets stay pure presentational components fed real data. The
 * fleet thresholds mirror the device table (online ≤ 1h, low battery < 20%,
 * weak signal < −70 dBm) so the two screens never disagree.
 */
import { sql } from "drizzle-orm";
import { db, withDb } from "@/db";
import {
  getAvailableVersions,
  getAllContentInstances,
  getAllProviders,
  getAllThemes,
  getAllRefreshProfiles,
} from "./actions";
import { compareSemver } from "@/lib/firmware";
import { parseDeviceTs } from "./dashboard/ts";

const ONLINE_WINDOW_MS = 3600_000; // online if last seen within the hour
const LOW_BATTERY_PCT = 20;
const WEAK_SIGNAL_DBM = -70;
const CHECKIN_DAYS = 14;

interface DeviceRow {
  mac: string;
  status: string;
  content_instance_id: string | null;
  last_seen: string | null;
  battery_level: number | null;
  battery_voltage: number | null;
  wifi_rssi: number | null;
  firmware_version: string | null;
}

export type AttentionReason = "offline" | "lowBattery" | "weakSignal" | "noContent";

export interface AttentionDevice {
  mac: string;
  reasons: AttentionReason[];
  batteryLevel: number | null;
  wifiRssi: number | null;
  lastSeen: string | null;
  severity: number;
}

export interface RecentDevice {
  mac: string;
  status: string;
  lastSeen: string | null;
  batteryLevel: number | null;
  wifiRssi: number | null;
  online: boolean;
}

export interface DashboardData {
  fleet: {
    total: number;
    approved: number;
    pending: number;
    rejected: number;
    online: number;
    offline: number;
    lowBattery: number;
    weakSignal: number;
    withContent: number;
    noContent: number;
    avgBattery: number | null;
  };
  attention: AttentionDevice[];
  recent: RecentDevice[];
  firmware: {
    latestStable: string | null;
    latestBeta: string | null;
    upToDate: number;
    behind: number;
    unknown: number;
    byVersion: { version: string; count: number }[];
  };
  checkins: { day: string; count: number }[];
  reports: { mac: string; issue: string | null; timestamp: string }[];
  catalog: {
    contentInstances: number;
    providers: number;
    providersByType: { type: string; count: number }[];
    themes: number;
    profiles: number;
  };
  generatedAt: string;
}

function isOnline(lastSeen: string | null, now: number): boolean {
  const ms = parseDeviceTs(lastSeen);
  return ms !== null && now - ms < ONLINE_WINDOW_MS;
}

/** Continuous CHECKIN_DAYS window (zero-filled) so the activity chart never has gaps. */
function fillCheckins(rows: { day: string; count: number }[], now: number): { day: string; count: number }[] {
  const byDay = new Map(rows.map((r) => [r.day, Number(r.count)]));
  const out: { day: string; count: number }[] = [];
  for (let i = CHECKIN_DAYS - 1; i >= 0; i--) {
    const d = new Date(now - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: key, count: byDay.get(key) ?? 0 });
  }
  return out;
}

const EMPTY: DashboardData = {
  fleet: { total: 0, approved: 0, pending: 0, rejected: 0, online: 0, offline: 0, lowBattery: 0, weakSignal: 0, withContent: 0, noContent: 0, avgBattery: null },
  attention: [],
  recent: [],
  firmware: { latestStable: null, latestBeta: null, upToDate: 0, behind: 0, unknown: 0, byVersion: [] },
  checkins: [],
  reports: [],
  catalog: { contentInstances: 0, providers: 0, providersByType: [], themes: 0, profiles: 0 },
  generatedAt: new Date().toISOString(),
};

export async function getDashboardData(): Promise<DashboardData> {
  const now = Date.now();

  let deviceRows: DeviceRow[] = [];
  let checkinRows: { day: string; count: number }[] = [];
  let reportRows: { mac: string; issue: string | null; timestamp: string }[] = [];
  let versions: { version: string; channel: string }[] = [];
  let content: unknown[] = [];
  let providers: { type: string }[] = [];
  let themes: unknown[] = [];
  let profiles: unknown[] = [];

  try {
    [deviceRows, checkinRows, reportRows, versions, content, providers, themes, profiles] = await Promise.all([
      withDb(() => db.execute(sql`
        SELECT d.mac, d.status, d.content_instance_id, d.last_seen,
               t.battery_level, t.battery_voltage, t.wifi_rssi, t.firmware_version
        FROM devices d
        LEFT JOIN LATERAL (
          SELECT battery_level, battery_voltage, wifi_rssi, firmware_version
          FROM telemetry WHERE mac = d.mac ORDER BY timestamp DESC LIMIT 1
        ) t ON true
        ORDER BY d.last_seen DESC NULLS LAST
      `), "dashboard-devices").then((r) => r.rows as unknown as DeviceRow[]),
      withDb(() => db.execute(sql`
        SELECT to_char(date_trunc('day', timestamp), 'YYYY-MM-DD') AS day, count(*)::int AS count
        FROM telemetry
        WHERE timestamp > now() - make_interval(days => ${CHECKIN_DAYS})
        GROUP BY 1 ORDER BY 1
      `), "dashboard-checkins").then((r) => r.rows as unknown as { day: string; count: number }[]),
      withDb(() => db.execute(sql`
        SELECT mac, issue, to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp
        FROM reports ORDER BY timestamp DESC LIMIT 8
      `), "dashboard-reports").then((r) => r.rows as unknown as { mac: string; issue: string | null; timestamp: string }[]),
      getAvailableVersions(),
      getAllContentInstances(),
      getAllProviders(),
      getAllThemes(),
      getAllRefreshProfiles(),
    ]);
  } catch {
    return { ...EMPTY, generatedAt: new Date().toISOString() };
  }

  // ── Fleet ──────────────────────────────────────────────────────
  const approved = deviceRows.filter((d) => d.status === "approved");
  const online = deviceRows.filter((d) => isOnline(d.last_seen, now)).length;
  const batteries = deviceRows.map((d) => d.battery_level).filter((b): b is number => b !== null);
  const avgBattery = batteries.length ? Math.round(batteries.reduce((a, b) => a + b, 0) / batteries.length) : null;
  const withContent = approved.filter((d) => d.content_instance_id).length;

  const fleet = {
    total: deviceRows.length,
    approved: approved.length,
    pending: deviceRows.filter((d) => d.status === "pending").length,
    rejected: deviceRows.filter((d) => d.status === "rejected").length,
    online,
    offline: deviceRows.length - online,
    lowBattery: deviceRows.filter((d) => d.battery_level !== null && d.battery_level < LOW_BATTERY_PCT).length,
    weakSignal: deviceRows.filter((d) => d.wifi_rssi !== null && d.wifi_rssi < WEAK_SIGNAL_DBM).length,
    withContent,
    noContent: approved.length - withContent,
    avgBattery,
  };

  // ── Attention (severity-ranked) ────────────────────────────────
  const SEV: Record<AttentionReason, number> = { offline: 3, lowBattery: 2, weakSignal: 1, noContent: 1 };
  const attention: AttentionDevice[] = deviceRows
    .map((d) => {
      const reasons: AttentionReason[] = [];
      const isApproved = d.status === "approved";
      if (isApproved && !isOnline(d.last_seen, now)) reasons.push("offline");
      if (d.battery_level !== null && d.battery_level < LOW_BATTERY_PCT) reasons.push("lowBattery");
      if (d.wifi_rssi !== null && d.wifi_rssi < WEAK_SIGNAL_DBM) reasons.push("weakSignal");
      if (isApproved && !d.content_instance_id) reasons.push("noContent");
      return {
        mac: d.mac,
        reasons,
        batteryLevel: d.battery_level,
        wifiRssi: d.wifi_rssi,
        lastSeen: d.last_seen,
        severity: reasons.reduce((s, r) => s + SEV[r], 0),
      };
    })
    .filter((d) => d.reasons.length > 0)
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 8);

  // ── Recent check-ins ───────────────────────────────────────────
  const recent: RecentDevice[] = deviceRows.slice(0, 6).map((d) => ({
    mac: d.mac,
    status: d.status,
    lastSeen: d.last_seen,
    batteryLevel: d.battery_level,
    wifiRssi: d.wifi_rssi,
    online: isOnline(d.last_seen, now),
  }));

  // ── Firmware ───────────────────────────────────────────────────
  const latestStable = versions.find((v) => v.channel === "stable")?.version ?? null;
  const latestBeta = versions.find((v) => v.channel === "beta")?.version ?? null;
  let upToDate = 0;
  let behind = 0;
  let unknown = 0;
  const versionCounts = new Map<string, number>();
  for (const d of approved) {
    const v = d.firmware_version;
    if (!v) { unknown++; continue; }
    versionCounts.set(v, (versionCounts.get(v) ?? 0) + 1);
    if (latestStable && compareSemver(v, latestStable) >= 0) upToDate++;
    else behind++;
  }
  const byVersion = [...versionCounts.entries()]
    .map(([version, count]) => ({ version, count }))
    .sort((a, b) => b.count - a.count || compareSemver(b.version, a.version))
    .slice(0, 5);

  // ── Catalog ────────────────────────────────────────────────────
  const providersByType = [...providers.reduce((m, p) => m.set(p.type, (m.get(p.type) ?? 0) + 1), new Map<string, number>()).entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  return {
    fleet,
    attention,
    recent,
    firmware: { latestStable, latestBeta, upToDate, behind, unknown, byVersion },
    checkins: fillCheckins(checkinRows, now),
    reports: reportRows,
    catalog: {
      contentInstances: content.length,
      providers: providers.length,
      providersByType,
      themes: themes.length,
      profiles: profiles.length,
    },
    generatedAt: new Date().toISOString(),
  };
}
