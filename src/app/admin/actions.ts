// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isUsableTimezone } from "@/lib/settings/device-settings";
import { db, withDbRead, type DbTransaction } from "@/db";
import { safeFetch } from "@/lib/safe-fetch";
import {
  devices,
  sites,
  themes,
  dataProviders,
  contentInstances,
  refreshProfiles,
  firmwareRollouts,
  otaEvents,
  provisioningVouchers,
  deviceConfigurationCommands,
} from "@/db/schema";
import { OTA_FAILED_PHASES, type RolloutState } from "@/lib/rollout";
import { encryptCredentials, decryptCredentials } from "@/lib/encryption";
import { log } from "@/lib/logger";
import { randomBytes } from "node:crypto";
import {
  requirePermission,
  type AuditEvent,
  type Permission,
  withAuditedTransaction,
} from "@/lib/access";
import {
  normalizeProvisioningMac,
  signUsbProvisioningAuthorization,
} from "@/lib/provisioning/usb-authorization";
import {
  serverMigrationPayloadSchema,
  orientationInputSchema,
  wifiConfigurationInputSchema,
} from "@/lib/provisioning/remote-configuration";
import { unifiedRefreshProfileSchema, upgradeRefreshProfileConfig } from "@/lib/sleep";

/** Central RBAC guard for every server action. */
async function requireAdmin(permission: Permission) {
  return requirePermission(permission);
}

/* ── Devices ──────────────────────────────────────────────────── */

export async function approveDevice(mac: string) {
  const actor = await requireAdmin("devices.approve");
  try {
    const token = randomBytes(32).toString("hex");
    await withAuditedTransaction(
      actor,
      { action: "device.approve", targetType: "device", targetId: mac },
      async (tx) => {
        const updated = await tx
          .update(devices)
          .set({ status: "approved", token, approvedAt: new Date() })
          .where(eq(devices.mac, mac))
          .returning({ mac: devices.mac });
        if (updated.length === 0) throw new Error("device_not_found");
      },
      "approve-device"
    );
    revalidatePath("/admin/devices");
  } catch (err) {
    log.error("Failed to approve device", { mac, error: String(err) });
    throw err;
  }
}

/** Default voucher validity window: a voucher unclaimed after this is dead. */
const VOUCHER_TTL_HOURS = 24 * 7;

/**
 * Mint a single-use pre-provisioning voucher (a device token) for zero-touch
 * USB enrolment. The returned token is embedded in the device profile over USB;
 * the first device to present it is auto-approved. The voucher expires after
 * `ttlHours` (default 7 days) so a leaked-but-unclaimed token cannot be redeemed
 * indefinitely. Admin-session guarded.
 */
export async function createProvisioningVoucher(
  label: string,
  firmware?: { channel: "stable" | "beta"; version: string },
  ttlHours: number = VOUCHER_TTL_HOURS
): Promise<string> {
  const actor = await requireAdmin("devices.provision");
  if (firmware) {
    const { getManifestsByChannel } = await import("@/lib/firmware");
    const versions = await getManifestsByChannel(firmware.channel);
    if (!versions.some((candidate) => candidate.version === firmware.version)) {
      throw new Error("firmware_version_unavailable");
    }
  }
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await withAuditedTransaction(
    actor,
    {
      action: "device.voucher.create",
      targetType: "provisioning_voucher",
      metadata: {
        label: label.trim(),
        expiresAt: expiresAt.toISOString(),
        firmwareChannel: firmware?.channel,
        firmwarePinVersion: firmware?.version,
      },
    },
    (tx) =>
      tx.insert(provisioningVouchers).values({
        token,
        label: label.trim() || null,
        expiresAt,
        firmwareChannel: firmware?.channel,
        firmwarePinVersion: firmware?.version,
      }),
    "create-voucher"
  );
  revalidatePath("/admin/devices");
  return token;
}

/**
 * Authorize one exact USB configuration change on an already enrolled device.
 * The device supplied challenge is single-use and expires in firmware after two
 * minutes; the HMAC is additionally bound to the MAC and SHA-256 of the exact
 * Improv WIFI_SETTINGS payload. No reusable device secret reaches the browser.
 */
export async function createUsbProvisioningAuthorization(input: {
  mac: string;
  challenge: string;
  payloadDigest: string;
}): Promise<string> {
  const actor = await requireAdmin("devices.provision");
  const mac = normalizeProvisioningMac(input.mac);

  return withAuditedTransaction(
    actor,
    {
      action: "device.usb_provision.authorize",
      targetType: "device",
      targetId: mac,
      metadata: {
        authorizationProtocol: "usb-provision-v1",
      },
    },
    async (tx) => {
      const rows = await tx
        .select({ status: devices.status, token: devices.token })
        .from(devices)
        .where(eq(devices.mac, mac))
        .limit(1);
      const device = rows[0];
      if (!device || device.status !== "approved" || !device.token) {
        throw new Error("device_not_authorizable");
      }
      return signUsbProvisioningAuthorization({
        deviceToken: device.token,
        mac,
        challenge: input.challenge,
        payloadDigest: input.payloadDigest,
      });
    },
    "authorize-usb-provisioning",
    "repeatable read"
  );
}

/**
 * Queue a durable server migration. A newer command supersedes an older active
 * command atomically; the device will validate the target Vellum endpoint over
 * TLS with its own identity before committing the change.
 */
export async function queueDeviceServerMigration(macInput: string, serverUrlInput: string) {
  const actor = await requireAdmin("devices.provision");
  const mac = normalizeProvisioningMac(macInput);
  const { serverUrl } = serverMigrationPayloadSchema.parse({ serverUrl: serverUrlInput });

  const command = await withAuditedTransaction(
    actor,
    (created: { id: string }) => ({
      action: "device.configuration.server_migration.queue",
      targetType: "device",
      targetId: mac,
      metadata: { commandId: created.id, serverUrl },
    }),
    async (tx) => {
      const existing = await tx
        .select({ status: devices.status, token: devices.token })
        .from(devices)
        .where(eq(devices.mac, mac))
        .limit(1);
      if (existing[0]?.status !== "approved" || !existing[0].token) {
        throw new Error("device_not_authorizable");
      }

      const applying = await tx
        .select({ id: deviceConfigurationCommands.id })
        .from(deviceConfigurationCommands)
        .where(
          and(
            eq(deviceConfigurationCommands.mac, mac),
            eq(deviceConfigurationCommands.status, "applying")
          )
        )
        .limit(1);
      if (applying.length > 0) throw new Error("configuration_command_applying");

      await tx
        .update(deviceConfigurationCommands)
        .set({ status: "superseded", completedAt: new Date() })
        .where(
          and(
            eq(deviceConfigurationCommands.mac, mac),
            inArray(deviceConfigurationCommands.status, ["pending", "delivered"])
          )
        );
      const rows = await tx
        .insert(deviceConfigurationCommands)
        .values({
          mac,
          kind: "server_url",
          payload: { serverUrl },
          createdBy: actor.type === "user" ? actor.id : null,
        })
        .returning({ id: deviceConfigurationCommands.id });
      return rows[0];
    },
    "queue-device-server-migration",
    "serializable"
  );
  revalidatePath(`/admin/devices/${mac}`);
  return command;
}

