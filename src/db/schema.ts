import {
  pgTable,
  text,
  integer,
  real,
  timestamp,
  serial,
  pgEnum,
  jsonb,
  uuid,
  boolean,
} from "drizzle-orm/pg-core";

/* ── Enums ────────────────────────────────────────────────────── */

export const deviceStatusEnum = pgEnum("device_status", [
  "pending",
  "approved",
  "rejected",
]);

export const roomPolicyEnum = pgEnum("room_policy", [
  "Show All",
  "Hide Subject",
  "Hide All",
]);

export const dataProviderTypeEnum = pgEnum("data_provider_type", [
  "microsoft365",
  "google",
  "ical",
]);

/* ── Data Providers ───────────────────────────────────────────── */

export const dataProviders = pgTable("data_providers", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: dataProviderTypeEnum("type").notNull(),
  category: text("category").notNull().default("calendar"),
  name: text("name").notNull(),
  /** AES-256-GCM encrypted JSONB — never exposed in API responses */
  encryptedCredentials: text("encrypted_credentials").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* ── Themes ───────────────────────────────────────────────────── */

export const themes = pgTable("themes", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  /** Theme color config — matches Theme interface in theme.ts */
  config: jsonb("config").notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* ── Content Types (renderer registry in DB) ──────────────────── */

export const contentTypes = pgTable("content_types", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
});

/* ── Content Instances ────────────────────────────────────────── */

export const contentInstances = pgTable("content_instances", {
  id: uuid("id").defaultRandom().primaryKey(),
  typeSlug: text("type_slug")
    .notNull()
    .references(() => contentTypes.slug),
  name: text("name").notNull(),
  /** Renderer-specific config (provider ref, room email, etc.) */
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* ── Refresh Profiles ──────────────────────────────────────────── */

export const refreshProfiles = pgTable("refresh_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* ── Settings (KV store) ───────────────────────────────────────── */

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* ── Devices ──────────────────────────────────────────────────── */

export const devices = pgTable("devices", {
  mac: text("mac").primaryKey(),
  status: deviceStatusEnum("status").notNull().default("pending"),
  token: text("token"),
  publicKey: text("public_key"),
  displayCaps: jsonb("display_caps"),
  contentInstanceId: uuid("content_instance_id").references(() => contentInstances.id),
  themeId: uuid("theme_id").references(() => themes.id),
  refreshProfileId: uuid("refresh_profile_id").references(() => refreshProfiles.id),
  firmwareChannel: text("firmware_channel").default("stable"),
  firmwarePinVersion: text("firmware_pin_version"),
  approvedAt: timestamp("approved_at"),
  lastSeen: timestamp("last_seen"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* ── Telemetry ────────────────────────────────────────────────── */

export const telemetry = pgTable("telemetry", {
  id: serial("id").primaryKey(),
  mac: text("mac")
    .notNull()
    .references(() => devices.mac),
  batteryVoltage: real("battery_voltage"),
  batteryLevel: integer("battery_level"),
  wifiRssi: integer("wifi_rssi"),
  firmwareVersion: text("firmware_version"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});

/* ── Reports ──────────────────────────────────────────────────── */

export const reports = pgTable("reports", {
  id: serial("id").primaryKey(),
  mac: text("mac")
    .notNull()
    .references(() => devices.mac),
  issue: text("issue"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
});
