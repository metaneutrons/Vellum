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

export const refreshProfiles = pgTable(
  "refresh_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    config: jsonb("config").notNull(),
    /**
     * The profile a display uses when none is assigned to it explicitly.
     *
     * Deliberately operator-chosen rather than seeded: the device picker has
     * always offered a "Default" option, but it resolved to hard-coded constants
     * in src/lib/sleep, so nobody could see or change what an unconfigured
     * display actually did. At most one row may hold this — enforced by a partial
     * unique index (drizzle/0011), which makes "two defaults" unrepresentable
     * rather than something application code has to remember.
     */
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("refresh_profiles_is_default_idx").on(t.isDefault)],
);

/* ── Settings (KV store) ──────────────────────────────────────── */

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* ── Enterprise identity & access ─────────────────────────────── */

/**
 * Human identities are deliberately separate from device credentials.  The
 * initial ADMIN_USER is migrated lazily into the first owner on successful
 * login; afterwards all access is represented here.
 */
export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash"),
    status: text("status").notNull().default("active"), // active | invited | suspended
    mfaRequired: boolean("mfa_required").notNull().default(false),
    mfaEnrolledAt: timestamp("mfa_enrolled_at"),
    lastLoginAt: timestamp("last_login_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("admin_users_email_ci_idx").on(t.email)],
);

/** System roles are seeded in code; custom roles use the same permission rows. */
export const accessRoles = pgTable("access_roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: serial("id").primaryKey(),
    roleId: text("role_id").notNull().references(() => accessRoles.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
  },
  (t) => [uniqueIndex("role_permissions_role_permission_idx").on(t.roleId, t.permission)],
);

/** A role can be global (workspace) or restricted to a future site/fleet/device scope. */
export const userRoleAssignments = pgTable(
  "user_role_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => adminUsers.id, { onDelete: "cascade" }),
    roleId: text("role_id").notNull().references(() => accessRoles.id, { onDelete: "restrict" }),
    scopeType: text("scope_type").notNull().default("workspace"),
    scopeId: text("scope_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("user_role_assignments_user_idx").on(t.userId)],
);

/** Opaque, revocable server-side sessions. Only a SHA-256 token digest is stored. */
export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => adminUsers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("admin_sessions_token_hash_idx").on(t.tokenHash), index("admin_sessions_user_idx").on(t.userId)],
);

export const adminInvitations = pgTable(
  "admin_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    tokenHash: text("token_hash").notNull(),
    roleId: text("role_id").notNull().references(() => accessRoles.id, { onDelete: "restrict" }),
    scopeType: text("scope_type").notNull().default("workspace"),
    scopeId: text("scope_id"),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    createdBy: uuid("created_by").references(() => adminUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("admin_invitations_token_hash_idx").on(t.tokenHash), index("admin_invitations_email_idx").on(t.email)],
);

/** Immutable, issuer-bound SSO identities. Email is metadata, never the key. */
export const oidcIdentities = pgTable(
  "oidc_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => adminUsers.id, { onDelete: "cascade" }),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    tenantId: text("tenant_id").notNull(),
    email: text("email").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    lastLoginAt: timestamp("last_login_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("oidc_identities_issuer_subject_idx").on(t.issuer, t.subject), index("oidc_identities_user_idx").on(t.userId)],
);

/** Non-human automation identities replace the global ADMIN_API_KEY over time. */
export const serviceAccounts = pgTable(
  "service_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("active"),
    expiresAt: timestamp("expires_at"),
    lastUsedAt: timestamp("last_used_at"),
    createdBy: uuid("created_by").references(() => adminUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("service_accounts_token_hash_idx").on(t.tokenHash)],
);

export const serviceAccountPermissions = pgTable(
  "service_account_permissions",
  {
    id: serial("id").primaryKey(),
    serviceAccountId: uuid("service_account_id").notNull().references(() => serviceAccounts.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    scopeType: text("scope_type").notNull().default("workspace"),
    scopeId: text("scope_id"),
  },
  (t) => [index("service_account_permissions_account_idx").on(t.serviceAccountId)],
);

/** Append-only security record. Secret material is intentionally never stored here. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    actorType: text("actor_type").notNull(), // user | service_account | bootstrap
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    scopeType: text("scope_type").notNull().default("workspace"),
    scopeId: text("scope_id"),
    outcome: text("outcome").notNull().default("success"),
    metadata: jsonb("metadata").notNull().default({}),
    ip: text("ip"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("audit_logs_created_at_idx").on(t.createdAt), index("audit_logs_actor_idx").on(t.actorId)],
);

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
  /* Expected check-in cadence (seconds) — the sleep interval last handed to the
   * device by the render route. Lets the admin UI judge connectivity relative
   * to the device's own schedule instead of a fixed window. Null until the
   * device has rendered once (connectivity falls back to a default). */
  expectedIntervalS: integer("expected_interval_s"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/**
 * Pre-provisioning vouchers for zero-touch USB enrolment. An admin mints a
 * voucher (a device token) and pushes it into a device profile over USB; the
 * first device to present that token on an authenticated request claims the
 * voucher and is auto-approved — no manual "pending → approve" step. The `token`
 * IS the device token. A voucher is single-use (bound to the first MAC).
 */
export const provisioningVouchers = pgTable("provisioning_vouchers", {
  token: text("token").primaryKey(),
  label: text("label"),
  claimedByMac: text("claimed_by_mac"),
  claimedAt: timestamp("claimed_at"),
  // A voucher stops being claimable after this instant. Limits the blast radius
  // of a leaked-but-unclaimed voucher to the validity window. NULL = never
  // expires (back-compat for rows minted before this column existed).
  expiresAt: timestamp("expires_at"),
  // Optional desired release selected in the flash flow. These are applied only
  // when this single-use voucher is claimed, binding the pin to the enrolled MAC.
  firmwareChannel: text("firmware_channel"),
  firmwarePinVersion: text("firmware_pin_version"),
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