/**
 * Raise or lower one device's diagnostics verbosity.
 *
 * Off by default and per device on purpose. A fleet that reports every line is a
 * fleet whose logs nobody reads, so devices report warnings and errors with a
 * window of context around them, and an operator turns a single display chatty
 * only while actually debugging it.
 */

/**
 * Set or clear one display's brightness.
 *
 * null means "follow the profile"; 0 is a legitimate value that turns the
 * backlight off, which is why the two cannot share a representation. Refused for
 * a panel that reports no backlight, so the UI and the server agree rather than
 * the UI hiding a control the server would still accept.
 */
export async function setDeviceBacklight(macInput: string, percent: number | null) {
  const actor = await requireAdmin("devices.provision");
  const mac = normalizeProvisioningMac(macInput);
  const value = percent === null ? null : z.number().int().min(0).max(100).parse(percent);

  await withAuditedTransaction(
    actor,
    {
      action: "device.backlight.set",
      targetType: "device",
      targetId: mac,
      metadata: { percent: value },
    },
    async (tx) => {
      const existing = await tx
        .select({ caps: devices.displayCaps })
        .from(devices)
        .where(eq(devices.mac, mac))
        .limit(1);
      const caps = existing[0]?.caps as { backlight?: boolean } | null;
      if (value !== null && !caps?.backlight) throw new Error("panel_has_no_backlight");
      await tx.update(devices).set({ backlightPercent: value }).where(eq(devices.mac, mac));
      return { id: mac };
    },
    "set-device-backlight",
    "serializable"
  );
  revalidatePath(`/admin/devices/${mac}`);
}

export async function setDeviceLogVerbose(macInput: string, verbose: boolean) {
  const actor = await requireAdmin("devices.provision");
  const mac = normalizeProvisioningMac(macInput);
  await withAuditedTransaction(
    actor,
    () => ({
      action: "device.diagnostics.verbosity",
      targetType: "device",
      targetId: mac,
      metadata: { verbose },
    }),
    async (tx) => {
      await tx.update(devices).set({ logVerbose: verbose }).where(eq(devices.mac, mac));
      return { id: mac };
    },
    "set-device-log-verbose"
  );
  revalidatePath(`/admin/devices/${mac}`);
}

/**
 * Queue a mounting change, and record it as the operator's decision.
 *
 * Orientation describes how the panel hangs on the wall, so it has to reach the
 * device: previously it lived only in devices.orientation_override, the server
 * swapped the rendered geometry, and the firmware's surface stayed as built. A
 * portrait D1001 therefore lost 480px off the bottom of every frame.
 *
 * orientation_override is still written, because it is what the renderer reads
 * until the device confirms and re-reports its surface. The device applies the
 * change at its next boot, since the display adapter's rotation is fixed at init.
 */
export async function queueDeviceOrientation(macInput: string, orientationInput: string) {
  const actor = await requireAdmin("devices.provision");
  const mac = normalizeProvisioningMac(macInput);
  const orientation = orientationInputSchema.parse(orientationInput);

  const command = await withAuditedTransaction(
    actor,
    (created: { id: string }) => ({
      action: "device.configuration.orientation.queue",
      targetType: "device",
      targetId: mac,
      metadata: { commandId: created.id, orientation },
    }),
    async (tx) => {
      const existing = await tx
        .select({ status: devices.status, token: devices.token, caps: devices.displayCaps })
        .from(devices)
        .where(eq(devices.mac, mac))
        .limit(1);
      if (existing[0]?.status !== "approved" || !existing[0].token) {
        throw new Error("device_not_authorizable");
      }
      /* Refuse a mounting the panel says it cannot deliver, rather than queueing a
       * command the device will reject. Firmware predating the capability report
       * lists nothing, and is trusted to know its own panel. */
      const supported = (existing[0].caps as { orientations?: string[] } | null)?.orientations;
      if (supported?.length && !supported.includes(orientation)) {
        throw new Error("orientation_not_supported");
      }

      const applying = await tx
        .select({ id: deviceConfigurationCommands.id })
        .from(deviceConfigurationCommands)
        .where(
          and(
            eq(deviceConfigurationCommands.mac, mac),
            eq(deviceConfigurationCommands.status, "applying")
          )
        )
        .limit(1);
      if (applying.length > 0) throw new Error("configuration_command_applying");

      await tx
        .update(deviceConfigurationCommands)
        .set({ status: "superseded", completedAt: new Date() })
        .where(
          and(
            eq(deviceConfigurationCommands.mac, mac),
            inArray(deviceConfigurationCommands.status, ["pending", "delivered"])
          )
        );
      await tx
        .update(devices)
        .set({ orientationOverride: orientation })
        .where(eq(devices.mac, mac));
      const rows = await tx
        .insert(deviceConfigurationCommands)
        .values({
          mac,
          kind: "orientation",
          payload: { orientation },
          createdBy: actor.type === "user" ? actor.id : null,
        })
        .returning({ id: deviceConfigurationCommands.id });
      return rows[0];
    },
    "queue-device-orientation",
    "serializable"
  );
  revalidatePath(`/admin/devices/${mac}`);
  revalidatePath("/admin/devices");
  return command;
}

