# Vellum Firmware — Security Model & Hardening

This document describes the security posture of the Vellum ESP32 unified firmware
(`firmware/`), how to build a fully hardened production image, and the residual
risks that are explicitly accepted.

> **Audience:** whoever manufactures/flashes devices and operates the backend.
> The device is a battery-powered display deployed in offices, meeting rooms and
> public/semi-public spaces, so both **on-network** and **physical** attackers
> are in scope.

---

## 1. Transport security (device ⇆ server)

All backend traffic uses **HTTPS with server-certificate validation** against the
ESP-IDF CA-certificate bundle (`esp_crt_bundle`).

- The HTTP client attaches the CA bundle to every request and **disables
  auto-redirect**, so a response cannot silently downgrade the connection to
  cleartext or bounce it to an attacker host
  (`firmware/components/http_client/http_client.c`).
- `http_client_init()` **rejects any server URL that is not `https://`**. Requests
  over a non-HTTPS base URL fail with `ESP_ERR_NOT_SUPPORTED` — the device never
  transmits the device token or fetches render content over plaintext.
- mDNS auto-discovery only accepts a **hostname** (never a bare IP, which a public
  CA cannot certify) and always builds an `https://` URL
  (`firmware/main/main.c`).
- OTA image downloads are likewise `https://`-only
  (`firmware/components/ota_manager/ota_manager.c`). The device downloads them
  from its configured Vellum origin, not GitHub. The download URL is HMAC-signed,
  scoped to one approved device/model/release and expires after ten minutes;
  Vellum then proxies the immutable release asset. SHA-256, Ed25519 and staged
  image model checks remain mandatory on-device.

**Operator requirement:** the backend must be reachable at an FQDN with a
publicly-trusted certificate (e.g. behind a reverse proxy: `https://vellum.example.com`).
Provision that URL via the captive portal, Improv serial, or the console `server`
command. `.local` / bare-IP endpoints will not validate against public roots.

### Token confidentiality

**On the network `/hello` path**, the device token is delivered **end-to-end
encrypted** (X25519 ECDH → HKDF-SHA256 → AES-256-GCM) so it is protected even
from the TLS-terminating proxy
(`firmware/components/secure_channel/secure_channel.c`). All server-supplied
fields are length-validated before use, and private key material is zeroized from
the stack after use.

**The voucher / USB provisioning path is different — the token is NOT encrypted
there.** It is the same device bearer token (`src/db/schema.ts`; `validateToken`
in `src/lib/auth/index.ts`), but it crosses the **USB cable in cleartext**: as
the 4th length-prefixed string in the Improv `WIFI_SETTINGS` frame
(`src/lib/provisioning/improv-serial.ts`), and via the plaintext `token <value>`
serial-console command (`firmware/components/vellum_serial/vellum_serial.c`).
This path relies on **physical trust of the provisioning window**, not
cryptography (see §4).

---

## 2. Firmware integrity (OTA)

The OTA trust chain verifies the image **before it is ever made bootable**
(`ota_manager.c`):

1. Download into the inactive OTA slot (not bootable yet).
2. SHA-256 the _staged partition_.
3. **Ed25519-verify** the server signature over that device-computed digest
   (`PSA_ALG_PURE_EDDSA`). The signed message is the digest the _device_ computed,
   so a substituted image cannot pass.
4. Only then `esp_https_ota_finish()` sets the boot partition
   (`PENDING_VERIFY` + bootloader rollback).
5. After a good server round-trip the image is confirmed via
   `ota_manager_mark_valid()`; otherwise the bootloader rolls back.

- **`CONFIG_VELLUM_OTA_REQUIRE_SIGNATURE` now defaults to `y` (fail-closed).**
  With Secure Boot disabled (dev builds) this app-level signature is the _only_
  control preventing malicious firmware, so it must never fail open.
- The signing **public** key ships in the firmware
  (`CONFIG_VELLUM_OTA_SIGNING_PUBKEY`, raw 32-byte Ed25519, base64). The matching
  **private** key must live only on the signing server / in an HSM.
- The production profile additionally enables **anti-rollback** to reject
  validly-signed but _older_ images.

---

## 3. Secrets at rest

The device stores the WiFi PSK, the device token, and the **X25519 private key**
in NVS (`firmware/components/nvs_manager/`).

- **Development builds do NOT encrypt NVS or flash** — these secrets are readable
  by anyone who can dump the flash. Do not deploy dev builds to untrusted
  locations.
- **Production builds** enable NVS encryption rooted in an eFuse-protected key
  (via Flash Encryption), giving real at-rest confidentiality. See §5.

> Meaningful at-rest encryption on ESP32 requires a hardware root of trust burned
> into eFuse; there is no software-only substitute (any device-stored key is
> itself extractable without the hardware root). This is why NVS encryption is
> part of the production (eFuse-burning) profile, not the default build.

---

## 4. Provisioning security

- **SoftAP captive portal** is an OPEN AP during first-time setup only. Treat the
  setup window as trusted-physical: anyone in RF range can submit credentials. The
  device restarts out of AP mode immediately after credentials are stored. The
  captive DNS responder is bounds-checked against oversized queries.
- **Improv-serial / USB console** requires physical USB access (which already
  grants full control). RPC length fields are validated against the bytes actually
  received before use.
