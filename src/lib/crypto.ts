// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * X25519 ECDH key exchange for secure token delivery.
 *
 * Flow:
 *   1. Device generates X25519 keypair, sends publicKey in /hello
 *   2. Server generates ephemeral X25519 keypair per encryption
 *   3. Shared secret = ECDH(server_private, device_public)
 *   4. Derive AES-256-GCM key from shared secret via HKDF
 *   5. Encrypt token with AES-256-GCM
 *   6. Return { ciphertext, nonce, serverPublicKey } — all base64
 *
 * The device reverses: ECDH(device_private, server_public) → same shared secret → decrypt.
 */

import crypto from "crypto";

const HKDF_INFO = Buffer.from("vellum-token-v1");
const KEY_LENGTH = 32; // AES-256

/**
 * Encrypt a plaintext string for a device using its X25519 public key.
 * Returns base64-encoded { ciphertext, nonce, serverPublicKey }.
 */
export function encryptForDevice(
  plaintext: string,
  devicePublicKeyBase64: string
): { ciphertext: string; nonce: string; serverPublicKey: string } {
  const devicePub = Buffer.from(devicePublicKeyBase64, "base64");

  // Generate ephemeral server keypair
  const serverKeyPair = crypto.generateKeyPairSync("x25519");
  const serverPubRaw = serverKeyPair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);

  // Derive shared secret via ECDH
  const devicePubKey = crypto.createPublicKey({
    key: Buffer.concat([
      // X25519 SPKI prefix (12 bytes) + 32-byte raw key
      Buffer.from("302a300506032b656e032100", "hex"),
      devicePub,
    ]),
    format: "der",
    type: "spki",
  });

  const sharedSecret = crypto.diffieHellman({
    privateKey: serverKeyPair.privateKey,
    publicKey: devicePubKey,
  });

  // Derive AES key via HKDF
  const aesKey = crypto.hkdfSync("sha256", sharedSecret, Buffer.alloc(0), HKDF_INFO, KEY_LENGTH);

  // Encrypt with AES-256-GCM
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(aesKey), nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: Buffer.concat([encrypted, authTag]).toString("base64"),
    nonce: nonce.toString("base64"),
    serverPublicKey: serverPubRaw.toString("base64"),
  };
}
