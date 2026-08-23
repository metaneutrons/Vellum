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
  - Shipped in the meantime: `unit` and `role` as optional fields on a STATIC
    name-plate seat, rendered as one line below the name and costing no height when
    empty. Deliberately not on calendar seats, because a booking carries neither and
    a desk booked for an afternoon should not advertise a function title. Note the
    row layout used from two seats up does not draw them at all, since it has one
    line per seat.
  - Two ways out, both organisational rather than technical. Either the university
    defines an anny customer field, since the mechanism exists and is unused, or
    Vellum gets its own app registration in the HS Hannover tenant and reads
    `jobTitle`/`department` there. Revisit only when one of those is agreed; a Graph
    enrichment built against today's fill rate would be blank for most people.

- [x] **The built-in mono theme rendered the name plate invisible on the E1001
      (fixed for the two unambiguous tokens).** `resolveTheme(2)` returns
      `THEME_MONO`, whose `footerText` and `slotSecondary` were `#888888`, and
      `snapThemeToPalette` maps mid-grey to WHITE on a two-colour palette because
      white is the nearer of the two in RGB distance. The name plate draws the
      occupant in `footerText`, so a 7.5" panel drew white on white: a render
      counted **0** ink pixels below the header band against 28 884 on the E1002.
      Both tokens are now `#000000`, because on a two-colour panel a secondary rank
      is a smaller size and a lighter weight, not a lighter tone.

- [x] **The mono theme's remaining mid-tones are gone, and the repair turned out to
      belong at the point of USE rather than in the theme.** A theme holds one text
      colour for pairs of grounds that need opposite ones: the badge's ground is
      `busyBadge` or `freeBadge`, an event block's is `eventBg` or `busyBadge`, and a
      single `badgeText` or `slotText` has to sit on both. Whatever the value, one of
      the two states drew text on its own colour. `readableOn` in `lib/theme.ts` now
      keeps the operator's choice above 3:1 (the WCAG floor for large text, and
      e-paper only reaches about 10:1 to begin with) and substitutes black or white
      below it. `THEME_MONO.eventBg` also stopped claiming `#444444` when the panel
      showed black.
  - It repaired defects on ALL FOUR panels, not only the mono one. E1001: free badge
    white on white, both event blocks black on black, card subtitle black on black,
    four pairs at exactly 1.00:1, which is why the whole booking list rendered as
    featureless bars. E1002 and D1001: free badge white on bright green at 1.37:1,
    card subtitle black on blue at 2.44:1. E1003: card subtitle at 2.82:1.
  - Tuning the TOKENS instead was tried and is wrong: `slotSecondary` also labels the
    timeline's hour column and sets the name plate's captions, both on the white
    ground, so making it white for the blocks erased the hour column and would have
    erased the captions. The ground is only known at the point of use.

- [ ] **On the E1003 the badge colour says nothing.** `freeBadge` `#00FF00` and
      `busyBadge` `#FF0000` both snap to `#555555` on a 16-grey palette, so free and
      busy render identically and only the word distinguishes them. No contrast guard
      can fix that; it needs the badge to carry a second signal on greyscale panels,
      filled against outlined being the obvious one. Same question the name plate
      answered for itself by using a filled area for occupied and nothing for free.

- [x] **`/api/v1/admin/preview` now snaps the theme to the palette**, as the render
      route always did. Without it, preview and device disagreed by construction on
      any panel whose palette moves a theme colour, which is why the mono defect
      above showed up in no preview for months: every one of them drew the grey as
      grey.

- [ ] **The QR matrix is drawn by two copies of the same arithmetic.**
      `booking-qr.ts` now exports `drawQrMatrix`, used by the name plate;
      `room-booking.ts` still has the same module-size and quiet-zone maths inline
      in `renderBookingQr`, wrapped around that renderer's own panel layout and
      label. Unify by having `renderBookingQr` call the shared function. Left alone
      deliberately when the name plate was built, rather than refactoring a shipped
      renderer as a side effect of a different change.

