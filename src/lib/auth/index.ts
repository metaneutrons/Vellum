import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { encryptForDevice } from "@/lib/crypto";
import { constantTimeEqual } from "@/lib/constant-time";
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
}

export const drizzleDeviceRepo: DeviceRepository = {
  async findByMac(mac) {
    const rows = await db
      .select({
        mac: devices.mac,
        status: devices.status,
        token: devices.token,
        publicKey: devices.publicKey,
      })
      .from(devices)
      .where(eq(devices.mac, mac))
      .limit(1);
    return rows[0] ?? null;
  },
  async insertPending(mac, publicKey) {
    await db.insert(devices).values({ mac, status: "pending", publicKey });
  },
  async updatePublicKey(mac, publicKey) {
    await db.update(devices).set({ publicKey }).where(eq(devices.mac, mac));
  },
  async updateDisplayCaps(mac, caps) {
    await db.update(devices).set({ displayCaps: caps }).where(eq(devices.mac, mac));
  },
  async updateApproved(mac, token) {
    await db
      .update(devices)
      .set({ status: "approved", token, approvedAt: new Date() })
      .where(eq(devices.mac, mac));
  },
  async updateLastSeen(mac) {
    await db.update(devices).set({ lastSeen: new Date() }).where(eq(devices.mac, mac));
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
  if (publicKey && publicKey !== device.publicKey) {
    await repo.updatePublicKey(mac, publicKey);
  }
  if (displayCaps) {
    await repo.updateDisplayCaps(mac, displayCaps);
  }

  if (device.status === "approved" && device.token) {
    const devicePubKey = publicKey ?? device.publicKey;
    if (devicePubKey) {
      const encrypted = encryptForDevice(device.token, devicePubKey);
      return { status: "approved", encryptedToken: encrypted };
    }
    return { status: "approved", token: device.token };
  }

  return { status: device.status };
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
  if (!device) return false;
  if (device.status !== "approved") return false;
  if (!device.token) return false;
  return constantTimeEqual(device.token, token);
}
