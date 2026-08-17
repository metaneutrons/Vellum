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
  `kmsp11.yaml`. These are `.gitignore`d. Production private key material lives
  in KMS and must never touch this directory or CI. The sole development
  exception is `testsecure_signing_key.pem`: the Makefile generates this local,
  disposable, git-ignored key only for the fully reversible `testsecure` rung.
  It has no production trust value and must never be imported into an HSM.

> **Status — Secure Boot v2 not yet provisioned:** `secureboot.pub` and
> `secureboot_digest*.bin` (the row-2 material above) do **not** exist here yet.
> They are produced only when Secure Boot v2 is actually provisioned (a still-open
> phase), so this directory is legitimately **README-only** for now. The one
> public key that *does* exist today is the OTA Ed25519 key at repo root,
> `vellum-firmware-signing.pub` (row 1) — not in this directory.

## Why production uses KMS, not a local PEM

Phase 3 moved both keys to a cloud KMS/HSM signed via GitHub OIDC (keyless) —
there is no long-lived signing key on any build host or in any repo secret. See
[`docs/SECURE_BOOT_AND_KMS.md`](../../docs/SECURE_BOOT_AND_KMS.md) for the key
generation/import, rotation, and revocation runbook.
