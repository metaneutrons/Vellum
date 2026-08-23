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

## USB provisioning (zero-touch enrolment)

USB-serial provisioning (Improv Wi-Fi Serial over USB-Serial-JTAG) replaces the
SoftAP captive-portal flow: an operator flashes and provisions a device from the
WebUI over a cable, optionally minting a single-use voucher for zero-touch
auto-enrolment. Phases 0–2 plus the review-fix batch shipped on
`feat/usb-serial-provisioning` (PR #76): the memory-safety, liveness and
voucher-atomicity findings are closed, and vouchers now carry a 7-day
`expires_at` enforced in the claim predicate. Remaining, deliberately deferred as
design calls:

- [ ] **Bind a voucher to a MAC at mint time (review #10).** Today the first
      device to present an unclaimed, unexpired voucher wins it. Binding to a
      known MAC at mint closes the first-claimant window entirely, but needs an
      "enter the device MAC when minting" step in the WebUI. Expiry (shipped)
      already bounds the exposure window in the meantime.
- [ ] **Encrypt the device token in transit over USB (review #14).** The token
      crosses the cable in cleartext inside the Improv `WIFI_SETTINGS` frame.
      Wrapping it needs an on-device key exchange (e.g. reuse the X25519 handshake
      key before the token is delivered) rather than the plain length-prefixed
      string the Improv spec defines. Contained: the exposure is a local USB
      cable held by the operator, not the network.
- [ ] **Voucher revocation UI.** No way to invalidate an issued-but-unclaimed
      voucher before it expires. A "revoke" action (delete-if-unclaimed) is a
      small follow-up; expiry covers the common case.

## Content & displays

- [ ] **Organisational unit and position have no data source.** A door sign should
      be able to say "Präsidium" and "Vizepräsident", and both configured providers
      were queried on 2026-08-23 to find out whether they can supply it. Neither
      can. anny's customer object carries one free-text `company`, which reads
      "Hochschule Hannover" on 130 of 168 records and therefore says nothing on an
      internal door; `title` is empty throughout; `custom_entry_map` is empty on all
      168 customers and all sampled bookings, and `/custom-fields` returns no
      definitions; there are no `/teams`, `/groups` or `/departments` endpoints, so
      anny models no organisational structure at all. In Microsoft 365 the app
      already holds `User.Read.All`, so a lookup needs no new consent, but
      `department` is unset on every human in the tenant (only four Teams service
      principals carry it) and `jobTitle` is filled for 7 of 39 members. Worse for
      the case that prompted this: the operator's own object in that tenant is a
      GUEST (`…#EXT#@…onmicrosoft.com`), and a guest never carries its home tenant's
      attributes, so an HS Hannover role cannot appear through that provider however
      the code is written.

      Shipped in the meantime: `unit` and `role` as optional fields on a STATIC
              name-plate seat, rendered as one line below the name and costing no height when
              empty. Deliberately not on calendar seats, because a booking carries neither
              and a desk booked for an afternoon should not advertise a function title.

              Two ways out, both organisational rather than technical. Either the university
              defines an anny customer field, since the mechanism exists and is unused, or
              Vellum gets its own app registration in the HS Hannover tenant and reads
              `jobTitle`/`department` there. Revisit only when one of those is agreed; a
              Graph enrichment built against today's fill rate would be blank for most
              people.

- [ ] **The built-in mono theme renders text invisible on the E1001.**
      `resolveTheme(2)` returns `THEME_MONO`, whose `footerText` and `slotSecondary`
      are `#888888`, and `snapThemeToPalette` maps mid-grey to WHITE on a two-colour
      palette because white is the nearer of the two in RGB distance. The name plate
      uses `footerText` for the occupant, so on a 7.5" panel it draws white on white:
      a render counted **0** ink pixels below the header band against 28 884 on the
      E1002. `room-booking` uses the same two colours and loses text there too. The
      fix is small, namely no mid-tone in `THEME_MONO` (secondary rank is expressed
      by size and weight, not tone), but it changes output for every mono device, so
      it wants a deliberate decision plus a per-panel regression test.

- [ ] **`/api/v1/admin/preview` does not snap the theme to the palette.** The render
      route calls `snapThemeToPalette`; the preview route does not. Preview and
      device therefore disagree by construction on any panel whose palette moves a
      theme colour, which is why the mono defect above never showed up in a preview.
      Fix alongside it, or the fix cannot be verified from the admin UI.

- [ ] **Trim directory values before rendering them.** The lexICT tenant contains a
      `jobTitle` of `"Consultant "` with a trailing space. Harmless today because
      nothing renders it, and a trap the moment anything does.

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

## Build / tooling

- [x] **Migrate the package manager npm → pnpm.** pnpm is version-pinned in
      `package.json`; `pnpm-lock.yaml` is the single JavaScript lockfile, CI and
      Docker use frozen installs, and `pnpm-workspace.yaml` uses pnpm 11's
      deny-by-default `allowBuilds` policy. The standalone Next.js output and
      native `@napi-rs/canvas` tracing are verified by the production build.

## Path to 100 — enterprise scorecard

Follow-through from the enterprise audit (24 findings remediated across #50–#58;
score 63 → 87). Dashboard: <https://claude.ai/code/artifact/66871cf4-cb7b-41c5-853b-3b8d3e768601>.
Each area lists what closes the gap to a perfect score. Items already tracked in
the sections above are cross-referenced, not duplicated.

### Auth & Crypto (87 → 100)

- [ ] Rotating device tokens via a signed-challenge re-key (tokens never rotate today).
- [ ] NVS-encrypted key storage in production so the X25519 private key isn't cleartext at rest (see Production hardening).
- [ ] RFC 7748 / 8032 conformance vectors + an AES-GCM nonce-uniqueness audit.
- [ ] Anomaly rate-limiting on `/hello` enrolment attempts.

### OTA & Firmware Trust (88 → 100)

- [x] **OTA key-revocation membership host-tested** (#65) — exact-length match, no `key1`/`key10` false-match.
- [ ] Validate Secure Boot v2 + Flash-Enc on hardware — see _Production hardening → Phase B.5_ above.
- [ ] On-hardware signed-image OTA smoke test — see _Firmware & OTA_ above.
- [ ] Real-signed-image OTA digest KAT — see _Production hardening_ above.
- [ ] Wire KMS/HSM signing (Phase 3) end-to-end + a multi-key rotation drill; verify the anti-rollback eFuse counter blocks a downgrade.

### Server / API (88 → 100)

- [x] **safeFetch DNS-rebinding TOCTOU closed** by connect-time IP-pinning — an undici Agent whose `lookup` re-validates and pins the resolved IP, making validation and connect atomic (#71).
- [ ] End-to-end route tests (device↔server) driven by a simulated device; fuzz `/hello`, `/config`, `/report`.
- [ ] Correlation-ID request tracing + a structured error taxonomy.
- [ ] (See also: CSP lockdown, XFF trusted-proxy, shared rate-limit store above.)

### Data Model (85 → 100)

- [ ] Migration up/down + rollback tests in CI against a throwaway Postgres.
- [ ] PII retention + scrubbing policy for booking subjects / organizer names.
- [ ] A tested backup/restore runbook; constraint / index / FK-cascade audit.

### Firmware Robustness (87 → 100)

- [x] **OTA key-revocation host-tests added** (#65) — suite now 19 tests.
- [ ] Enable NVS + Flash Encryption for production images (`SECURE_PROFILE=prod`).
- [ ] Power-loss-during-OTA fault-injection tests.
- [ ] Extend host-tests to `nvs_manager`, `http_client`, `sleep` + a watchdog-coverage audit of long ops.

### CI/CD & Supply Chain (87 → 100)

- [x] **Firmware host-tests + build are REQUIRED branch-protection checks** (#66) — a red host-test can no longer merge (as #56 did).
- [x] **Reproducible dependency installs** (M#13). All CI jobs and the
      `Dockerfile` run `pnpm install --frozen-lockfile` against the committed
      `pnpm-lock.yaml`; dependency build scripts are restricted by `allowBuilds`.
- [ ] Make SLSA provenance + SBOM _gating_ checks, and add Snyk. Both are already emitted (firmware `attest-build-provenance@v2`; docker `sbom: true` + `provenance: mode=max`), but nothing verifies them in-pipeline; Snyk is genuinely absent.
- [ ] Signed tags/commits + a dependency-review gate.

### Testing & QA (88 → 100)

- [x] **Firmware host-test suite grown 13 → 19 and merge-blocking on every PR** (#65, #66).
- [x] **Coverage ratchet gate** enforced in the required Test check — vitest v8 thresholds set just below current, so coverage can only hold or improve (#70).
- [ ] Device↔server E2E + firmware on-target smoke (HIL/QEMU); mutation testing to prove the suite catches regressions.

### Observability (80 → 100)

- [ ] OpenTelemetry traces + metrics and a fleet-health dashboard.
- [ ] Alerting on OTA-failure and auth-anomaly spikes.
- [ ] Correlation IDs end-to-end; scrub PII from logs; a defined structured-log retention policy.
