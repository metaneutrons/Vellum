// Generate golden KAT vectors for the firmware host tests.
// Mirrors firmware/components/secure_channel/secure_channel.c and
// firmware/components/ota_manager/ota_manager.c (verify_one_key).
import crypto from "node:crypto";

const b64 = (buf) => Buffer.from(buf).toString("base64");

// ---- helpers to build raw X25519 / Ed25519 keys from a fixed seed ----
// DER prefixes for PKCS#8 raw-key import (deterministic vectors).
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

function privFromRaw(prefix, raw32) {
  return crypto.createPrivateKey({
    key: Buffer.concat([prefix, raw32]),
    format: "der",
    type: "pkcs8",
  });
}
function pubFromRaw(prefix, raw32) {
  return crypto.createPublicKey({
    key: Buffer.concat([prefix, raw32]),
    format: "der",
    type: "spki",
  });
}
function rawPub(keyObj) {
  const der = keyObj.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32); // last 32 bytes = raw key
}

// ===================== secure_channel token KAT =====================
// Fixed device + server X25519 scalars.
const devSeed = Buffer.from("11".repeat(32), "hex");
const srvSeed = Buffer.from("22".repeat(32), "hex");
const devPriv = privFromRaw(X25519_PKCS8, devSeed);
const devPub = pubFromRaw(X25519_SPKI, rawPub(crypto.createPublicKey(devPriv)));
const srvPriv = privFromRaw(X25519_PKCS8, srvSeed);
const srvPubRaw = rawPub(crypto.createPublicKey(srvPriv));

// Server side: ECDH(server_priv, device_pub) — same shared secret the device
// computes as ECDH(device_priv, server_pub).
const shared = crypto.diffieHellman({ privateKey: srvPriv, publicKey: devPub });

// HKDF-SHA256, empty salt, info "vellum-token-v1", 32-byte AES key.
const aesKey = Buffer.from(
  crypto.hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("vellum-token-v1"), 32),
);

const plaintext = "device-token-abc123";
const nonce = Buffer.from("0123456789ab0123456789ab", "hex"); // 12 bytes, fixed
const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, nonce);
const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
const tag = cipher.getAuthTag();
const ctPlusTag = Buffer.concat([ct, tag]); // secure_channel.c layout: ct || tag(16)

console.log("=== SECURE_CHANNEL_KAT ===");
console.log("device_priv_b64 =", b64(devSeed)); // raw 32-byte scalar (what NVS holds)
console.log("server_pub_b64  =", b64(srvPubRaw));
console.log("nonce_b64       =", b64(nonce));
console.log("ciphertext_b64  =", b64(ctPlusTag));
console.log("plaintext       =", plaintext);

// ===================== Ed25519 OTA-signature KAT =====================
const edSeed = Buffer.from("33".repeat(32), "hex");
const edPriv = privFromRaw(ED25519_PKCS8, edSeed);
const edPubRaw = rawPub(crypto.createPublicKey(edPriv));

// Device signs/verifies the raw 32-byte SHA-256 digest of the image (PURE-EdDSA).
const digest = crypto.createHash("sha256").update("vellum-firmware-image-v1.2.3").digest();
const sig = crypto.sign(null, digest, edPriv); // Ed25519 pure

console.log("\n=== ED25519_KAT ===");
console.log("pubkey_b64 =", b64(edPubRaw));
console.log("digest_hex =", digest.toString("hex"));
console.log("sig_b64    =", b64(sig));

// sanity self-check
const ok = crypto.verify(null, digest, crypto.createPublicKey(edPriv), sig);
console.log("selfcheck_verify =", ok);
