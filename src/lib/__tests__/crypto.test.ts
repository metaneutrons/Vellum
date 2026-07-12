// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { encryptForDevice } from "../crypto";

/** Mirror of the DEVICE side: reconstruct the shared secret and decrypt. */
function decryptAsDevice(
  enc: { ciphertext: string; nonce: string; serverPublicKey: string },
  devicePrivateKey: crypto.KeyObject
): string {
  const serverPub = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b656e032100", "hex"), // X25519 SPKI prefix
      Buffer.from(enc.serverPublicKey, "base64"),
    ]),
    format: "der",
    type: "spki",
  });
  const shared = crypto.diffieHellman({ privateKey: devicePrivateKey, publicKey: serverPub });
  const aesKey = crypto.hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("vellum-token-v1"), 32);
  const blob = Buffer.from(enc.ciphertext, "base64");
  const tag = blob.subarray(blob.length - 16);
  const body = blob.subarray(0, blob.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(aesKey), Buffer.from(enc.nonce, "base64"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf-8");
}

function deviceKeyPair() {
  const kp = crypto.generateKeyPairSync("x25519");
  const pubB64 = kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  return { kp, pubB64 };
}

describe("encryptForDevice — X25519 ECDH + HKDF-SHA256 + AES-256-GCM", () => {
  it("round-trips: the enrolled device can decrypt exactly what the server encrypted", () => {
    const { kp, pubB64 } = deviceKeyPair();
    const token = "a1b2c3d4e5f6".repeat(5) + "abcd"; // 64-char token
    const enc = encryptForDevice(token, pubB64);
    expect(decryptAsDevice(enc, kp.privateKey)).toBe(token);
  });

  it("uses a fresh ephemeral server key + nonce every call (no reuse)", () => {
    const { pubB64 } = deviceKeyPair();
    const a = encryptForDevice("tok", pubB64);
    const b = encryptForDevice("tok", pubB64);
    expect(a.serverPublicKey).not.toBe(b.serverPublicKey);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("a different device key cannot decrypt (GCM auth fails) — the impersonation guarantee", () => {
    const { pubB64 } = deviceKeyPair();
    const enc = encryptForDevice("secret-token", pubB64);
    const wrong = crypto.generateKeyPairSync("x25519");
    expect(() => decryptAsDevice(enc, wrong.privateKey)).toThrow();
  });

  it("a tampered ciphertext fails authentication", () => {
    const { kp, pubB64 } = deviceKeyPair();
    const enc = encryptForDevice("secret-token", pubB64);
    const bytes = Buffer.from(enc.ciphertext, "base64");
    bytes[0] ^= 0xff; // flip a bit
    const tampered = { ...enc, ciphertext: bytes.toString("base64") };
    expect(() => decryptAsDevice(tampered, kp.privateKey)).toThrow();
  });
});
