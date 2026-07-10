// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import {
  pgTable,
  text,
  integer,
  real,
  timestamp,
  serial,
  jsonb,
  uuid,
  boolean,
  customType,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Vellum Database Schema
 *
 * Design principles:
 * - SSOT: types/enums defined in code, not DB. DB stores plain text.
 * - No DB enums: adding a new provider type or status requires no migration.
 * - Config as JSONB: renderer/profile/theme config is opaque to the DB.
 */

/* ── Data Providers ───────────────────────────────────────────── */

export const dataProviders = pgTable("data_providers", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: text("type").notNull(),           /* "microsoft365" | "google" | "ical" — validated in code */
  category: text("category").notNull().default("calendar"),
  name: text("name").notNull(),
  encryptedCredentials: text("encrypted_credentials").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* ── Themes ───────────────────────────────────────────────────── */

export const themes = pgTable(
  "themes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    config: jsonb("config").notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("themes_is_default_idx").on(t.isDefault)],
);

/* ── Content Instances ────────────────────────────────────────── */

export const contentInstances = pgTable("content_instances", {
  id: uuid("id").defaultRandom().primaryKey(),
  typeSlug: text("type_slug").notNull(),  /* renderer slug — validated against registry in code */
  name: text("name").notNull(),
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* ── Refresh Profiles ─────────────────────────────────────────── */

export const refreshProfiles = pgTable("refresh_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* ── Settings (KV store) ──────────────────────────────────────── */

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* ── Devices ──────────────────────────────────────────────────── */

export const devices = pgTable("devices", {
  mac: text("mac").primaryKey(),
  status: text("status").notNull().default("pending"),  /* "pending" | "approved" | "rejected" */
  token: text("token"),
  publicKey: text("public_key"),
  displayCaps: jsonb("display_caps"),
  orientationOverride: text("orientation_override"),  /* null = use device-reported, "portrait" | "landscape" */
  contentInstanceId: uuid("content_instance_id").references(() => contentInstances.id),
  themeId: uuid("theme_id").references(() => themes.id),
  refreshProfileId: uuid("refresh_profile_id").references(() => refreshProfiles.id),
  firmwareChannel: text("firmware_channel").default("stable"),
  firmwarePinVersion: text("firmware_pin_version"),
  approvedAt: timestamp("approved_at"),
  lastSeen: timestamp("last_seen"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* ── Custom column types ───────────────────────────────────────── */

const bytea = customType<{ data: Buffer }>({
  dataType() { return "bytea"; },
  toDriver(value: Buffer) { return value; },
  fromDriver(value: unknown) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    return Buffer.from(value as ArrayBuffer);
  },
});

/* ── Assets (background images, logos) ────────────────────────── */

export const assets = pgTable("assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  mimeType: text("mime_type").notNull(),
  width: integer("width"),
  height: integer("height"),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* ── Telemetry ────────────────────────────────────────────────── */

export const telemetry = pgTable(
  "telemetry",
  {
    id: serial("id").primaryKey(),
    mac: text("mac").notNull().references(() => devices.mac),
    batteryVoltage: real("battery_voltage"),
    batteryLevel: integer("battery_level"),
    wifiRssi: integer("wifi_rssi"),
    firmwareVersion: text("firmware_version"),
    timestamp: timestamp("timestamp").defaultNow().notNull(),
  },
  (t) => [
    // battery-history queries filter by mac and order by timestamp
    index("telemetry_mac_timestamp_idx").on(t.mac, t.timestamp),
    // telemetry-cleanup deletes by timestamp across all devices
    index("telemetry_timestamp_idx").on(t.timestamp),
  ],
);

/* ── Reports ──────────────────────────────────────────────────── */

export const reports = pgTable("reports", {
  id: serial("id").primaryKey(),
  mac: text("mac").notNull().references(() => devices.mac),
  issue: text("issue"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

/* ── OTA events ───────────────────────────────────────────────────
 * Per-device OTA outcome reports. Powers (a) fleet OTA observability and
 * (b) the per-device failure blocklist that breaks the brick-retry loop:
 * a device that rolls back to its old firmware would otherwise re-report the
 * old version and be re-offered the exact same bad image forever. `phase` is
 * plain text (SSOT enum in code): "downloading" | "verify_ok" | "verify_fail"
 * | "applied" | "boot_confirmed" | "rolled_back" | "deferred".
 * ─────────────────────────────────────────────────────────────── */
export const otaEvents = pgTable(
  "ota_events",
  {
    id: serial("id").primaryKey(),
    mac: text("mac").notNull().references(() => devices.mac),
    model: text("model"),
    fromVersion: text("from_version"),
    toVersion: text("to_version"),
    phase: text("phase").notNull(),
    errorCode: text("error_code"),
    timestamp: timestamp("timestamp").defaultNow().notNull(),
  },
  (t) => [
    // Blocklist lookup: "has this device already failed this target?"
    index("ota_events_mac_to_version_idx").on(t.mac, t.toVersion),
    // Rollout dashboard: recent events / failure-rate windows.
    index("ota_events_timestamp_idx").on(t.timestamp),
  ],
);

/* ── Firmware rollouts ─────────────────────────────────────────────
 * Per-(version, channel) rollout control. The ROLLOUT, not "the newest
 * artifact", decides what ships — so publishing never auto-ships to 100% and a
 * bad release is one `halted` away from stopping fleet-wide.
 * `state` (SSOT enum in code): "paused" | "canary" | "percent" | "full" |
 * "halted". `percent` (0-100) applies in the "percent"/"canary" states via a
 * deterministic device-MAC hash so a device stays in its cohort across polls.
 * A version with NO row falls back to the `firmware.rolloutDefault` setting.
 * ─────────────────────────────────────────────────────────────── */
export const firmwareRollouts = pgTable(
  "firmware_rollouts",
  {
    id: serial("id").primaryKey(),
    version: text("version").notNull(),
    channel: text("channel").notNull(),
    state: text("state").notNull().default("full"),
    percent: integer("percent").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // One rollout row per (version, channel) — enables a clean upsert.
    uniqueIndex("firmware_rollouts_version_channel_idx").on(t.version, t.channel),
  ],
);
