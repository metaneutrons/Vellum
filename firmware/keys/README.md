# firmware/keys — public key material only

Vellum has **two independent signing trust chains**. Do not conflate them.

| # | Purpose | Algorithm | Private key custody | Public half | Verified by |
|---|---------|-----------|---------------------|-------------|-------------|
| 1 | **OTA app signature** | Ed25519 (PureEdDSA) | KMS (was `secrets.FIRMWARE_SIGNING_KEY`) | `CONFIG_VELLUM_OTA_SIGNING_PUBKEY` in `main/Kconfig.projbuild`; PEM in repo root `vellum-firmware-signing.pub` | `ota_manager.c` `verify_ota_signature()` in software, against the on-device trust store (`components/ota_manager/ota_trust_keys.h`) |
| 2 | **Secure Boot v2** | RSA-3072-PSS | KMS / offline HSM | digest burned to eFuse `SECURE_BOOT_DIGEST0/1/2`; `secureboot.pub` here | ROM + bootloader at every boot |

## What lives here

- **Committed** (public, safe): `*.pub` public keys (PEM content, `.pub` name —
  the repo ignores `*.pem`), and exported digests `secureboot_digest*.bin`. Keep
  these — a KMS key deletion with no exported public backup makes already-deployed
  images unverifiable/unrotatable forever.
- **NEVER committed** (private): `*.pem` / `*.der` private keys, `hsm_config.ini`,
  `kmsp11.yaml`. These are `.gitignore`d. Private key material lives in KMS; a
  local PEM should never touch this directory or CI.

## Why KMS, not a local PEM

Phase 3 moved both keys to a cloud KMS/HSM signed via GitHub OIDC (keyless) —
there is no long-lived signing key on any build host or in any repo secret. See
[`docs/SECURE_BOOT_AND_KMS.md`](../../docs/SECURE_BOOT_AND_KMS.md) for the key
generation/import, rotation, and revocation runbook.
