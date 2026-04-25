import { describe, it, expect } from "vitest";
import { encryptCredentials, decryptCredentials } from "../encryption";

describe("Credential encryption round-trip", () => {
  it("encrypts and decrypts a simple object", () => {
    const original = { tenantId: "abc", clientId: "def", clientSecret: "ghi" };
    const encrypted = encryptCredentials(original);
    expect(typeof encrypted).toBe("string");
    expect(encrypted).not.toContain("abc");

    const decrypted = decryptCredentials<typeof original>(encrypted);
    expect(decrypted).toEqual(original);
  });

  it("produces different ciphertext each time (random nonce)", () => {
    const data = { key: "value" };
    const a = encryptCredentials(data);
    const b = encryptCredentials(data);
    expect(a).not.toBe(b);
  });

  it("handles empty objects", () => {
    const encrypted = encryptCredentials({});
    const decrypted = decryptCredentials(encrypted);
    expect(decrypted).toEqual({});
  });

  it("handles nested objects", () => {
    const original = { a: { b: { c: "deep" } }, arr: [1, 2, 3] };
    const encrypted = encryptCredentials(original);
    const decrypted = decryptCredentials(encrypted);
    expect(decrypted).toEqual(original);
  });
});
