# CLAUDE.md

Guidance for Claude Code (and any fresh AI session) working in the **Vellum** repo.

Vellum = a **Next.js server** (admin UI + OTA firmware distribution for E-Ink
room-booking displays) + **ESP32 firmware** (`firmware/`). AGPL-3.0. Repo
`metaneutrons/Vellum`. (This nests under the workspace-level
`/Volumes/Dev/Source/CLAUDE.md`.)

## Repo layout / worktree

- Server code is `src/` (Next.js App Router). Firmware is `firmware/` (ESP-IDF).
  Docs in `docs/`, plus `README.md`, `ROADMAP.md`, `SECURITY.md`.
- Some checkouts are **linked git worktrees**; the canonical clone is
  `/Volumes/Dev/Source/Vellum` (branch `main`). `.git` in a worktree is a gitdir
  pointer — run `git worktree list` to see which is which. Don't assume the dir
  you're in is `main`.

## Server (Next.js): build / test

- Node **22** for dev/CI (`.nvmrc`, consumed via `node-version-file`). The
  production Docker image builds & runs on **node:26-alpine** (`Dockerfile`,
  pinned by digest). Two different Node versions — don't assume one everywhere.
- Install EXACTLY (CI + Dockerfile parity):
  `npm ci --ignore-scripts && npm rebuild @napi-rs/canvas`.
  Plain `npm ci` reopens the install-hook supply-chain surface; without the
  rebuild, the one native addon the room-booking renderer needs
  (`@napi-rs/canvas`) is unbuilt and canvas rendering fails at runtime.
