/**
 * AES-256-GCM encryption for calendar provider credentials at rest.
 *
 * Uses ENCRYPTION_KEY from env as the master key.
 * Format: base64(nonce:ciphertext:authTag)
 */

import crypto from "crypto";
import { env } from "./env";

const ALGO = "aes-256-gcm";
const NONCE_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  // Derive a 32-byte key from the env secret via SHA-256
  return crypto.createHash("sha256").update(env.ENCRYPTION_KEY).digest();
}

/** Encrypt a JSON-serializable value. Returns a base64 string. */
export function encryptCredentials(data: unknown): string {
  const plaintext = JSON.stringify(data);
  const key = getKey();
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, tag]).toString("base64");
}

/** Decrypt a base64 string back to the original value. */
export function decryptCredentials<T = unknown>(encoded: string): T {
  const buf = Buffer.from(encoded, "base64");
  const key = getKey();
  const nonce = buf.subarray(0, NONCE_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(NONCE_LEN, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString("utf-8")) as T;
}