/** Queue an authenticated Wi-Fi rotation without exposing its PSK to history or audit logs. */
export async function queueDeviceWifiConfiguration(
  macInput: string,
  ssidInput: string,
  passwordInput: string
) {
  const actor = await requireAdmin("devices.provision");
  const mac = normalizeProvisioningMac(macInput);
  const { ssid, password } = wifiConfigurationInputSchema.parse({
    ssid: ssidInput,
    password: passwordInput,
  });
  const encryptedPassword = encryptCredentials({ password });

  const command = await withAuditedTransaction(
    actor,
    (created: { id: string }) => ({
      action: "device.configuration.wifi.queue",
      targetType: "device",
      targetId: mac,
      metadata: { commandId: created.id, ssid },
    }),
    async (tx) => {
      const [device] = await tx
        .select({ status: devices.status, token: devices.token })
        .from(devices)
        .where(eq(devices.mac, mac))
        .limit(1);
      if (device?.status !== "approved" || !device.token) {
        throw new Error("device_not_authorizable");
      }
      const applying = await tx
        .select({ id: deviceConfigurationCommands.id })
        .from(deviceConfigurationCommands)
        .where(
          and(
            eq(deviceConfigurationCommands.mac, mac),
            eq(deviceConfigurationCommands.status, "applying")
          )
        )
        .limit(1);
      if (applying.length > 0) throw new Error("configuration_command_applying");

      await tx
        .update(deviceConfigurationCommands)
        .set({ status: "superseded", completedAt: new Date() })
        .where(
          and(
            eq(deviceConfigurationCommands.mac, mac),
            inArray(deviceConfigurationCommands.status, ["pending", "delivered"])
          )
        );
      const [created] = await tx
        .insert(deviceConfigurationCommands)
        .values({
          mac,
          kind: "wifi",
          payload: { ssid, encryptedPassword },
          createdBy: actor.type === "user" ? actor.id : null,
        })
        .returning({ id: deviceConfigurationCommands.id });
      return created;
    },
    "queue-device-wifi-configuration",
    "serializable"
  );
  revalidatePath(`/admin/devices/${mac}`);
  return command;
}

export async function cancelDeviceConfigurationCommand(macInput: string, commandId: string) {
  const actor = await requireAdmin("devices.provision");
  const mac = normalizeProvisioningMac(macInput);
  if (!/^[0-9a-f-]{36}$/i.test(commandId)) throw new Error("invalid_configuration_command_id");

  await withAuditedTransaction(
    actor,
    {
      action: "device.configuration.cancel",
      targetType: "device",
      targetId: mac,
      metadata: { commandId },
    },
    async (tx) => {
      const rows = await tx
        .update(deviceConfigurationCommands)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(
          and(
            eq(deviceConfigurationCommands.id, commandId),
            eq(deviceConfigurationCommands.mac, mac),
            inArray(deviceConfigurationCommands.status, ["pending", "delivered"])
          )
        )
        .returning({ id: deviceConfigurationCommands.id });
      if (rows.length === 0) throw new Error("configuration_command_not_active");
    },
    "cancel-device-configuration-command"
  );
  revalidatePath(`/admin/devices/${mac}`);
}

export async function updateDevice(
  mac: string,
  data: {
    label?: string | null;
    contentInstanceId?: string | null;
    themeId?: string | null;
    refreshProfileId?: string | null;
    firmwareChannel?: string | null;
    firmwarePinVersion?: string | null;
    orientationOverride?: string | null;
  }
) {
  const actor = await requireAdmin("devices.manage");
  try {
    await withAuditedTransaction(
      actor,
      {
        action: "device.update",
        targetType: "device",
        targetId: mac,
        metadata: { fields: Object.keys(data) },
      },
      async (tx) => {
        const updated = await tx
          .update(devices)
          .set(data)
          .where(eq(devices.mac, mac))
          .returning({ mac: devices.mac });
        if (updated.length === 0) throw new Error("device_not_found");
      },
      "update-device"
    );
    revalidatePath("/admin/devices");
  } catch (err) {
    log.error("Failed to update device", { mac, error: String(err) });
    throw err;
  }
}

export async function deleteDevice(mac: string) {
  const actor = await requireAdmin("devices.manage");
  try {
    // Device-owned telemetry, reports, and OTA history are removed atomically
    // by their ON DELETE CASCADE constraints. Keeping this as one statement
    // prevents a failed deletion from leaving a half-deleted device history.
    await withAuditedTransaction(
      actor,
      { action: "device.delete", targetType: "device", targetId: mac },
      async (tx) => {
        const deleted = await tx
          .delete(devices)
          .where(eq(devices.mac, mac))
          .returning({ mac: devices.mac });
        if (deleted.length === 0) throw new Error("device_not_found");
      },
      "delete-device"
    );
    revalidatePath("/admin/devices");
  } catch (err) {
    log.error("Failed to delete device", { mac, error: String(err) });
    throw err;
  }
}

/* ── Themes ───────────────────────────────────────────────────── */

export async function createTheme(name: string, config: Record<string, string>) {
  const actor = await requireAdmin("themes.manage");
  await withAuditedTransaction(
    actor,
    (created: { id: string }[]) => ({
      action: "theme.create",
      targetType: "theme",
      targetId: created[0].id,
      metadata: { name },
    }),
    (tx) => tx.insert(themes).values({ name, config }).returning({ id: themes.id }),
    "create-theme"
  );
  revalidatePath("/admin/themes");
}

export async function updateTheme(id: string, name: string, config: Record<string, string>) {
  const actor = await requireAdmin("themes.manage");
  await withAuditedTransaction(
    actor,
    { action: "theme.update", targetType: "theme", targetId: id, metadata: { name } },
    async (tx) => {
      const updated = await tx
        .update(themes)
        .set({ name, config, updatedAt: new Date() })
        .where(eq(themes.id, id))
        .returning({ id: themes.id });
      if (updated.length === 0) throw new Error("theme_not_found");
    },
    "update-theme"
  );
  revalidatePath("/admin/themes");
}

export async function deleteTheme(id: string) {
  const actor = await requireAdmin("themes.manage");
  await withAuditedTransaction(
    actor,
    { action: "theme.delete", targetType: "theme", targetId: id },
    async (tx) => {
      const deleted = await tx.delete(themes).where(eq(themes.id, id)).returning({ id: themes.id });
      if (deleted.length === 0) throw new Error("theme_not_found");
    },
    "delete-theme"
  );
  revalidatePath("/admin/themes");
}

/* ── Calendar Providers ───────────────────────────────────────── */

export async function createProvider(
  type: string,
  name: string,
  credentials: Record<string, string>
) {
  const actor = await requireAdmin("providers.manage");
  try {
    const encrypted = encryptCredentials(credentials);
    await withAuditedTransaction(
      actor,
      (created: { id: string }[]) => ({
        action: "provider.create",
        targetType: "provider",
        targetId: created[0].id,
        metadata: { type, name },
      }),
      (tx) =>
        tx
          .insert(dataProviders)
          .values({ type, name, encryptedCredentials: encrypted })
          .returning({ id: dataProviders.id }),
      "create-provider"
    );
    revalidatePath("/admin/providers");
  } catch (err) {
    log.error("Failed to create provider", { error: String(err) });
    throw err;
  }
}