- **npm is pinned to `npm@10.9.8`** (`package.json` `packageManager`; CI runs
  `corepack enable`). **Regenerate `package-lock.json` ONLY under npm 10** — run
  `corepack enable` once locally, or `npx npm@10.9.8 install`. A lockfile written
  by npm 11 fails CI's npm-10 `npm ci` with `Missing @esbuild/<platform> from
  lock file` (passes on the author's Mac, red on CI). pnpm migration is on the
  roadmap; until then, npm 10 is mandatory for lockfile edits.
- Scripts (`package.json`): `dev`, `build`, `start`, `lint` (`eslint .`),
  `test` (`vitest --run`), `test:coverage`, `db:migrate` (`drizzle-kit migrate`),
  `dev:mdns` / `mdns`. Type-check: `npx tsc --noEmit`.
- Tests: **~20 vitest suites, node environment, fully self-contained — NO
  Postgres / testcontainers / docker.** The workspace-wide snapdog note "tier-2
  tests need `DOCKER_HOST=colima socket`" does NOT apply to Vellum.
- Coverage is a **ratchet gate** (`vitest.config.ts`): statements 55 / branches
  44 / functions 44 / lines 56, enforced by the required CI "Test" job. Raise,
  never lower.
- Runtime env (`.env.example` is the source of truth): `DATABASE_URL` (Postgres),
  `ENCRYPTION_KEY`, `SESSION_SECRET` (**required, min 32 chars**, validated at
  boot in `src/lib/env.ts` / `src/lib/session.ts` — omitting it = boot failure;
  the README/Docker examples currently omit it), `ADMIN_API_KEY`, `ADMIN_USER`,
  `ADMIN_PASS`, `NODE_ENV`, `LOG_LEVEL`. Workspace convention: real secrets live
  in `~/.env_vars`, never in-repo.

## Firmware: build

- Toolchain: **ESP-IDF v6.0**. Local build: `make build MODEL=<model>` from
  `firmware/` (default `MODEL=e1002`). The Makefile sources a hardcoded IDF
  activate script (`/Users/fabian/.espressif/tools/activate_idf_v6.0.sh`) +
  `IDF_PATH=/Volumes/Dev/esp-idf/v6.0/esp-idf`. There is **no `make setup`**
  target (the README claims one; it's wrong). CI builds in docker
  `espressif/idf:v6.0`.
- **Always pass `-DVELLUM_MODEL=<model>`** (Makefile + CI do). It bakes the
  app-descriptor `project_name` `vellum-<model>` used by the OTA anti-brick
  cross-model check. A bare `idf.py build` falls back to generic
  `vellum-firmware` and **silently disables that check** — a wrong-model image
  would pass signature verify and could brick a device (`CMakeLists.txt:24-31`).
- **4 models** (`firmware/Makefile:37-55`, `firmware.yml` matrix):
  | Model | Chip | Panel / controller | Display |
  |-------|------|--------------------|---------|
  | `e1001` | ESP32-S3 | GDEY075T7 / UC8179_BW | mono 800×480 |
  | `e1002` | ESP32-S3 | GDEP073E01 / ACEP 6-color | 800×480 (default build) |
  | `e1003` | ESP32-S3 | ED103TC2 / IT8951 | **16-gray / 4bpp, 1404×1872** |
  | `d1001` | **ESP32-P4** | JD9365 MIPI-DSI **LCD** | 800×1280 (NOT in README hw table) |
  e1001/e1002/e1003 differ only by panel Kconfig; d1001 is the P4 LCD target.
- Display backend is a **3-way split**, not one esp_epaper: `panel_epaper.c`
  (S3 e-paper: custom `epaper_uc8179` for e1001/e1002, `epaper_it8951` for e1003)
  + `panel_lcd.c` (P4 d1001 LCD). `components-epaper/epaper_uc8179` is a
  **vendored fork** of `tuanpmt/esp_epaper` — do NOT re-pull it from the ESP-IDF
  registry (would clobber Vellum's added `uc8179_bw.c` / `ed103tc2.c`).
  esp_epaper is declared in `components/vellum_display/idf_component.yml` gated
  `target==esp32s3`, NOT in `firmware/main/idf_component.yml`.
- **Secure Boot builds are opt-in**: `make build SECURE=1 SECURE_PROFILE=<rung>`
  climbs a 3-rung ladder (`testsecure` → `secureboot` → `prod`); the eFuse-burning
  rungs must be selected explicitly. See `docs/SECURE_BOOT_AND_KMS.md`.
- Firmware **host tests** (pure logic/crypto, no ESP-IDF):
  `cmake -S firmware/host_test -B firmware/host_test/build && cmake --build
  firmware/host_test/build && ctest --test-dir firmware/host_test/build`.
  Needs CMake ≥3.16, C11, OpenSSL. Golden vectors regenerated by
  `node firmware/host_test/scripts/gen_kat.mjs`.
- `firmware-pr-build.yml` = compile-only smoke checks for e1001/native USB,
  e1003/CH340 UART, and d1001/P4 on every `firmware/**` PR — catches model-
  specific Kconfig and `-Werror` breaks before release.
- `firmware-host-test.yml` runs on EVERY push/PR to main with **no path filter
  on purpose** (required check; path-filtering would wedge unrelated PRs in
  "Expected — Waiting for status"). `host_test/README.md` wrongly says it's
  `firmware/**`-scoped — don't "fix" it by adding the filter.

## Release: TWO-component release-please (the big gotcha)

Driven by `release-please-config.json` + `.release-please-manifest.json`
(config-file mode, NOT inline release-type), workflow `release-please.yml`, needs
`secrets.RELEASE_PAT` (real actor) so the release PR fires CI and the published
release fires the build workflows (falls back to `GITHUB_TOKEN` with no
downstream triggers).

- **Server** = package `.` (release-type `node`, `exclude-paths:["firmware"]`,
  tag `vX.Y.Z`) → built by `docker.yml` (multi-arch amd64+arm64, SBOM + SLSA
  provenance, cosign keyless, moves `latest`).
- **Firmware** = package `firmware` (release-type `simple`,
  `include-component-in-tag`, `tag-separator "-"`, tag `firmware-vX.Y.Z`) → built
  by `firmware.yml` (4-model matrix, Ed25519-signs each OTA image, uploads
  `firmware-manifest.json` last).
- release-please routes each commit by path: `firmware/**` → firmware component;
  everything else → server. A server `fix:` does NOT rebuild firmware and vice
  versa.
- **MERGE-COMMIT the two `chore: release` PRs — do NOT squash.** Squash rewrites
  the release commit and release-please fails to create the GitHub Release object
  (hit on v1.2.1; tag/release had to be hand-created). Ordinary PRs stay
  squash-merged.
- **If a merged release PR is left UNTAGGED** (the post-merge run aborts with
  `⚠ There are untagged, merged release PRs outstanding - aborting` and
  `No latest release found ... but a previous version (X.Y.Z) was specified in
  the manifest` — i.e. the manifest bumped but no tag/Release exists): this can
  happen **even with a correct merge-commit** (hit on v1.3.0) and is
  **deterministic** — `gh run rerun` reproduces the abort, it does NOT self-heal.
  The `commit could not be parsed: ... Merge pull request #N` log lines are
  benign, not the cause. Recover by hand-creating it:
  `gh release create vX.Y.Z --target <release/merge SHA> --latest --notes-file
  <CHANGELOG X.Y.Z section>` (create it as a **real user via PAT** so it fires
  `docker.yml`'s `release: published` build — `GITHUB_TOKEN` would not), then
  `gh pr edit <#> --remove-label "autorelease: pending" --add-label
  "autorelease: tagged"` so release-please's state stays consistent.
- Firmware version **SSOT**: the `firmware` key in
  `.release-please-manifest.json` → `firmware/main/Kconfig.projbuild`
  `default "X.Y.Z" # x-release-please-version`. **Current = 1.2.1.**
  `firmware/version.txt` is **gitignored + build-generated** for `PROJECT_VER`
  and is NOT authoritative (working copies may show junk like `1.3.0-localtest`).
- Tag state: `firmware-v1.2.0` is a release-please **anchor tag with NO GitHub
  Release** (fleet never sees it). `firmware-v1.2.1` is the **first & current
  real firmware release**. The next firmware version is **whatever release-please
  computes** from `firmware/**` commits since firmware-v1.2.1 (do not assume
  v1.3.0 — a stale doc/comment claims that).
- `firmware.yml` `if:`-gotchas — don't "fix" them into misfiring: the `version`
  job skips server (`v*`) releases; `build`/`sign-and-release` then skip via
  default `success()` gating (adding `always()`/`!cancelled()` would run firmware
  on server releases). The redundant-beta skip matches both squash subjects
  `chore(main|firmware): release ` AND the merge-commit marker
  `release-please--branches`.
- See `docs/RELEASING.md` for the full model.

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

- **USB-serial provisioning (Improv Wi-Fi Serial over the model's USB-exposed
  serial transport) is the PRIMARY onboarding path** (shipped
  firmware-v1.2.1), replacing SoftAP as the
  intended flow. Operator flashes + provisions from the WebUI over a cable:
  Admin → Firmware → **Flash** (`flash-tool.tsx`, ESP Web Tools) then
  **Provision** (`provision-tool.tsx`, Web Serial API). Protocol client:
  `src/lib/provisioning/improv-serial.ts`. Firmware side:
  `firmware/components/vellum_serial/` (native USB-Serial-JTAG on E1001/E1002
  and D1001, CH340K/UART0 on E1003; Improv binary frames interleaved with a text
  console; console cmds wifi/server/token/info/nvs-erase/reboot).
- **SoftAP is NOT removed** — it remains the first-boot **fallback** (open AP +
  captive DNS) whenever NVS has no Wi-Fi credentials
  (`firmware/main/main.c:399-411`, `wifi_manager.c`). WebUI copy that says "no
  SoftAP setup" refers to the USB flow, not to SoftAP being deleted.
  `vellum_serial_init()` runs on every boot, so Improv is always available over
  USB.
- **Optional zero-touch voucher** (`provisioning_vouchers` table,
  `src/db/schema.ts:109-119`): mint via `createProvisioningVoucher(label,
  ttlHours)` in `src/app/admin/actions.ts` (default TTL 7 days). The voucher
  token **IS the device bearer token**, sent as the 4th cleartext string in the
  Improv WIFI_SETTINGS frame. Claim is single-use and atomic (bound to first
  presenting MAC via `UPDATE ... WHERE claimed_by_mac IS NULL`; enrol+claim in
  one transaction — `src/lib/auth/index.ts:78-104`). Expiry is opt-in:
  `expiresAt` NULL = never expires. Device then enrols via the normal
  `POST/GET /api/v1/ink/hello` path; post-approval the handshake public key is
  frozen (MAC-spoof protection). There is no dedicated `/api` provisioning route
  — provisioning is client-side serial + the voucher server action.
- Known trade-offs (tracked in `ROADMAP.md`, not yet closed): voucher not
  MAC-bound at mint time (first unclaimed-voucher presenter wins); Wi-Fi creds +
  token cross the USB cable in cleartext (relies on physical-trust of the
  provisioning window); no voucher revoke/delete UI.

## Signing — two INDEPENDENT trust chains (don't conflate)

- **OTA app signature** = Ed25519 (PureEdDSA), verified in software by
  `ota_manager.c`. Public key: repo-root `vellum-firmware-signing.pub` == Kconfig
  `CONFIG_VELLUM_OTA_SIGNING_PUBKEY` default. One key signs all 4 models.
- **Secure Boot v2** = RSA-3072-PSS, verified by ROM/bootloader. Gated behind
  `OTA_SECURE_BOOT` in `firmware.yml` + `partitions.secure.csv`. Phase 3 (Secure
  Boot on hardware + KMS/HSM) is still OPEN per ROADMAP.
- Private keys live in **cloud KMS via GitHub OIDC (keyless)**;
  `OTA_KMS_KEY_VERSION` preferred, `FIRMWARE_SIGNING_KEY` secret is the legacy
  fallback. `firmware/keys/` + `vellum-firmware-signing.pub` hold PUBLIC material
  only; `*.pem` / `*.der` / `hsm_config.ini` are gitignored. See
  `docs/SECURE_BOOT_AND_KMS.md` (accurate).

## Doc trust notes (as of the 2026-07-14 audit)

- **Accurate**: `docs/RELEASING.md` (except a stale "next firmware = v1.3.0"
  onboarding paragraph), `docs/SECURE_BOOT_AND_KMS.md`, both CHANGELOGs,
  `firmware/keys` + `firmware/host_test` READMEs.
- **Stale / incomplete — verify against source before trusting**: `README.md`
  (SoftAP-only onboarding, bogus `make setup`, missing `SESSION_SECRET`, wrong
  test count), `SECURITY.md` (no voucher/USB coverage; §1 "token E2E-encrypted"
  claim vs the cleartext voucher path), `docs/firmware-display-architecture.md` +
  `docs/firmware-refactor-tasks.md` (E1003 shown as TBD/mono, D1001 omitted,
  deps/version-sync/provisioning-UI marked open though shipped),
  `ADDING_PANELS.md` + `epaper_uc8179/README.md` (missing UC8179_BW/ED103TC2
  controllers). No README exists for `firmware/components/vellum_serial`.
- `firmware/CHANGELOG.md` is baselined at the `firmware-v1.2.0` anchor, so all
  firmware history before it (Improv/vellum_serial, panel drivers, OTA) lives
  ONLY in the root `CHANGELOG.md`. The near-empty firmware changelog is correct
  release-please behavior, not a bug.