- **Zero-touch voucher enrolment** (optional). An admin mints a single-use
  provisioning voucher (`provisioning_vouchers` table, `src/db/schema.ts`) whose
  `token` **is** the device bearer token, and pushes it over USB with the Wi-Fi
  profile. On the device's first authenticated request `claimVoucherAndEnroll`
  (`src/lib/auth/index.ts`) claims _and_ enrols it: the voucher is bound to the
  first claiming MAC by a single atomic
  `UPDATE … WHERE claimed_by_mac IS NULL`, and the claim + device enrolment run in
  **one transaction** — a crash mid-way rolls both back, so the voucher is never
  burned without the device being enrolled. An optional expiry (`expiresAt`,
  default 7 days) bounds the leak window of an unclaimed voucher; **`expiresAt =
NULL` never expires, so this expiry mitigation is opt-in.** Enrolment is
  auth-gated by **possession of the voucher** (not open enrolment — an unknown MAC
  with no matching voucher is rejected), and after approval the device's handshake
  public key is **frozen**, so a spoofed MAC can no longer extract the token
  (`handleHello` / `validateToken`, `src/lib/auth/index.ts`).

---

## 5. Production hardening runbook ⚠️ irreversible

The profile in `firmware/sdkconfig.defaults.prod` enables Secure Boot v2, Flash
Encryption (Release), NVS encryption and anti-rollback. **First boot burns eFuses
— there is no undo.** Prove the full image + OTA flow on dev boards first.

```bash
cd firmware

# 1. Generate keys (keep OFFLINE — HSM/vault; never commit).
mkdir -p keys
idf.py secure-boot-generate-signing-key keys/secure_boot_signing_key.pem
#   OTA signing key (Ed25519) is separate — generate on the signing server and
#   put ONLY its public half in CONFIG_VELLUM_OTA_SIGNING_PUBKEY.

# 2. Build with the production overlay (pick the right per-variant file).
idf.py -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.s3;sdkconfig.defaults.prod" build

# 3. First flash over a wired connection you control. The bootloader burns
#    eFuses and encrypts flash on first boot.
idf.py -p <PORT> flash monitor
```

Checklist before mass production:

- [ ] Secure Boot signing key backed up offline; access-controlled.
- [ ] OTA Ed25519 private key on the signing server only; public half in Kconfig.
- [ ] `keys/` is git-ignored (see below); no key material in the repo.
- [ ] OTA end-to-end verified (sign → serve → download → verify → rollback path).
- [ ] `CONFIG_SECURE_DISABLE_ROM_DL_MODE=y` confirmed (locks UART download).

Add to `firmware/.gitignore` (or the repo root):

```
firmware/keys/
*.pem
```

---

## 6. Residual / accepted risks

| Risk                                                                  | Status                                                                                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Dev builds: secrets in plaintext flash, board freely reflashable      | **Accepted for dev only.** Use the production profile for field units.                                                                  |
| Open SoftAP during first-time provisioning                            | Accepted; setup window is treated as physical-trust and is brief.                                                                       |
| Physical USB console/Improv grants device control                     | Accepted; equivalent to physical possession. Locked out by Secure Boot + disabled ROM-DL in prod.                                       |
| Render content spoofing if the operator uses a non-public-CA endpoint | Mitigated by enforced HTTPS + CA validation; operator must use a valid public cert.                                                     |
| OTA downgrade to an older _signed_ image                              | Mitigated in prod by anti-rollback; in dev only the version-gate applies.                                                               |
| `X-Forwarded-For` is trusted for rate-limit keying                    | Accepted **behind a trusted proxy** that overwrites XFF; a directly-exposed instance lets a client spoof it and bypass limits (see §7). |
| CSP is a non-breaking subset (no `script-src` lockdown)               | Accepted; clickjacking / `<base>` / plugin / form-hijack are covered. Full nonce-based CSP tracked in ROADMAP.                          |

---

## 7. Server API security & deployment assumptions

The backend API is defended in layers:

- **Device API** (`/api/v1/ink/*`): device-token auth (SHA-256 + constant-time compare),
  TOFU token issuance delivered encrypted to the device's X25519 key, zod input
  validation, and per-IP rate limiting (hello 10/min, authenticated 60/min).
  The OTA byte-stream endpoint uses a short-lived HMAC grant derived from that
  token instead of exposing the bearer token in a URL or requiring custom OTA
  headers.
- **Admin API + pages** (`/api/v1/admin/*`, `/admin/*`): gated centrally by `src/proxy.ts`
  — a valid HMAC-SHA256-signed, 8-hour session cookie, or a valid `x-api-key`. Login is
  rate-limited (5 / 15 min); the session cookie is `httpOnly` + `secure` (prod) +
  `sameSite=lax` (which also closes CSRF on the admin API).
- **Outbound fetches** (iCal / provider APIs / firmware proxy) go through `safeFetch`,
  which blocks loopback / private / link-local / cloud-metadata ranges and re-validates
  every redirect hop.
- **Baseline security headers** (HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`, and a CSP `frame-ancestors`/`base-uri`/
  `object-src`/`form-action`) are set in `next.config.ts`.

**Deployment assumption — trusted reverse proxy.** The server must run behind a proxy
that (a) terminates TLS with a valid certificate and (b) **overwrites** `X-Forwarded-For`.
Rate limiting keys on that header, so a directly-exposed instance would let a client spoof
it and bypass all limits. A full CSP `script-src` lockdown (per-request nonces) is a
roadmap item.

---

## 8. Reporting

Report suspected vulnerabilities privately to the maintainer rather than via a
public issue.