export async function updateProvider(
  id: string,
  name: string,
  credentials?: Record<string, string>
) {
  const actor = await requireAdmin("providers.manage");
  try {
    const data: Record<string, unknown> = { name, updatedAt: new Date() };
    if (credentials && Object.keys(credentials).length > 0) {
      data.encryptedCredentials = encryptCredentials(credentials);
    }
    await withAuditedTransaction(
      actor,
      {
        action: "provider.update",
        targetType: "provider",
        targetId: id,
        metadata: {
          name,
          credentialsChanged: !!credentials && Object.keys(credentials).length > 0,
        },
      },
      async (tx) => {
        const updated = await tx
          .update(dataProviders)
          .set(data)
          .where(eq(dataProviders.id, id))
          .returning({ id: dataProviders.id });
        if (updated.length === 0) throw new Error("provider_not_found");
      },
      "update-provider"
    );
    revalidatePath("/admin/providers");
  } catch (err) {
    log.error("Failed to update provider", { id, error: String(err) });
    throw err;
  }
}

export async function deleteProvider(id: string) {
  const actor = await requireAdmin("providers.manage");
  await withAuditedTransaction(
    actor,
    { action: "provider.delete", targetType: "provider", targetId: id },
    async (tx) => {
      const deleted = await tx
        .delete(dataProviders)
        .where(eq(dataProviders.id, id))
        .returning({ id: dataProviders.id });
      if (deleted.length === 0) throw new Error("provider_not_found");
    },
    "delete-provider"
  );
  revalidatePath("/admin/providers");
}

/* ── Content Instances ────────────────────────────────────────── */

/**
 * Refuse a content config its own renderer cannot parse.
 *
 * Nothing checked this: the actions stored whatever JSONB they were handed, so a
 * half-filled instance was accepted here and surfaced later as a broken display.
 * The failure landed on a wall instead of in front of the person who caused it.
 *
 * Every instance in the development database satisfies its current schema, so
 * this refuses new mistakes rather than existing data. It is deliberately the
 * SERVER-side gate: a client that forgets a field must not be able to write one.
 *
 * The message names the offending path, which helps in the log. It does not reach
 * the operator, because Next redacts server-action errors in production and the
 * caller shows a generic failure — improving that means returning a typed result
 * instead of throwing, which is a change to every caller's contract.
 */
async function assertValidContentConfig(typeSlug: string, config: unknown): Promise<void> {
  /* Imported lazily, like the other use of the registry further down: it pulls in
   * every renderer and with them canvas and the calendar providers, which the
   * rest of this module has no reason to load. */
  const { getContentRenderer } = await import("@/lib/content/registry");
  const renderer = getContentRenderer(typeSlug);
  if (!renderer) throw new Error(`content_unknown_type: ${typeSlug}`);
  const result = renderer.configSchema.safeParse(config);
  if (result.success) return;
  const issue = result.error.issues[0];
  const where = issue?.path.join(".") || "config";
  throw new Error(`content_invalid_config: ${where}: ${issue?.message ?? "invalid"}`);
}

/**
 * Refuse to create a NEW instance of a retired type.
 *
 * `getAllContentTypes` already leaves those out of the menu, but a hidden option is
 * a suggestion and this is a rule: server actions are a public surface, and the
 * whole point of retiring a type is that the estate stops growing instances of it
 * while the ones that exist keep rendering.
 */
async function assertNotRetired(typeSlug: string): Promise<void> {
  const { getContentRenderer } = await import("@/lib/content/registry");
  if (getContentRenderer(typeSlug)?.deprecated) {
    throw new Error(`content_type_retired: ${typeSlug}`);
  }
}

export async function createContentInstance(
  typeSlug: string,
  name: string,
  config: Record<string, unknown>
) {
  const actor = await requireAdmin("content.manage");
  await assertNotRetired(typeSlug);
  await assertValidContentConfig(typeSlug, config);
  await withAuditedTransaction(
    actor,
    (created: { id: string }[]) => ({
      action: "content.create",
      targetType: "content",
      targetId: created[0].id,
      metadata: { typeSlug, name },
    }),
    (tx) =>
      tx
        .insert(contentInstances)
        .values({ typeSlug, name, config })
        .returning({ id: contentInstances.id }),
    "create-content-instance"
  );
  revalidatePath("/admin/content");
}

export async function updateContentInstance(
  id: string,
  name: string,
  config: Record<string, unknown>
) {
  const actor = await requireAdmin("content.manage");
  await withAuditedTransaction(
    actor,
    { action: "content.update", targetType: "content", targetId: id, metadata: { name } },
    async (tx) => {
      /* The type is not a parameter, so it comes from the row -- which also means
       * a caller cannot validate against a type the instance does not have. */
      const [existing] = await tx
        .select({ typeSlug: contentInstances.typeSlug })
        .from(contentInstances)
        .where(eq(contentInstances.id, id))
        .limit(1);
      if (!existing) throw new Error("content_not_found");
      await assertValidContentConfig(existing.typeSlug, config);

      const updated = await tx
        .update(contentInstances)
        .set({ name, config, updatedAt: new Date() })
        .where(eq(contentInstances.id, id))
        .returning({ id: contentInstances.id });
      if (updated.length === 0) throw new Error("content_not_found");
    },
    "update-content-instance"
  );
  revalidatePath("/admin/content");
}

export async function deleteContentInstance(id: string) {
  const actor = await requireAdmin("content.manage");
  await withAuditedTransaction(
    actor,
    { action: "content.delete", targetType: "content", targetId: id },
    async (tx) => {
      const deleted = await tx
        .delete(contentInstances)
        .where(eq(contentInstances.id, id))
        .returning({ id: contentInstances.id });
      if (deleted.length === 0) throw new Error("content_not_found");
    },
    "delete-content-instance"
  );
  revalidatePath("/admin/content");
}

/* ── Lookups ──────────────────────────────────────────────────── */

export async function getAllDevices() {
  await requireAdmin("devices.read");
  return withDbRead(() => db.select().from(devices).orderBy(devices.createdAt), "get-all-devices");
}

export async function getAllThemes() {
  await requireAdmin("content.read");
  return withDbRead(() => db.select().from(themes).orderBy(themes.name), "get-all-themes");
}