- [x] **The narrow cut is installed, confined to the surname rank.** IBM Plex Sans
      Condensed Regular and Bold from `IBM/plex`, OFL 1.1, with the licence text in
      `assets/fonts/licenses`. Static cuts because a variable font is unusable here:
      measured on this canvas, asking one for `bold` gives identical ink (ratio
      1.000) since Skia does not instance the `wght` axis, while these two give 1.74.
      `choosePlan` offers the body family first and keeps whichever candidate yields
      the larger surname, so the narrow cut is used only where the width binds. Only
      that one rank changes face; a whole plate in the narrow cut would leave a
      corridor holding two kinds of sign.
  - Measured gain, 17 arcminutes as the threshold: it wins 5 of 9 panel-and-seat
    combinations at 12 to 16 %. D1001 portrait 1 and 2 seats 2.55 → 2.96 m, E1003 1
    seat 5.17 → 6.00 m and 2 seats 3.38 → 3.77 m, E1001 2 seats 2.67 → 3.00 m. The
    artifact's "about 20 %" was optimistic; 16 % is the honest figure.

- [ ] **Finish retiring `door-sign` and `door-sign-multi`.** Both are marked
      `deprecated`, gone from the create menu, refused by `createContentInstance` and
      labelled "stillgelegt"; they still render, so nothing broke. See
      `docs/door-sign-retirement.md` for the evidence, including that
      `door-sign-multi` has never had an instance and the single `door-sign` uses none
      of what the type is for while rendering a blank panel when the room is free.
  - Blocked on ONE thing: `SELECT type_slug, count(*) FROM content_instances GROUP BY
1` against PRODUCTION. Only the development database was visible, and removing a
    slug while any instance still names it makes the render route answer 500, which
    on a wall is a display that quietly stops updating.
  - Then migrate (`door-sign` → `name-plate` is mechanical), verify, and only then move
    the code. It is being kept rather than deleted because the free-positioning editor
    is most of a future free-form sign type; `KNOWN_DISPLAYS` should move to
    `lib/display.ts` rather than travel with it.

- [x] **`ROW_SHARE` was NOT too conservative; the earlier note here was wrong.** It
      claimed a row could reach `bandH / 0.72` because one line needs only its cap
      height. Measured, a row's ink spans **1.20 x the type size**, not 0.72: ascenders
      and accents rise above the cap and descenders fall below the baseline. At
      `ROW_SHARE = 0.8` a four-seat band of 61 px already carries 58 px of ink, 95 % of
      the band, and at size 55 the ink overruns it by 5 px and would strike the
      separators. The true ceiling is 0.833, so the constant sits at 96 % of it.
- [x] **The slack was the footer, and it has been reclaimed.** On a four-seat 7.5"
      plate half the panel went to furniture: header 75, footer 60, padding 58, gaps 45. Only a single-seat plate puts a state in the footer; with more seats each
      band carries its own pill and the strip holds one 20 px freshness line, for
      which 60 px was 13 % of the panel. The footer is now sized to what it carries,
      60 px with a state and 34 px without, and the bands get the difference:
      1 seat 3.74 -> 4.07 m, 3 seats 2.02 -> 2.23 m, 4 seats 1.43 -> 1.57 m. Two seats
      are unchanged because the width binds there. Ink still fits every band, checked
      per band rather than assumed.

- [x] **Every font in `assets/fonts` now carries its licence text**, and the
      declarations were read out of each font's own `name` table rather than copied
      from a download page. Inter 4.001 and IBM Plex Sans Condensed 3.000 are OFL
      1.1; Pixel Operator is **CC0 1.0**, not OFL, which the earlier note assumed.
      `assets/fonts/README.md` records family, version, licence and source per file,
      plus which face is used for what and the two measurements behind the condensed
      one.

- [ ] **The surname heuristic cannot detect surname-first order without a comma.**
      `name-split.ts` reads "Ćurić Nikola" as given name "Ćurić", surname "Nikola",
      and no rule fixes that without knowing the source's convention: a comma
      ("Ćurić, Nikola") is honoured exactly, and so is a shouted surname
      ("ĆURIĆ Nikola"), but bare surname-first order is genuinely ambiguous. The
      limitation is asserted in `name-split.test.ts` so that a future change has to
      confront it. Two ways out if it turns up in the field: a per-provider
      name-order setting, or Microsoft Graph's `surname`/`givenName` from the
      directory object rather than `displayName` from the event, which would need a
      lookup per organizer and the `User.Read.All` grant that already exists.

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
