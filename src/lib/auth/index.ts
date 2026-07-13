// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import crypto from "crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db, withDb } from "@/db";
import { devices, provisioningVouchers } from "@/db/schema";
import { encryptForDevice } from "@/lib/crypto";
import { constantTimeEqual } from "@/lib/constant-time";
import { log } from "@/lib/logger";
import type { DisplayCaps } from "@/lib/display";

export interface HelloResponse {
  status: string;
  token?: string;
  encryptedToken?: {
    ciphertext: string;
    nonce: string;
    serverPublicKey: string;
  };
}

export interface DeviceRecord {
  mac: string;
  status: string;
  token: string | null;
  publicKey: string | null;
}

export interface DeviceRepository {
  findByMac(mac: string): Promise<DeviceRecord | null>;
  insertPending(mac: string, publicKey: string | null): Promise<void>;
  updatePublicKey(mac: string, publicKey: string): Promise<void>;
  updateDisplayCaps(mac: string, caps: DisplayCaps): Promise<void>;
  updateApproved(mac: string, token: string): Promise<void>;
  updateLastSeen(mac: string): Promise<void>;
  /** Atomically claim an unclaimed voucher by token for this MAC; true if won. */
  claimVoucher(token: string, mac: string): Promise<boolean>;
  /** Insert-or-approve a device with a known (voucher) token. */
  upsertApprovedWithToken(mac: string, token: string): Promise<void>;
}

export const drizzleDeviceRepo: DeviceRepository = {
  async findByMac(mac) {
    const rows = await withDb(() => db
      .select({
        mac: devices.mac,
        status: devices.status,
        token: devices.token,
        publicKey: devices.publicKey,
      })
      .from(devices)
      .where(eq(devices.mac, mac))
      .limit(1), "auth-find-device-by-mac");
    return rows[0] ?? null;
  },
  async insertPending(mac, publicKey) {
    await withDb(() => db.insert(devices).values({ mac, status: "pending", publicKey }), "auth-insert-pending-device");
  },
  async updatePublicKey(mac, publicKey) {
    await withDb(() => db.update(devices).set({ publicKey }).where(eq(devices.mac, mac)), "auth-update-public-key");
  },
  async updateDisplayCaps(mac, caps) {
    await withDb(() => db.update(devices).set({ displayCaps: caps }).where(eq(devices.mac, mac)), "auth-update-display-caps");
  },
  async updateApproved(mac, token) {
    await withDb(() => db
      .update(devices)
      .set({ status: "approved", token, approvedAt: new Date() })
      .where(eq(devices.mac, mac)), "auth-update-approved");
  },
  async updateLastSeen(mac) {
    await withDb(() => db.update(devices).set({ lastSeen: new Date() }).where(eq(devices.mac, mac)), "auth-update-last-seen");
  },
  async claimVoucher(token, mac) {
    // Single atomic UPDATE ... WHERE claimed_by_mac IS NULL RETURNING — prevents
    // two devices claiming the same voucher (single-use, bound to the first MAC).
    const rows = await withDb(() => db
      .update(provisioningVouchers)
      .set({ claimedByMac: mac, claimedAt: new Date() })
      .where(and(eq(provisioningVouchers.token, token), isNull(provisioningVouchers.claimedByMac)))
      .returning({ token: provisioningVouchers.token }), "auth-claim-voucher");
    return rows.length > 0;
  },
  async upsertApprovedWithToken(mac, token) {
    await withDb(() => db
      .insert(devices)
      .values({ mac, status: "approved", token, approvedAt: new Date() })
      .onConflictDoUpdate({
        target: devices.mac,
        set: { status: "approved", token, approvedAt: new Date() },
      }), "auth-voucher-enroll");
  },
};

/**
 * Handles the /hello handshake. Persists publicKey and display capabilities.
 */
export async function handleHello(
  mac: string,
  publicKey: string | null = null,
  displayCaps: DisplayCaps | undefined = undefined,
  repo: DeviceRepository = drizzleDeviceRepo
): Promise<HelloResponse> {
  const device = await repo.findByMac(mac);

  if (!device) {
    await repo.insertPending(mac, publicKey);
    if (displayCaps) await repo.updateDisplayCaps(mac, displayCaps);
    return { status: "pending" };
  }

  await repo.updateLastSeen(mac);
  if (displayCaps) {
    await repo.updateDisplayCaps(mac, displayCaps);
  }

  const approved = device.status === "approved" && !!device.token;

  // Before approval the device holds no secret, so it may (re)register its
  // X25519 handshake key freely — this is where the trusted key is captured.
  // Once approved the key is FROZEN: an unauthenticated /hello can never change
  // it. That is what closes the impersonation path — knowing the (non-secret)
  // MAC and substituting your own public key must NOT yield the device token.
  if (!approved) {
    if (publicKey && publicKey !== device.publicKey) {
      await repo.updatePublicKey(mac, publicKey);
    }
    return { status: device.status };
  }

  // Approved: deliver the bearer token ONLY encrypted to the enrolled key.
  // A caller presenting a DIFFERENT key is either an impersonator or a
  // factory-reset device that no longer holds the enrolled private key — in
  // both cases the token must not be handed to an unproven key; the device has
  // to be re-approved by an operator. We never overwrite the stored key here.
  if (publicKey && device.publicKey && publicKey !== device.publicKey) {
    log.warn("hello: approved device presented a different handshake key — " +
      "refusing token, re-provisioning required", { mac });
    return { status: "pending" };
  }

  // Approved but no enrolled key (pre-crypto / incomplete enrollment): we cannot
  // deliver the token securely, so require re-provisioning rather than returning
  // it in the clear to an unauthenticated caller.
  if (!device.publicKey) {
    log.warn("hello: approved device has no enrolled key — re-provisioning required", { mac });
    return { status: "pending" };
  }

  const encrypted = encryptForDevice(device.token as string, device.publicKey);
  return { status: "approved", encryptedToken: encrypted };
}

/**
 * Admin action: approve a pending device and generate a crypto token.
 */
export async function approveDevice(
  mac: string,
  repo: DeviceRepository = drizzleDeviceRepo
): Promise<void> {
  const token = crypto.randomBytes(32).toString("hex");
  await repo.updateApproved(mac, token);
}

/**
 * Validates a device token for authenticated requests.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export async function validateToken(
  mac: string,
  token: string,
  repo: DeviceRepository = drizzleDeviceRepo
): Promise<boolean> {
  if (!token) return false;
  const device = await repo.findByMac(mac);
  if (device) {
    if (device.status !== "approved") return false;
    if (!device.token) return false;
    return constantTimeEqual(device.token, token);
  }
  // Unknown MAC presenting a token: this may be a zero-touch device carrying a
  // pre-provisioning voucher. Claim atomically and auto-enrol if it matches an
  // unclaimed voucher; otherwise reject. Existing and pending devices never
  // reach here, so the audited enrolment path is unchanged.
  if (await repo.claimVoucher(token, mac)) {
    await repo.upsertApprovedWithToken(mac, token);
    log.info("device auto-enrolled via provisioning voucher", { mac });
    return true;
  }
  return false;
}