export async function getAllProviders() {
  await requireAdmin("providers.read");
  return withDbRead(
    () =>
      db
        .select({
          id: dataProviders.id,
          type: dataProviders.type,
          name: dataProviders.name,
          createdAt: dataProviders.createdAt,
        })
        .from(dataProviders)
        .orderBy(dataProviders.name),
    "get-all-providers"
  );
}

export async function getProviderCredentials(id: string): Promise<Record<string, string>> {
  await requireAdmin("providers.manage_secrets");
  const [provider] = await withDbRead(
    () =>
      db
        .select({ encrypted: dataProviders.encryptedCredentials })
        .from(dataProviders)
        .where(eq(dataProviders.id, id))
        .limit(1),
    "get-provider-credentials"
  );
  if (!provider) return {};
  try {
    return decryptCredentials(provider.encrypted) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function getAllContentInstances() {
  await requireAdmin("content.read");
  return withDbRead(
    () => db.select().from(contentInstances).orderBy(contentInstances.name),
    "get-all-content-instances"
  );
}

export async function getAllContentTypes() {
  await requireAdmin("content.read");
  const { getAllContentRenderers } = await import("@/lib/content/registry");
  /* Retired types are omitted, which is what takes them out of the "new content"
   * menu. Existing instances of them keep their editor, because that is chosen from
   * the instance's own slug rather than from this list. */
  return getAllContentRenderers()
    .filter((r) => !r.deprecated)
    .map((r) => ({ slug: r.slug, name: r.name }));
}

export async function testDataProvider(id: string): Promise<{ ok: boolean; message: string }> {
  await requireAdmin("providers.manage_secrets");
  const [provider] = await withDbRead(
    () => db.select().from(dataProviders).where(eq(dataProviders.id, id)).limit(1),
    "test-provider-get"
  );
  if (!provider) return { ok: false, message: "Provider not found" };

  try {
    const { decryptCredentials: decrypt } = await import("@/lib/encryption");
    const credentials = decrypt(provider.encryptedCredentials) as Record<string, string>;

    if (provider.type === "microsoft365") {
      // Test: get OAuth token from Microsoft Graph
      const { ConfidentialClientApplication } = await import("@azure/msal-node");
      const cca = new ConfidentialClientApplication({
        auth: {
          clientId: credentials.clientId,
          clientSecret: credentials.clientSecret,
          authority: `https://login.microsoftonline.com/${credentials.tenantId}`,
        },
      });
      const token = await cca.acquireTokenByClientCredential({
        scopes: ["https://graph.microsoft.com/.default"],
      });
      return {
        ok: !!token?.accessToken,
        message: token?.accessToken ? "Connected — token acquired" : "No token returned",
      };
    }

    if (provider.type === "google") {
      // Test: exchange JWT for access token (same as provider does)
      const { createJwt } = await import("@/lib/calendar/providers/google");
      const jwt = createJwt(credentials.clientEmail, credentials.privateKey);
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const t = await res.text();
        return { ok: false, message: `Google auth failed: ${t.slice(0, 100)}` };
      }
      return { ok: true, message: "Connected — token acquired" };
    }

    if (provider.type === "ical") {
      // safeFetch (not raw fetch): the URL comes from stored provider credentials,
      // so it must go through the SSRF guard that blocks private/link-local/loopback
      // targets — otherwise "Test connection" is an authenticated SSRF primitive.
      const res = await safeFetch(credentials.url, { timeoutMs: 10_000 });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status} from iCal URL` };
      const text = await res.text();
      return {
        ok: text.includes("VCALENDAR"),
        message: text.includes("VCALENDAR")
          ? "Connected — valid iCal feed"
          : "Response is not a valid iCal feed",
      };
    }

    if (provider.type === "anny") {
      const { fetchAnnyResources, extractOrgFromToken } =
        await import("@/lib/calendar/providers/anny");
      const orgId = credentials.organizationId || extractOrgFromToken(credentials.apiToken) || "";
      if (!orgId) return { ok: false, message: "Cannot extract organization ID from token" };
      const result = await fetchAnnyResources(credentials.apiToken, orgId);
      return { ok: true, message: `Connected — ${result.total} resources found` };
    }

    return { ok: false, message: `Unknown provider type: ${provider.type}` };
  } catch (err) {
    return { ok: false, message: String(err instanceof Error ? err.message : err) };
  }
}

export async function testContentInstance(id: string): Promise<{ ok: boolean; message: string }> {
  await requireAdmin("content.manage");
  const [instance] = await withDbRead(
    () => db.select().from(contentInstances).where(eq(contentInstances.id, id)).limit(1),
    "test-content-instance-get"
  );
  if (!instance) return { ok: false, message: "Content instance not found" };

  try {
    const { getContentRenderer } = await import("@/lib/content/registry");
    const renderer = getContentRenderer(instance.typeSlug);
    if (!renderer) return { ok: false, message: `Unknown renderer: ${instance.typeSlug}` };

    /* Each renderer parses its own config shape, so what comes back here is
     * only known to be "some renderer's config". The branches below narrow it by
     * type slug before handing it to that renderer's own function. */
    const config: unknown = renderer.configSchema.parse(instance.config);

    if (instance.typeSlug === "room-booking") {
      const { fetchEvents } = await import("@/lib/content/renderers/room-booking");
      const events = await fetchEvents(config as Parameters<typeof fetchEvents>[0]);
      return { ok: true, message: `OK — ${events.length} events today` };
    }

    /* A `door-sign` branch stood here until 2026-08-25. It was not merely unused,
     * it was unreachable: `getContentRenderer` above no longer answers for that
     * slug, so the function returns "Unknown renderer" before reaching this point. */
    return { ok: true, message: "Config valid" };
  } catch (err) {
    return { ok: false, message: String(err instanceof Error ? err.message : err) };
  }
}
/* ── Refresh Profiles ─────────────────────────────────────────── */

export async function getAllRefreshProfiles() {
  await requireAdmin("content.read");
  const rows = await withDbRead(
    () =>
      db
        .select({
          id: refreshProfiles.id,
          name: refreshProfiles.name,
          config: refreshProfiles.config,
          isDefault: refreshProfiles.isDefault,
          revision: refreshProfiles.revision,
          createdAt: refreshProfiles.createdAt,
          updatedAt: refreshProfiles.updatedAt,
          deviceCount: sql<number>`(
            select count(*) from ${devices}
            where ${devices.refreshProfileId} = ${refreshProfiles.id}
          )`,
          siteCount: sql<number>`(
            select count(*) from ${sites}
            where ${sites.refreshProfileId} = ${refreshProfiles.id}
          )`,
        })
        .from(refreshProfiles)
        .orderBy(refreshProfiles.name),
    "get-all-refresh-profiles"
  );
  return rows.map((row) => ({
    ...row,
    deviceCount: Number(row.deviceCount),
    siteCount: Number(row.siteCount),
    config: upgradeRefreshProfileConfig(row.config),
  }));
}

/* ── Sites ─────────────────────────────────────────────────────────
 * A site is a physical location: a timezone plus defaults for the displays in
 * it. Guarded by profiles.manage rather than a new permission, because it is the
 * same class of decision as designing a profile, and inventing a permission
 * nobody has assigned yet would lock every existing operator out of the feature.
 * ─────────────────────────────────────────────────────────────── */

const siteInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine(isUsableTimezone, { message: "unknown timezone" }),
  refreshProfileId: z.uuid().nullish(),
  themeId: z.uuid().nullish(),
  contentInstanceId: z.uuid().nullish(),
});

export async function getAllSites() {
  await requireAdmin("devices.read");
  return withDbRead(() => db.select().from(sites).orderBy(sites.name), "list-sites");
}

export async function createSite(input: unknown) {
  const actor = await requireAdmin("profiles.manage");
  const data = siteInputSchema.parse(input);
  await withAuditedTransaction(
    actor,
    (created: { id: string }[]) => ({
      action: "site.create",
      targetType: "site",
      targetId: created[0].id,
      metadata: { name: data.name, timezone: data.timezone },
    }),
    (tx) =>
      tx
        .insert(sites)
        .values({
          name: data.name,
          timezone: data.timezone,
          refreshProfileId: data.refreshProfileId ?? null,
          themeId: data.themeId ?? null,
          contentInstanceId: data.contentInstanceId ?? null,
        })
        .returning({ id: sites.id }),
    "create-site"
  );
  revalidatePath("/admin/sites");
  revalidatePath("/admin/devices");
}

export async function updateSite(id: string, input: unknown) {
  const actor = await requireAdmin("profiles.manage");
  const data = siteInputSchema.parse(input);
  await withAuditedTransaction(
    actor,
    {
      action: "site.update",
      targetType: "site",
      targetId: id,
      metadata: { name: data.name, timezone: data.timezone },
    },
    (tx) =>
      tx
        .update(sites)
        .set({
          name: data.name,
          timezone: data.timezone,
          refreshProfileId: data.refreshProfileId ?? null,
          themeId: data.themeId ?? null,
          contentInstanceId: data.contentInstanceId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(sites.id, id)),
    "update-site"
  );
  revalidatePath("/admin/sites");
  revalidatePath("/admin/devices");
}

/**
 * Deleting a site does not delete its displays.
 *
 * `devices.site_id` is ON DELETE SET NULL, so they become siteless and fall back
 * to the workspace defaults and the server clock. That is a visible change in
 * behaviour rather than a silent one, which is why the UI names the count.
 */
export async function deleteSite(id: string) {
  const actor = await requireAdmin("profiles.manage");
  await withAuditedTransaction(
    actor,
    { action: "site.delete", targetType: "site", targetId: id, metadata: {} },
    (tx) => tx.delete(sites).where(eq(sites.id, id)),
    "delete-site"
  );
  revalidatePath("/admin/sites");
  revalidatePath("/admin/devices");
}

/** Assign a display to a site, or to none. */
export async function setDeviceSite(macInput: string, siteId: string | null) {
  const actor = await requireAdmin("devices.provision");
  const mac = normalizeProvisioningMac(macInput);
  const target = siteId ? z.uuid().parse(siteId) : null;
  await withAuditedTransaction(
    actor,
    {
      action: "device.site.assign",
      targetType: "device",
      targetId: mac,
      metadata: { siteId: target },
    },
    async (tx) => {
      await tx.update(devices).set({ siteId: target }).where(eq(devices.mac, mac));
      return { id: mac };
    },
    "set-device-site"
  );
  revalidatePath(`/admin/devices/${mac}`);
  revalidatePath("/admin/devices");
}

export async function createRefreshProfile(name: string, config: Record<string, unknown>) {
  const actor = await requireAdmin("profiles.manage");
  const validatedName = z.string().trim().min(1).max(120).parse(name);
  const validatedConfig = unifiedRefreshProfileSchema.parse(config);
  try {
    await withAuditedTransaction(
      actor,
      (created: { id: string }[]) => ({
        action: "profile.create",
        targetType: "refresh_profile",
        targetId: created[0].id,
        metadata: { name: validatedName, config: validatedConfig, revision: 1 },
      }),
      (tx) =>
        tx
          .insert(refreshProfiles)
          .values({ name: validatedName, config: validatedConfig })
          .returning({ id: refreshProfiles.id }),
      "create-refresh-profile"
    );
    revalidatePath("/admin/profiles");
  } catch (err) {
    log.error("Failed to create refresh profile", { error: String(err) });
    throw err;
  }
}

type ProfileUpdateResult = {
  status: "updated" | "conflict";
  before?: { name: string; config: unknown };
  revision?: number;
};

function profileUpdateAudit(
  id: string,
  name: string,
  config: unknown,
  expectedRevision: number,
  result: ProfileUpdateResult
): AuditEvent {
  return {
    action: "profile.update",
    targetType: "refresh_profile",
    targetId: id,
    outcome: result.status === "updated" ? "success" : "failure",
    metadata:
      result.status === "updated"
        ? {
            before: result.before,
            after: { name, config },
            revision: result.revision,
          }
        : { reason: "optimistic_lock_conflict", expectedRevision },
  };
}

async function updateRefreshProfileRecord(
  tx: DbTransaction,
  input: { id: string; name: string; config: unknown; expectedRevision: number }
): Promise<ProfileUpdateResult> {
  const [before] = await tx
    .select({
      name: refreshProfiles.name,
      config: refreshProfiles.config,
      revision: refreshProfiles.revision,
    })
    .from(refreshProfiles)
    .where(eq(refreshProfiles.id, input.id))
    .limit(1);
  if (!before) throw new Error("refresh_profile_not_found");
  if (before.revision !== input.expectedRevision) return { status: "conflict" };

  const updated = await tx
    .update(refreshProfiles)
    .set({
      name: input.name,
      config: input.config,
      updatedAt: new Date(),
      revision: sql`${refreshProfiles.revision} + 1`,
    })
    .where(
      and(eq(refreshProfiles.id, input.id), eq(refreshProfiles.revision, input.expectedRevision))
    )
    .returning({ revision: refreshProfiles.revision });
  if (updated.length === 0) return { status: "conflict" };
  return {
    status: "updated",
    before: { name: before.name, config: before.config },
    revision: updated[0].revision,
  };
}

export async function updateRefreshProfile(
  id: string,
  name: string,
  config: Record<string, unknown>,
  expectedRevision: number
) {
  const actor = await requireAdmin("profiles.manage");
  const validatedId = z.uuid().parse(id);
  const validatedName = z.string().trim().min(1).max(120).parse(name);
  const validatedConfig = unifiedRefreshProfileSchema.parse(config);
  const validatedRevision = z.number().int().positive().parse(expectedRevision);
  try {
    const result = await withAuditedTransaction<ProfileUpdateResult>(
      actor,
      (updateResult) =>
        profileUpdateAudit(
          validatedId,
          validatedName,
          validatedConfig,
          validatedRevision,
          updateResult
        ),
      (tx) =>
        updateRefreshProfileRecord(tx, {
          id: validatedId,
          name: validatedName,
          config: validatedConfig,
          expectedRevision: validatedRevision,
        }),
      "update-refresh-profile",
      "repeatable read"
    );
    if (result.status === "conflict") return { ok: false as const, reason: "conflict" as const };
    revalidatePath("/admin/profiles");
    return { ok: true as const };
  } catch (err) {
    log.error("Failed to update refresh profile", { id, error: String(err) });
    throw err;
  }
}

export async function deleteRefreshProfile(id: string) {
  const actor = await requireAdmin("profiles.manage");
  try {
    await withAuditedTransaction(
      actor,
      (deleted: {
        id: string;
        name: string;
        config: unknown;
        deviceCount: number;
        siteCount: number;
      }) => ({
        action: "profile.delete",
        targetType: "refresh_profile",
        targetId: id,
        metadata: {
          name: deleted.name,
          config: deleted.config,
          clearedAssignments: {
            devices: deleted.deviceCount,
            sites: deleted.siteCount,
          },
        },
      }),
      async (tx) => {
        const [before] = await tx
          .select({ name: refreshProfiles.name, config: refreshProfiles.config })
          .from(refreshProfiles)
          .where(eq(refreshProfiles.id, id))
          .limit(1);
        if (!before) throw new Error("refresh_profile_not_found");
        const [impact] = await tx
          .select({
            deviceCount: sql<number>`(
              select count(*) from ${devices}
              where ${devices.refreshProfileId} = ${id}
            )`,
            siteCount: sql<number>`(
              select count(*) from ${sites}
              where ${sites.refreshProfileId} = ${id}
            )`,
          })
          .from(refreshProfiles)
          .where(eq(refreshProfiles.id, id));
        const deleted = await tx
          .delete(refreshProfiles)
          .where(eq(refreshProfiles.id, id))
          .returning({ id: refreshProfiles.id });
        if (deleted.length === 0) throw new Error("refresh_profile_not_found");
        return {
          id,
          name: before.name,
          config: before.config,
          deviceCount: Number(impact.deviceCount),
          siteCount: Number(impact.siteCount),
        };
      },
      "delete-refresh-profile"
    );
    revalidatePath("/admin/profiles");
  } catch (err) {
    log.error("Failed to delete refresh profile", { id, error: String(err) });
    throw err;
  }
}

/**
 * Designate the refresh profile used by displays with none assigned, or pass null
 * to clear it (they then fall back to the built-in intervals).
 *
 * Both writes happen in one transaction because a partial unique index allows only
 * one row to hold the flag — clearing and setting separately would violate it
 * halfway through. That constraint is deliberate: it makes "two defaults"
 * impossible to represent rather than something this function must remember.
 */
export async function setDefaultRefreshProfile(id: string | null) {
  const actor = await requireAdmin("profiles.manage");
  try {
    await withAuditedTransaction(
      actor,
      { action: "profile.setDefault", targetType: "refresh_profile", targetId: id },
      async (tx) => {
        if (id) {
          const target = await tx
            .select({ id: refreshProfiles.id })
            .from(refreshProfiles)
            .where(eq(refreshProfiles.id, id))
            .limit(1);
          if (target.length === 0) throw new Error("refresh_profile_not_found");
        }
        await tx
          .update(refreshProfiles)
          .set({ isDefault: false })
          .where(eq(refreshProfiles.isDefault, true));
        if (id)
          await tx
            .update(refreshProfiles)
            .set({ isDefault: true })
            .where(eq(refreshProfiles.id, id));
      },
      "set-default-refresh-profile",
      "serializable"
    );
    revalidatePath("/admin/profiles");
    revalidatePath("/admin/devices");
  } catch (err) {
    log.error("Failed to set default refresh profile", { id, error: String(err) });
    throw err;
  }
}

/**
 * Designate the theme used by displays with none assigned, or null to clear it.
 *
 * `themes.is_default` and the render route's fallback to it have existed since the
 * initial schema, and the themes UI has always rendered a "Default" badge — but
 * nothing could ever write the flag, so that badge was unreachable. This is the
 * missing half.
 */
export async function setDefaultTheme(id: string | null) {
  const actor = await requireAdmin("themes.manage");
  try {
    await withAuditedTransaction(
      actor,
      { action: "theme.setDefault", targetType: "theme", targetId: id },
      async (tx) => {
        if (id) {
          const target = await tx
            .select({ id: themes.id })
            .from(themes)
            .where(eq(themes.id, id))
            .limit(1);
          if (target.length === 0) throw new Error("theme_not_found");
        }
        await tx.update(themes).set({ isDefault: false }).where(eq(themes.isDefault, true));
        if (id) await tx.update(themes).set({ isDefault: true }).where(eq(themes.id, id));
      },
      "set-default-theme",
      "serializable"
    );
    revalidatePath("/admin/themes");
    revalidatePath("/admin/devices");
  } catch (err) {
    log.error("Failed to set default theme", { id, error: String(err) });
    throw err;
  }
}

/* ── Firmware ──────────────────────────────────────────────────── */

export async function getAvailableVersions() {
  await requireAdmin("firmware.read");
  const { getAvailableVersions: fn } = await import("@/lib/firmware");
  return fn();
}

/* ── Settings ─────────────────────────────────────────────────── */

export async function updateSetting(key: string, value: unknown) {
  const actor = await requireAdmin("firmware.rollout");
  const { cacheCommittedSetting, setSettingInTransaction } = await import("@/lib/settings");
  const { syncAutoPoll } = await import("@/lib/firmware");
  if (key !== "firmware.autoPoll" && key !== "firmware.pollIntervalS") {
    throw new Error("unsupported_setting");
  }
  if (key === "firmware.autoPoll" && typeof value !== "boolean") {
    throw new Error("invalid_setting_value");
  }
  if (
    key === "firmware.pollIntervalS" &&
    (typeof value !== "number" || !Number.isInteger(value) || value < 60 || value > 86_400)
  ) {
    throw new Error("invalid_setting_value");
  }

  await withAuditedTransaction(
    actor,
    { action: "setting.update", targetType: "setting", targetId: key },
    (tx) =>
      key === "firmware.autoPoll"
        ? setSettingInTransaction(tx, key, value as boolean)
        : setSettingInTransaction(tx, key, value as number),
    "update-setting"
  );
  // Cache publication must happen only after the transaction commits.
  if (key === "firmware.autoPoll") cacheCommittedSetting(key, value as boolean);
  else cacheCommittedSetting(key, value as number);
  await syncAutoPoll();
  revalidatePath("/admin/firmware");
}

/* ── Firmware rollouts ────────────────────────────────────────── */

/** All rollout records (for the rollout dashboard), newest-touched first. */
export async function getRollouts() {
  await requireAdmin("firmware.read");
  return withDbRead(
    () =>
      db
        .select()
        .from(firmwareRollouts)
        .orderBy(sql`${firmwareRollouts.updatedAt} DESC`),
    "get-rollouts"
  );
}

/**
 * Create or update the rollout for a (version, channel). `percent` is clamped to
 * 0-100 and only meaningful in the "canary"/"percent" states.
 */
export async function setRollout(
  version: string,
  channel: string,
  state: RolloutState,
  percent = 0
) {
  const actor = await requireAdmin("firmware.rollout");
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  await withAuditedTransaction(
    actor,
    {
      action: "firmware.rollout.set",
      targetType: "firmware_rollout",
      targetId: `${version}:${channel}`,
      metadata: { state, percent: pct },
    },
    (tx) =>
      tx
        .insert(firmwareRollouts)
        .values({ version, channel, state, percent: pct, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [firmwareRollouts.version, firmwareRollouts.channel],
          set: { state, percent: pct, updatedAt: new Date() },
        }),
    "set-rollout"
  );
  revalidatePath("/admin/firmware");
}

/** One-click kill-switch: stop offering `version` on `channel` fleet-wide. */
export async function haltRollout(version: string, channel: string) {
  await requireAdmin("firmware.rollout");
  await setRollout(version, channel, "halted", 0);
}

/** Recent OTA outcome events (for the rollout dashboard / failure triage). */
export async function getRecentOtaEvents(limit = 100) {
  await requireAdmin("firmware.read");
  return withDbRead(
    () =>
      db
        .select()
        .from(otaEvents)
        .orderBy(sql`${otaEvents.timestamp} DESC`)
        .limit(limit),
    "get-ota-events"
  );
}

/**
 * Remove only the persistent failure markers that suppress one exact OTA
 * target for one exact device. This is an explicit, audited operator retry;
 * successful history and failures for every other device/version remain intact.
 */
export async function retryDeviceOta(mac: string, version: string) {
  const actor = await requireAdmin("firmware.rollout");
  const normalizedMac = mac.trim().toUpperCase();
  const normalizedVersion = version.trim();
  if (!/^[0-9A-F]{12}$/.test(normalizedMac)) throw new Error("invalid_device_mac");
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(normalizedVersion)) {
    throw new Error("invalid_firmware_version");
  }

  const removed = await withAuditedTransaction(
    actor,
    (rows: { id: number }[]) => ({
      action: "firmware.ota.retry",
      targetType: "device_firmware",
      targetId: `${normalizedMac}:${normalizedVersion}`,
      metadata: { removedFailureMarkers: rows.length },
    }),
    (tx) =>
      tx
        .delete(otaEvents)
        .where(
          and(
            eq(otaEvents.mac, normalizedMac),
            eq(otaEvents.toVersion, normalizedVersion),
            inArray(otaEvents.phase, [...OTA_FAILED_PHASES])
          )
        )
        .returning({ id: otaEvents.id }),
    "retry-device-ota"
  );
  if (removed.length === 0) throw new Error("ota_failure_marker_not_found");
  revalidatePath("/admin/firmware");
}

export interface RolloutOverview {
  rollouts: { version: string; channel: string; state: string; percent: number }[];
  adoption: { version: string; count: number }[];
  health: { version: string; phase: string; count: number }[];
  recentEvents: {
    mac: string;
    model: string | null;
    fromVersion: string | null;
    toVersion: string | null;
    phase: string;
    errorCode: string | null;
    timestamp: string;
  }[];
}

/** Everything the rollout dashboard needs in one round-trip. */
export async function getRolloutOverview(): Promise<RolloutOverview> {
  await requireAdmin("firmware.read");
  const [rollouts, adoption, health, recentEvents] = await Promise.all([
    getRollouts(),
    // Adoption: how many devices are running each firmware version (latest
    // telemetry row per device).
    withDbRead(
      () =>
        db.execute(sql`
          SELECT t.firmware_version AS version, count(*)::int AS count
          FROM (
            SELECT DISTINCT ON (mac) mac, firmware_version
            FROM telemetry WHERE firmware_version IS NOT NULL
            ORDER BY mac, timestamp DESC
          ) t
          GROUP BY t.firmware_version ORDER BY count DESC
        `),
      "rollout-adoption"
    ).then((r) => r.rows as { version: string; count: number }[]),
    // Health: OTA outcome counts per target version (last 30 days).
    withDbRead(
      () =>
        db.execute(sql`
          SELECT to_version AS version, phase, count(*)::int AS count
          FROM ota_events
          WHERE timestamp > now() - make_interval(days => 30) AND to_version IS NOT NULL
          GROUP BY to_version, phase
        `),
      "rollout-health"
    ).then((r) => r.rows as { version: string; phase: string; count: number }[]),
    withDbRead(
      () =>
        db.execute(sql`
          SELECT mac, model, from_version AS "fromVersion", to_version AS "toVersion",
                 phase, error_code AS "errorCode",
                 to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS timestamp
          FROM ota_events ORDER BY timestamp DESC LIMIT 50
        `),
      "rollout-events"
    ).then((r) => r.rows as RolloutOverview["recentEvents"]),
  ]);
  return {
    rollouts: rollouts as RolloutOverview["rollouts"],
    adoption,
    health,
    recentEvents,
  };
}
