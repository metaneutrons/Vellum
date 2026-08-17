// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import "server-only";

import crypto from "node:crypto";

export const USB_PROVISIONING_AUTH_CONTEXT = "vellum-usb-provision-v1\n";

export function normalizeProvisioningMac(value: string): string {
  const mac = value.trim().toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(mac)) throw new Error("invalid_device_mac");
  return mac;
}

function decodeHex(value: string, bytes: number, error: string): Buffer {
  const normalized = value.trim().toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(normalized)) throw new Error(error);
  return Buffer.from(normalized, "hex");
}

/**
 * Sign one exact provisioning payload for one device and one live USB challenge.
 * The existing per-device token is a shared secret and never leaves the server.
 */
export function signUsbProvisioningAuthorization(input: {
  deviceToken: string;
  mac: string;
  challenge: string;
  payloadDigest: string;
}): string {
  const mac = normalizeProvisioningMac(input.mac);
  const challenge = decodeHex(input.challenge, 16, "invalid_usb_challenge");
  const payloadDigest = decodeHex(input.payloadDigest, 32, "invalid_payload_digest");
  if (!/^[0-9a-f]{64}$/i.test(input.deviceToken)) throw new Error("invalid_device_token");

  return crypto
    .createHmac("sha256", input.deviceToken)
    .update(USB_PROVISIONING_AUTH_CONTEXT, "utf8")
    .update(mac, "ascii")
    .update(challenge)
    .update(payloadDigest)
    .digest("hex");
}
