# CLAUDE.md

Guidance for Claude Code (and any fresh AI session) working in the **Vellum** repo.

Vellum = a **Next.js server** (admin UI + OTA firmware distribution for E-Ink
room-booking displays) + **ESP32 firmware** (`firmware/`). AGPL-3.0. Repo
`metaneutrons/Vellum`. (This nests under the workspace-level
`/Volumes/Dev/Source/CLAUDE.md`.)

## Repo layout / worktree

- Server code is `src/` (Next.js App Router). Firmware is `firmware/` (ESP-IDF).
  Docs in `docs/`, plus `README.md`, `ROADMAP.md`, `SECURITY.md`. Production
  deployment stack (compose + update sidecar) in `deploy/`.
- This repo is worked in **many linked git worktrees** (~20 at time of writing),
  and `/Volumes/Dev/Source/Vellum` is frequently NOT on `main`. **Always run
  `git worktree list` and `git rev-parse --abbrev-ref HEAD` first** — do not
  assume the directory you are in is `main`, and do not assume `main` is in the
  clone with the plainest name. Many stale branches are already squash-merged;
  check a branch against merged PRs before assuming its work is unlanded.

## Server (Next.js): build / test

- Node **22.13+** for dev/CI (`.nvmrc`, consumed via `node-version-file`). The
  production Docker image builds & runs on **node:26-alpine** (`Dockerfile`,
  pinned by digest). Two different Node versions — don't assume one everywhere.
- Install exactly with `pnpm install --frozen-lockfile` (CI + Docker parity).
  pnpm is pinned in `package.json` (`packageManager`); `pnpm-lock.yaml` is the
  only JavaScript lockfile. `pnpm-workspace.yaml` denies dependency lifecycle
  scripts by default and allows only reviewed native/tooling packages. Do not
  bypass the allowlist with `--dangerously-allow-all-builds`.
- Node 25+ no longer bundles Corepack (the `Dockerfile` installs pnpm globally
  instead). Do not add `corepack enable` to instructions — it fails on current
  Node; CI uses `pnpm/action-setup`.
- Scripts (`package.json`): `dev`, `build`, `start`, `lint` (`eslint .`),
  `typecheck` (`tsc --noEmit` — the canonical type-check), `test`
  (`vitest --run`), `test:coverage`, `i18n:check`, `release:check`,
  `db:check`, `db:generate`, `db:migrate` (the idempotent `scripts/migrate.mjs`
  runner), `dev:mdns` / `mdns`.
- **`.githooks/pre-push` runs `i18n:check`, `typecheck`, `release:check` (and
  `db:check`)** — each is also a required CI job. Run them before pushing or the
  hook will surprise you.
