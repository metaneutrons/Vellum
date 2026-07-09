# Roadmap

Planned / open work. Completed enterprise-hardening and the OTA release-path fix
landed in #28 (see [SECURITY.md](SECURITY.md) for the resulting security model).

## Firmware & OTA

- [ ] **Build & validate the ESP32-P4 / D1001 target.** Only ESP32-S3 (e1002)
      has been compile-verified after the hardening + OTA-release changes. Run the
      P4 build (or the full `firmware.yml` matrix) and confirm the app-image / merged-image
      split behaves on P4.
- [x] **OTA signing key — configured.** The `FIRMWARE_SIGNING_KEY` CI secret exists
      (since 2026-04-25) and the committed `firmware-signing.pub` matches the embedded
      `CONFIG_VELLUM_OTA_SIGNING_PUBKEY`; CI signs both beta and stable builds. Follow-ups:
    - [ ] Confirm the secret's *private* half corresponds to that pubkey — the new CI
          key-match guard verifies this on every signed build and fails loudly on
          mismatch (first exercise: the beta build from the #28 merge).
    - [ ] **Back up the private key offline.** It was NOT found in the usual local stores
          (repo / `~/.env_vars` / infrastructure vault). If the GitHub secret is the only
          copy, losing it means no fielded device can be updated without a re-flash —
          store it in an HSM/vault per SECURITY.md.
- [ ] **End-to-end OTA smoke test on hardware.** Cut a beta (or `workflow_dispatch`
      `firmware.yml`) and confirm a device downloads → verifies (SHA-256 + Ed25519) →
      applies → confirms, with bootloader rollback on failure.

## Production hardening (eFuse-burning — manufacturing)

- [ ] **Wire the Secure-Boot production profile into a manufacturing build.**
      `sdkconfig.defaults.prod` enables Secure Boot v2 + Flash/NVS encryption +
      anti-rollback. **Caveat:** with Secure Boot the app-image layout changes, so the
      OTA digest can no longer be read as the last 32 bytes (`tail -c 32`) — it must come
      from `esptool image-info` / the image metadata, and the bootloader's own verified
      boot largely makes the app-level Ed25519 check redundant. Revisit the OTA signing
      step when this profile goes into CI.
- [ ] **Execute the eFuse burn runbook** (SECURITY.md) on real hardware, only after
      the full image + OTA flow is validated on dev boards. The first boot burns eFuses
      irreversibly.

## Transport / discovery

- [ ] **Reconcile mDNS discovery with public-CA HTTPS.** Discovery now yields an
      `https://<host>.local` URL, which a public CA cannot certify; the reliable path is
      an operator-configured FQDN. Decide whether to keep mDNS as a best-effort fallback
      or gate it behind a private-CA / cert-pinning build.
