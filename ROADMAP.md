# Roadmap

Planned / open work. Completed enterprise-hardening and the OTA release-path fix
landed in #28 (see [SECURITY.md](SECURITY.md) for the resulting security model).

## Firmware & OTA

- [ ] **Build & validate the ESP32-P4 / D1001 target.** Only ESP32-S3 (e1002)
      has been compile-verified after the hardening + OTA-release changes. Run the
      P4 build (or the full `firmware.yml` matrix) and confirm the app-image / merged-image
      split behaves on P4.
- [x] **OTA signing key — rotated, wired & backed up (2026-07-09).** Fresh Ed25519 key;
      the committed `vellum-firmware-signing.pub` matches the embedded
      `CONFIG_VELLUM_OTA_SIGNING_PUBKEY`, the `FIRMWARE_SIGNING_KEY` CI secret was updated
      to it, and a `workflow_dispatch` run passed the CI key-match guard and produced a
      signed beta release. CI signs both beta and stable builds. Private key backed up in
      the vault (`~/Documents/infrastructure/keys/vellum/`).
- [ ] **On-hardware OTA smoke test.** The build → sign → manifest release path is now
      CI-validated (`workflow_dispatch`, green). Remaining: confirm a real device
      downloads → verifies (SHA-256 + Ed25519) → applies → confirms, with bootloader
      rollback on failure.

## Production hardening (eFuse-burning — manufacturing)

- [x] **Secure-Boot ∩ OTA digest — fixed & wired (opt-in, OFF in dev).** CI now derives
      the OTA digest from the appended app "Validation hash" (`esptool image-info`),
      order-independent so it holds even when a Secure Boot block trails the image (kills
      the old `tail -c 32`-of-a-signed-file trap; verified locally: `esptool image-info`
      == `tail -c 32` for a plain image). An opt-in `OTA_SECURE_BOOT=1` gate makes `firmware.yml`
      RSA-PSS-sign the OTA image (`espsecure --hsm`, gated on `firmware/hsm_config.ini`)
      and switch the partition-fit guard to `partitions.secure.csv`. **Off in dev.**
- [ ] **Validate the Secure-Boot OTA leg on hardware (Phase B.5).** The `OTA_SECURE_BOOT`
      append + boot path is unexercised in CI (no SB board/HSM here). Prove a full OTA →
      RSA-verify → boot → rollback cycle on a `secureboot` board before enabling it for a
      fleet. `sdkconfig.defaults.prod` (Secure Boot v2 + Flash/NVS encryption +
      anti-rollback) stays a manual manufacturing profile.
- [ ] **Add a real-signed-image OTA digest KAT.** The host KAT signs a synthetic 32-byte
      string, so it locks the Ed25519 algorithm but nothing about digest derivation. Add a
      test that builds (and RSA-signs) an image and asserts the derived digest matches
      `esp_partition_get_sha256` semantics on the signed artifact.
- [ ] **Execute the eFuse burn runbook** (SECURITY.md) on real hardware, only after
      the full image + OTA flow is validated on dev boards. The first boot burns eFuses
      irreversibly.

## Transport / discovery

- [ ] **Reconcile mDNS discovery with public-CA HTTPS.** Discovery now yields an
      `https://<host>.local` URL, which a public CA cannot certify; the reliable path is
      an operator-configured FQDN. Decide whether to keep mDNS as a best-effort fallback
      or gate it behind a private-CA / cert-pinning build.

## Server / API hardening

- [ ] **Tighten the Content-Security-Policy.** `next.config.ts` sets a non-breaking
      subset today (`frame-ancestors`/`base-uri`/`object-src`/`form-action`) alongside
      HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and
      `Permissions-Policy`. Add a real `script-src`/`style-src` lockdown via per-request
      nonces (prod-only — Next's dev HMR needs `unsafe-eval`).
- [ ] **Enforce the trusted-proxy assumption for `X-Forwarded-For`.** Rate limiting keys
      on the first XFF hop; if the app is ever exposed without a proxy that overwrites
      XFF, limits are trivially bypassed. Require a trusted proxy in the deploy docs, or
      gate XFF parsing behind an explicit `TRUST_PROXY` setting.
- [ ] **Move rate limiting to a shared store** (e.g. Redis) so limits hold across
      multiple server instances — the current limiter is in-memory / per-process.