- Tests: ~two dozen vitest suites (`pnpm test` for the exact count), node
  environment, fully self-contained — **NO Postgres / testcontainers / docker**.
  The workspace-wide snapdog note "tier-2 tests need `DOCKER_HOST=colima
  socket`" does NOT apply to Vellum.
- Coverage is a **ratchet gate** (`vitest.config.ts`): statements 55 / branches
  44 / functions 44 / lines 56, enforced by the required CI "Test" job. Raise,
  never lower.
- Runtime env (`.env.example` + `deploy/vellum.env.example` are the source of
  truth): `DATABASE_URL`, `ENCRYPTION_KEY`, `SESSION_SECRET`, `ADMIN_API_KEY`
  (all **min 32 chars**), `ADMIN_USER`, `ADMIN_PASS` (min 8), `NODE_ENV`,
  `LOG_LEVEL`; optional `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` /
  `ENTRA_CLIENT_SECRET` + `VELLUM_PUBLIC_URL` (Entra OIDC), `UPDATER_URL` /
  `UPDATER_TOKEN` (update sidecar), `TRUST_PROXY_HEADERS` (**set `false` on a
  directly-exposed instance** or `X-Forwarded-For` can be spoofed to bypass rate
  limits — `src/lib/rate-limit.ts`; it is missing from both env templates).
  Validated at boot in `src/lib/env.ts` / `src/lib/session.ts`; a failure
  `process.exit(1)`s. Workspace convention: real secrets live in `~/.env_vars`,
  never in-repo.

## Schema ↔ migration parity (invariant)

`scripts/migrate.mjs` applies the raw `drizzle/*.sql` files in order and records
them in `__vellum_migrations`. Consequences:

- **A column added to `src/db/schema.ts` needs a hand-written migration.**
  Nothing else catches a missing one: the migrator never reads the model, `tsc`
  only type-checks the model, and the test suite runs without Postgres. This
  actually shipped broken — `devices.orientation_override` had no migration for
  ~3 months, taking out `/api/v1/ink/render` on fresh databases.
- **Do NOT trust `pnpm db:generate`.** `drizzle/meta/` snapshots stop at `0005`
  while migrations run past `0010`, and those snapshots already list columns the
  SQL never creates — so drizzle-kit believes they exist and will never emit
  them. Migrations here are hand-written by convention; keep them idempotent
  (`ADD COLUMN IF NOT EXISTS`) and forward-only (there are no down migrations).
- `pnpm db:check` (`scripts/check-schema-migrations.mjs`, CI "Schema Guard")
  asserts every `schema.ts` column is created by some `drizzle/*.sql`.
- Migration numbering has a historical gap; use the next free number, and expect
  server-rendered pages to guard optional columns with a fallback query.

## Firmware: build

- Toolchain: **ESP-IDF v6.0**. Local build: `make build MODEL=<model>` from
  `firmware/` (default `MODEL=e1002`). CI builds in docker `espressif/idf:v6.0`.
- ⚠️ **The Makefile hardcodes the maintainer's absolute paths** (`IDF_ACTIVATE :=
  source /Users/fabian/.espressif/tools/activate_idf_v6.0.sh > /dev/null 2>&1`
  and `IDF_PATH=/Volumes/Dev/esp-idf/v6.0/esp-idf`, `firmware/Makefile:72-73`).
  They are `:=` (not overridable) and the redirect **swallows the failure**, so
  on any other machine you get a confusing downstream `idf.py` error instead of
  "ESP-IDF not found". Fix the Makefile rather than chasing the symptom.
- **Always pass `-DVELLUM_MODEL=<model>`** (Makefile + CI do). It bakes the
  app-descriptor `project_name` `vellum-<model>` used by the OTA anti-brick
  cross-model check. A bare `idf.py build` falls back to generic
  `vellum-firmware` and **silently disables that check** — a wrong-model image
  would pass signature verify and could brick a device (`CMakeLists.txt:14-31`).
- **4 models** (`firmware/Makefile:40-60`, `firmware.yml` matrix):
  | Model | Chip | Panel / controller | Display | USB serial transport |
  |-------|------|--------------------|---------|----------------------|
  | `e1001` | ESP32-S3 | GDEY075T7 / UC8179_BW | mono 800×480 (panel does 4-gray) | **CH340C → UART0** |
  | `e1002` | ESP32-S3 | GDEP073E01 / ACeP (see palette note) | 800×480 (default build) | **CH340C → UART0** |
  | `e1003` | ESP32-S3 | ED103TC2 / IT8951 | **16-gray / 4bpp, 1872×1404** | **CH340K → UART0** |
  | `d1001` | **ESP32-P4** + ESP32-C6 (Wi-Fi via `esp_wifi_remote`/ESP-Hosted) | JD9365 MIPI-DSI **LCD** | 800×1280 | **native USB-Serial-JTAG** |
  **Every S3 model needs its console overlay** (`sdkconfig.defaults.e1001` /
  `.e1002` / `.e1003` on top of `sdkconfig.defaults.s3`) — they differ by more
  than panel Kconfig. A model without one silently inherits the base
  `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`, which is wrong for all three.
- **USB-C wiring is per-model and drives two separate behaviours — get it right
  before debugging provisioning or power.** Hardware-confirmed 2026-08-12:
  **no E-Series model uses native USB.** E1001 and E1002 terminate USB-C at a
  **CH340C**, E1003 at a **CH340K**, all on UART0 — so the browser and any
  serial monitor see `/dev/tty.wch*`. Only **D1001** is genuinely native
  (`/dev/cu.usbmodem*`). This was mis-documented for months: E1003 was corrected
  in #119, E1002 in #126, and E1001 only after a hardware check — it had no
  overlay at all, so its console and Improv frames went to a USB peripheral that
  is not wired to the connector and USB provisioning could not work.
- Consequence for power: `usb_serial_jtag_is_connected()` **can never observe
  host presence on any E-Series board** (their native USB pins go nowhere).
  E1002/E1003 therefore read USB power from the **SY6974B charger over I²C**
  (`components/board/board.c` `charger_reports_usb_power()`, host-tested in
  `test_sy6974b_power.c`; note the I²C pins differ per model — e1002 SDA39/SCL40,
  e1003 SDA19/SCL20). ⚠️ **E1001 still falls through to the USJ branch, so
  `board_is_usb_powered()` is permanently false there** — the low-battery gate
  can deep-sleep a USB-powered E1001. Fixing it needs E1001's charger I²C pins
  from the schematic; do not guess them. A "fix" that routes either console or
  USB-power detection uniformly across models WILL break several.
- Panel-capability inconsistencies — **unresolved, do not "fix" one side blindly;
  confirm against the physical panel first**:
  - E1003 is **1872×1404** in code and on the server, but
    `main/Kconfig.projbuild:19` labels it `1404x1872`. (Label is the odd one out.)
  - **E1002 is a 6-colour panel (hardware-confirmed), but the firmware reports a
    7-entry palette including orange** — `http_client.c` sends
    `{black, white, yellow, red, orange, blue, green}` while the driver correctly
    declares `.ctrl = EPD_CTRL_ACEP_6COLOR`. README's "Spectra 6 … 7 colors" is
    wrong for the same reason (Spectra 6 has no orange). **Do not just delete the
    orange entry**: the palette array index *is* the on-wire pixel code
    (`EPD_PIXEL_BLACK 0x0` … `ORANGE 0x4`, `BLUE 0x5`, `GREEN 0x6` in
    `epaper_config.h`), so removing an element shifts blue and green onto the
    wrong codes. Fixing it needs the panel's real 6-colour code assignment from
    the GDEP073E01 datasheet (does 0x4 become blue, or stay unused?). Until then
    every rendered E1002 image can be mis-quantised toward a colour the panel
    cannot show. `src/lib/display.ts` also carries a 7-entry e1002 palette in a
    *different order* than the firmware's; runtime uses the device-reported one,
    so the registry copy only skews the simulator/preview.
  - **E1001's panel does 4-level grayscale (hardware-confirmed) but the firmware
    drives it 1-bit mono** (`PANEL_BPP 1`, `PANEL_COLORS "mono"`, `UC8179_BW`;
    server palette is 2 entries). The library already has `EPD_COLOR_4GRAY`, so
    this is unexploited capability, not a hardware limit — switching would change
    the payload from 48 KB to 96 KB per refresh.
- Server-side `src/lib/display.ts` is a **static registry** used by the flash UI,
  simulator and preview; the E-Series firmware actually reports
  `orientations: []` (fixed). Runtime rendering resolves device-reported caps via
  `resolveDisplayCaps()`, so the registry's `["portrait","landscape"]` for e1003
  is intent, not an enforced capability — there is no rotation path in the
  e-paper display component.
- Display backend is a **3-way split**, not one esp_epaper: `panel_epaper.c`
  (S3 e-paper: custom `epaper_uc8179` for e1001/e1002, `epaper_it8951` for e1003)
  + `panel_lcd.c` (P4 d1001 LCD). `components-epaper/epaper_uc8179` is a
  **vendored fork** of `tuanpmt/esp_epaper` — do NOT re-pull it from the ESP-IDF
  registry (would clobber Vellum's added `uc8179_bw.c` / `ed103tc2.c`). Note the
  registry copy is still *declared and linked* alongside the fork
  (`components/vellum_display/CMakeLists.txt`) — a real cleanup, not just a doc
  nit. `components-lcd/esp_io_expander_pca9535` is likewise **vendored because
  the registry version fails on IDF 6.0**; its README (verbatim upstream) tells
  you to `idf.py add-dependency` it — don't.
- **D1001 renders JPEG, not raw pixels.** `panel_lcd.c` decodes JPEG
  (`esp_jpeg_decode()`) into RGB565; the server sends `image/jpeg` for `d1001`
  (`src/lib/display.ts`, `api/v1/ink/render`). Only the S3 e-paper path takes a
  raw buffer. `docs/firmware-display-architecture.md` still claims raw RGB565 —
  it is wrong, and `panel_lcd.c` does no size validation.
- **Secure Boot builds are opt-in**: `make build SECURE=1 SECURE_PROFILE=<rung>`
  climbs a 3-rung ladder (`testsecure` → `secureboot` → `prod`); default rung is
  the reversible one. **ESP32-S3 only** — `firmware/Makefile:80` hard-errors on
  `esp32p4`, so d1001 has no Secure Boot path. Every `SECURE=1` build is
  **unsigned** by design (`BUILD_SIGNED_BINARIES=n`); images are signed
  out-of-band by KMS. See `docs/SECURE_BOOT_AND_KMS.md` (accurate).
- Firmware **host tests** (pure logic/crypto, no ESP-IDF):
  `cmake -S firmware/host_test -B firmware/host_test/build && cmake --build
  firmware/host_test/build && ctest --test-dir firmware/host_test/build`.
  Needs CMake ≥3.16, C11, OpenSSL. Golden vectors regenerated by
  `node firmware/host_test/scripts/gen_kat.mjs`.
- `firmware-pr-build.yml` = compile-only smoke check for **all 4 models** on
  every `firmware/**` PR — catches model-specific Kconfig and `-Werror` breaks
  before release.
- `firmware-host-test.yml` runs on EVERY push/PR to main with **no path filter
  on purpose** (required check; path-filtering would wedge unrelated PRs in
  "Expected — Waiting for status"). `host_test/README.md` states this correctly.

## Release: TWO components, separate PRs

Driven by `release-please-config.json` + `.release-please-manifest.json`
(config-file mode), workflow `release-please.yml`. **`secrets.RELEASE_PAT` is
mandatory and fails closed** — `release-please.yml` `exit 1`s when it is empty,
and `pnpm release:check` asserts that no `|| secrets.GITHUB_TOKEN` fallback is
reintroduced (a fallback would produce plausible-looking releases with no
container or firmware assets).

- **Server** = component `server`, package `.` (release-type `node`,
  `exclude-paths:["firmware"]`, tag `vX.Y.Z`) → `docker.yml` (multi-arch
  amd64+arm64, SBOM + SLSA provenance, cosign keyless, `release-presentation`
  moves `latest`), `updater.yml` (the second image, `vellum-updater`), and
  `deployment-assets.yml` (versioned `docker-compose.yml`, `vellum.env.example`,
  `SHA256SUMS`; blocks on `cosign verify` of **both** images and rejects
  `:latest` pins).
- **Firmware** = package `firmware` (release-type `simple`,
  `include-component-in-tag`, `tag-separator "-"`, tag `firmware-vX.Y.Z`) →
  `firmware.yml` (4-model matrix, Ed25519-signs each OTA image, SLSA
  provenance, uploads `firmware-manifest.json` **last** so a device polling
  mid-publish never sees a manifest before its assets).
- release-please routes each commit by path: `firmware/**` → firmware component;
  everything else → server. A server `fix:` does NOT rebuild firmware and vice
  versa. The two components are independent — **no merge order is required.**
- `separate-pull-requests: true` yields one PR per changed component on branches
  `release-please--branches--main--components--{server,firmware}`. **The server
  PR title does NOT contain the word "server"** (`chore(main): release 1.9.5`) —
  that is structural, because `include-component-in-tag: false` empties
  `${component}` for `.`; only firmware renders it. Do not "fix" this by setting
  `include-component-in-tag: true` on `.`: server tags would become
  `server-vX.Y.Z` and break `deployment-assets.yml` + `docker.yml` tag gates
  (`release:check` fails first).
- **Either merge style works.** Squash and merge-commit release PRs both cut
  releases correctly — `scripts/classify-release-commit.mjs` is a shared,
  component-aware classifier used by `firmware.yml`, `docker.yml` and
  `updater.yml`, with fixtures for both forms in `scripts/check-release-config.mjs`.
  (Historical: an old grouped-PR config with an empty component left server
  releases merged-but-untagged; that was fixed in #158. **Do NOT hand-create
  releases or relabel `autorelease:` any more** — it corrupts release-please
  state, and `gh release create --latest` would steal the Latest badge that
  `docker.yml`/`firmware.yml` manage.)
- Firmware version **SSOT**: the `firmware` key in
  `.release-please-manifest.json` → `firmware/main/Kconfig.projbuild`
  `default "X.Y.Z" # x-release-please-version`. Read the manifest for the
  current value; **never hard-code a version in documentation** (both
  `docs/RELEASING.md` and `firmware-refactor-tasks.md` currently violate this).
  `firmware/version.txt` is gitignored + build-generated and NOT authoritative.
- `firmware.yml` `if:`-gotchas — don't "fix" them into misfiring: the `version`
  job skips server (`v*`) releases; `build`/`sign-and-release` then skip via
  default `success()` gating (adding `always()`/`!cancelled()` would run firmware
  on server releases). The release-please push skip is now
  `release_component == 'none'` from the classifier — a bare
  `release-please--branches` is **deliberately not** a marker (only the
  component-qualified branch is).
- Historical tag note: `firmware-v1.2.0` is an anchor tag with **no** GitHub
  Release (fleet never sees it); `firmware-v1.2.1` was the first real release in
  that lineage.
- See `docs/RELEASING.md` for the full model (accurate, apart from a stale
  "firmware version of record" paragraph).

## Fleet OTA discovery invariant

Devices discover firmware by the **PRESENCE of a `firmware-manifest.json` ASSET
on a GitHub Release** (`src/lib/firmware.ts`, newest-first walk, stop at first
STABLE release carrying the asset), **NOT by tag name or `latest`**. Server `v*`
releases carry no manifest → skipped. Walk is bounded (`MAX_RELEASE_PAGES=40`),
with a page-1 ETag fast-path + permanent per-release manifest cache. Do NOT
refactor this to tag/`latest` logic — it would break OTA and re-surface the
anchor tag to the fleet.

## Renderer sort-invariant

Room-booking timeline: calendar providers do NOT guarantee event ordering, and
the greedy sweep-line column-packer is only correct in start-time order
(unsorted input renders non-overlapping events as full-width + half-width — the
fixed regression). **Always route layout through `computeTimelineLayout()`**
(`src/lib/content/renderers/room-booking.ts`), which sorts a copy first. Never
hand-feed events to a packer assuming order. Regression covered by
`src/lib/content/renderers/__tests__/room-booking-layout.test.ts`.

## Provisioning (current reality)

- **USB-serial provisioning (Improv Wi-Fi Serial) is the PRIMARY onboarding
  path**, replacing SoftAP as the intended flow. Operator flashes + provisions
  from the WebUI over a cable: Admin → Firmware → **Flash Device**
  (`flash-tool.tsx`, ESP Web Tools) then **Provision over USB**
  (`provision-tool.tsx`, Web Serial API). Protocol client:
  `src/lib/provisioning/improv-serial.ts`. Firmware side:
  `firmware/components/vellum_serial/` (which has a thorough, accurate README —
  read it before touching the protocol). Per-model transport is in the model
  table above; **it is not uniform**, and getting it wrong sends you to the
  wrong layer when provisioning fails.
- The one stream carries **binary Improv frames interleaved with a text
  console**, so line-ending translation MUST stay disabled
  (`ESP_LINE_ENDINGS_LF` on both JTAG and UART) or frames get corrupted. Console
  commands: `wifi`, `server`, `token`, `info`, `nvs-erase`, `reboot` (+ `help`).
- `WIFI_SETTINGS` carries **six** length-prefixed strings: SSID, password,
  server URL, device token, NTP override, UTC timestamp. Vellum adds a
  non-standard Improv error `INSECURE_URL (0x04)`: an `http://` server URL aborts
  provisioning unless `CONFIG_VELLUM_ALLOW_INSECURE_PRIVATE_HTTP` is built in
  (`make build DEV_HTTP=1`) — the likeliest field failure.
- **SoftAP is NOT removed and NOT model-gated** — every model, D1001 included,
  falls back to an open AP + captive DNS when NVS has no Wi-Fi credentials
  (`firmware/main/main.c:580-591`, `wifi_manager.c`). `vellum_serial_init()`
  runs on every boot (`main.c:489`), unconditionally — there is no Secure
  Boot/prod gate on the console, so a cable always reaches `token` and
  `nvs-erase` (SECURITY.md claims otherwise; SECURITY.md is wrong).
- **Optional zero-touch voucher** (`provisioning_vouchers`,
  `src/db/schema.ts:272`): mint via `createProvisioningVoucher()` in
  `src/app/admin/actions.ts`. The voucher token **IS the device bearer token**,
  sent in **cleartext** in the Improv frame. Claim is single-use and atomic
  (bound to first presenting MAC; enrol+claim in one transaction —
  `src/lib/auth/index.ts`). The mint path **always** sets a 7-day expiry;
  `expiresAt = NULL` exists only for legacy rows. It can also pin a firmware
  channel/version applied on claim. The device then enrols via
  **`POST`** `/api/v1/ink/hello` (no `GET`); post-approval the handshake public
  key is frozen (MAC-spoof protection).
- Open trade-offs (`ROADMAP.md`): voucher not MAC-bound at mint; Wi-Fi creds +
  token cross USB in cleartext; no voucher revoke/delete UI.

## Access control (server)

`src/proxy.ts` is only the outer gate (signed session cookie or `x-api-key`).
The real authorization boundary is per-route `requestHasPermission`, backed by
`admin_users`, `access_roles`, `role_permissions`, `user_role_assignments`,
revocable `admin_sessions`, `admin_invitations`, `oidc_identities`,
`service_accounts`, `audit_logs` (`src/db/schema.ts`, `src/lib/access/`): 7
system roles, 21 permissions, scrypt password hashing, Entra OIDC
(`src/app/api/auth/oidc/entra/`), `vls_` service-account tokens.
**`ADMIN_API_KEY` currently resolves to a wildcard (`*`) bootstrap principal**
marked "transitional compatibility only" in `src/lib/access/index.ts` — treat it
as a root credential. `admin_users.mfa_required`/`mfa_enrolled_at` exist in the
schema but **MFA is not implemented**, and **passkeys are not implemented**
either (only an unread `access.passkeyPolicy` setting) despite the README
advertising them.

## Signing — two INDEPENDENT trust chains (don't conflate)

- **OTA app signature** = Ed25519 (pure EdDSA over the device-computed 32-byte
  digest), verified in software by `ota_manager.c` via **libsodium**
  (`crypto_sign_verify_detached`) — not PSA, which cannot import Ed25519 keys in
  IDF 6.0. Public key: repo-root `vellum-firmware-signing.pub` (PEM SPKI) whose
  raw 32 bytes equal the Kconfig `CONFIG_VELLUM_OTA_SIGNING_PUBKEY` default. One
  key signs all 4 models. There is a **2-slot rotation trust store** plus a
  **revocation list** (`CONFIG_VELLUM_OTA_REVOKED_KEY_IDS`).
- **Secure Boot v2** = RSA-3072-PSS, verified by ROM/bootloader. Gated behind
  `OTA_SECURE_BOOT` in `firmware.yml` + `partitions.secure.csv`; S3 only.
  Phase 3 (Secure Boot on hardware + KMS/HSM) is still OPEN per ROADMAP.
- Private keys live in **cloud KMS via GitHub OIDC (keyless)**;
  `OTA_KMS_KEY_VERSION` preferred, `FIRMWARE_SIGNING_KEY` secret is the legacy
  fallback. `firmware/keys/` + `vellum-firmware-signing.pub` hold PUBLIC
  material only (public keys and eFuse digests **are** committed on purpose, so
  a KMS key deletion cannot orphan the fleet); `*.pem` / `*.key` / `*.der` /
  `hsm_config.ini` are gitignored.

## Doc trust notes (as of the 2026-08-12 audit)

Every doc listed as stale in the previous edition of this section has since been
fixed. **Accurate now**: `docs/RELEASING.md` (minus one stale firmware-version
paragraph), `docs/SECURE_BOOT_AND_KMS.md`, `docs/DOCKER_DEPLOYMENT.md`,
`README.md` (minus the items below), both CHANGELOGs,
`firmware/components/vellum_serial/README.md`, `firmware/host_test/README.md`,
`firmware/keys/README.md`, `ADDING_PANELS.md`, `epaper_uc8179/README.md`.

**Known-wrong — verify against source before trusting:**

- `SECURITY.md` (oldest top-level doc, predates RBAC/OIDC, the update sidecar
  and the D1001 work): claims the USB console is "locked out by Secure Boot" (it
  is not, see Provisioning); states an absolute "never over plaintext" while a
  `DEV_HTTP=1` build profile exists; §5's Secure Boot runbook generates a local
  signing key and flashes an **unsigned** image, skipping the supported
  `make build SECURE=1` ladder — dangerous, it precedes an irreversible eFuse
  burn; §7 describes only the old single-admin model; misattributes OTA
  verification to PSA; no supported-versions table; no reporting channel.
- `README.md`: advertises **passkeys** (not implemented); says "production
  firmware enables encrypted NVS" though release images never include the `prod`
  profile (NVS is unencrypted in everything the flash tool and OTA serve);
  documents `corepack enable`, which fails on current Node. (Its USB statement —
  "E-Series devices expose USB through a UART bridge; D1001 uses its native USB
  interface" — is **correct**; CLAUDE.md was the file that had this wrong.)
- `docs/firmware-display-architecture.md`: D1001 documented as raw RGB565 (it is
  JPEG); its "Migration Plan" and two "Open Questions" are shipped history.
- `docs/firmware-refactor-tasks.md`: structurally stale — nothing from D1001
  bring-up, RTC, NTP policy, WPA3, or the OTA trust store is listed.
- `components-lcd/esp_io_expander_pca9535/README.md`: verbatim upstream, tells
  you to pull the registry version that breaks on IDF 6.0.
- `ROADMAP.md`: the "Path to 100" scorecard is anchored to a 2026-07-12 snapshot
  (~160 commits stale) and links a private artifact URL; the D1001 item is
  shipped; stale host-test count; the whole RBAC/OIDC surface is untracked.
- `firmware/CHANGELOG.md` is baselined at the `firmware-v1.2.0` anchor, so
  firmware history before it lives ONLY in the root `CHANGELOG.md`. That is
  correct release-please behavior, not a bug.
