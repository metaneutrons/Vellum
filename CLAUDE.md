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
- **The branch can change UNDER a long session, so re-check it before every commit,
  not only at the start.** This actually happened: a session working `feat/name-plate`
  had the shared checkout switched to a new `test/mpll-state-dump` mid-flight, and its
  next commit landed on that branch on top of unrelated firmware work. It went
  unnoticed because `git push origin feat/name-plate` pushes the NAMED BRANCH rather
  than HEAD, so the push reported "Everything up-to-date" and, by luck, did not carry
  the firmware commit onto the PR. Recovery without disturbing whoever owns the shared
  checkout: `git worktree add <tmp> <target-branch>`, cherry-pick the commit there,
  push, remove the worktree. A temporary worktree has no `node_modules`, so the
  `core.hooksPath` hooks cannot run; `git -c core.hooksPath=/dev/null` is the way past
  them, and is only honest when the gates were already run on identical content in the
  real checkout.
- **Never symlink `node_modules` into a worktree and then `git add -A`.** Until
  2026-08-24 `.gitignore` said `node_modules/`, and a trailing slash matches
  DIRECTORIES only, so the symlink was a file that git happily tracked. Every CI job
  then died in `pnpm install` with `ENOTDIR: not a directory, mkdir .../node_modules`,
  and the branch stayed red for three commits while every local gate passed. The
  pattern is now `node_modules` without the slash, which covers both. The wider lesson:
  **local gates green is not CI green** — check `gh pr view <n> --json statusCheckRollup`
  after pushing, because a whole class of failure lives in the checkout rather than the
  code.

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
- Scripts (`package.json`): `dev`, `build`, `start`, `lint` (zero-warning
  ESLint plus brand consistency), `format`, `format:check`, `typecheck`
  (`tsc --noEmit` — the canonical type-check), `test`
  (`vitest --run`), `test:coverage`, `i18n:check`, `release:check`,
  `db:check`, `db:generate`, `db:migrate` (the idempotent `scripts/migrate.mjs`
  runner), `dev:mdns` / `mdns`.
- **`.githooks/pre-commit` runs lint-staged with Prettier and zero-warning
  ESLint**; generated/vendor inputs are explicitly excluded. **`.githooks/pre-push`
  runs `i18n:check`, `typecheck`, `release:check` (and
  `db:check`)** — each is also a required CI job. Run them before pushing or the
  hook will surprise you.
- Tests: ~two dozen vitest suites (`pnpm test` for the exact count), node
  environment, fully self-contained — **NO Postgres / testcontainers / docker**.
  The workspace-wide snapdog note "tier-2 tests need `DOCKER_HOST=colima
socket`" does NOT apply to Vellum.
- **`environment: "node"` is the project default and stays that way.** One suite,
  `use-device-live-updates.hook.test.ts`, needs a DOM and opts in per file with a
  `// @vitest-environment jsdom` docblock (`jsdom` + `@testing-library/react` are
  devDependencies). Prefer that docblock over switching the global environment.
  Note `include` covers `*.test.ts` only, not `.tsx`, so a component test either
  avoids JSX (`renderHook` does) or the pattern has to change. When rendering a
  hook that opens an `EventSource` or calls `fetch`, stub both: jsdom provides
  neither usefully.
- Coverage is a **ratchet gate** (`vitest.config.ts`): statements 69 / branches
  63 / functions 67 / lines 70, enforced by the required CI "Test" job. Raise,
  never lower. Only modules the suite imports are measured, so `scripts/` is out
  of scope and adding an untested script cannot move the number.
- **Codacy's complexity gate is Lizard, its limit is 50 NON-COMMENT lines per
  function, and it fails the check on ANY issue ("≤ 0 issues of at least minor
  severity"). Reproduce it locally before pushing rather than guessing:
  `pip install lizard` in a venv, then
  `lizard -l typescript <files>` — the NLOC column is what Codacy quotes, and its
  own `length` column (which counts comments) is not.** Two traps cost a full
  round trip each. Lizard **loses any function whose return type is a COMPOSED type
  containing an object literal** (`X & { ... }`, `X | { ... }`; a bare `{ ... }` is
  fine) and attributes its body to the neighbouring function, which is how a
  10-line `choosePlan` was reported as 67 lines. Name such return types. It also
  applies an NLOC ceiling per FILE; 739 tripped it, so a renderer that grows past a
  few hundred lines wants splitting by concern (`name-plate.ts` became
  `-scale`/`-draw`/`-sizes` plus the renderer). Note ESLint's own `complexity` and
  `max-lines-per-function` rules are NOT enabled here, so `pnpm lint` says nothing
  about either.
- **Coverage is not reproducible to the last statement, so keep ~1pp of margin
  and calibrate against CI, never a local run.** CI runs Node 22 (`.nvmrc`) and v8
  counts statements differently per version (70.24 local vs 70.12 CI), and CI
  varies between runs over identical source (70.12 then 69.96, about four
  statements). A threshold set flush against one measurement failed a release PR
  that changed no code. Something in the suite is timing- or environment-dependent
  and has not been tracked down; real coverage sits near 70 for statements, so
  lifting the floor to 70 needs tests with room to spare, not a tighter number.
- Runtime env (`.env.example` + `deploy/vellum.env.example` are the source of
  truth): `DATABASE_URL`, `ENCRYPTION_KEY`, `SESSION_SECRET`, `ADMIN_API_KEY`
  (all **min 32 chars**), `ADMIN_USER`, `ADMIN_PASS` (min 8), `NODE_ENV`,
  `LOG_LEVEL`; optional `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` /
  `ENTRA_CLIENT_SECRET`, `UPDATER_URL` / `UPDATER_TOKEN` (update sidecar), `TRUST_PROXY_HEADERS` (**set `false` on a
  directly-exposed instance** or `X-Forwarded-For` can be spoofed to bypass rate
  limits — `src/lib/rate-limit.ts`; it is missing from both env templates).
  Validated at boot in `src/lib/env.ts` / `src/lib/session.ts`; a failure
  `process.exit(1)`s.
- **`VELLUM_PUBLIC_URL` is optional but load-bearing in three places**, and it is
  NOT only about Entra OIDC: it is the canonical origin the admin mutation
  endpoints compare `Origin` against (`src/lib/request-origin.ts`), and it decides
  whether OTA downloads are proxied by Vellum or fall back to raw GitHub. An unset
  value used to make every admin mutation answer a bare `403` behind a
  TLS-terminating proxy, because the fallback compared the browser's `https`
  origin against the internal `http` request URL — observed live on
  `anny-display.it.hs-hannover.de`. The fallback now compares HOST only (from
  `X-Forwarded-Host`/`Host`), the refusal is logged with expected vs received,
  and boot warns when it is unset in production. Setting it remains the strong
  configuration, since only then is the scheme checked too.
- Workspace convention: real secrets live in `~/.env_vars`, never in-repo.

## Schema ↔ migration parity (invariant)

`scripts/migrate.mjs` applies the raw `drizzle/*.sql` files in order and records
them in `__vellum_migrations`. Consequences:

- **A column added to `src/db/schema.ts` needs a hand-written migration.**
  Nothing else catches a missing one: the migrator never reads the model, `tsc`
  only type-checks the model, and the test suite runs without Postgres. This
  actually shipped broken — `devices.orientation_override` had no migration for
  ~3 months, taking out `/api/v1/ink/render` on fresh databases.
- **`pnpm db:generate` is usable again, and is now the normal route.** It was not
  until 2026-08-17: `drizzle/meta/` stopped at `0005` while migrations ran to
  `0022`, and `0000_snapshot.json` already claimed `devices.orientation_override`,
  which only `0008` creates — so drizzle believed columns existed and would never
  emit them. `_journal.json` now carries all 23 entries with monotonic `when`
  values, and `0022_snapshot.json` describes the real schema, verified by building
  a database from the model and diffing it against a `0022`-migrated one.
  Generated files start at `0023`, so they cannot collide with the hand-written
  history. Keep migrations idempotent (`ADD COLUMN IF NOT EXISTS`) and
  forward-only (there are no down migrations).
- **For anything drizzle cannot express, use
  `pnpm exec drizzle-kit generate --custom --name <desc>`** and write the SQL by
  hand. That still records a journal entry and snapshot, which plain hand-authoring
  does not, and is how the journal fell behind in the first place. The snapshot
  format has no representation for triggers or plpgsql functions (the schema has 4
  and 3), nor for DML or drop/recreate transitions.
- **`drizzle-kit migrate` is NOT the applier and must not be used.** It decides
  what is pending from a single `created_at` high-water mark compared strictly
  against `journal.when`, never reading the `hash` it stores — so it enforces no
  checksum, takes no advisory lock, and permanently skips any migration merged
  later with an earlier `when`. `scripts/migrate.mjs` does all three correctly and
  additionally self-baselines onto databases created by `drizzle-kit push`.
- `pnpm db:check` runs three guards: `check-schema-migrations.mjs` (CI "Schema
  Guard") asserts every `schema.ts` column is created by some `drizzle/*.sql` and
  **fails on any column builder it does not recognise** rather than skipping it
  (`assets.data`, declared via a `customType`, was silently unchecked until
  2026-08-17); `check-schema-snapshot.mjs` asserts the model is fully captured by
  `drizzle/meta/`, printing the migration drizzle-kit would emit; and
  `check-db-access.mjs` enforces the read/write/transaction wrappers.
- **Foreign-key and primary-key names are pinned explicitly** where `0006`,
  `0007`, `0013` and `0018` wrote them by hand. Inline `.references()` cannot pin
  a name and implies drizzle's longer one, which no database has, so a generated
  migration could `DROP CONSTRAINT` a name that was never created. Renaming
  databases to drizzle's convention is not an option: one such name exceeds
  PostgreSQL's 63-character limit and is silently truncated. Three indexes differ
  cosmetically (`DESC` vs `DESC NULLS LAST`) on `NOT NULL` columns, where the
  ordering is unobservable; that is deliberate, not drift to fix.
- **`pnpm dev` refuses to start against a database behind `drizzle/`**
  (`scripts/check-pending-migrations.mjs`) and prints the pending list. Only the
  container migrates itself at boot, so a local database otherwise stays at
  whatever revision the last `pnpm db:migrate` reached, and the resulting missing
  relation surfaces far from its cause. An unset `DATABASE_URL` or an unreachable
  database exits 0 (database-less dev keeps working);
  `VELLUM_SKIP_MIGRATION_CHECK=1` overrides it.
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
  | Model                                                                        | Chip                                                             | Panel / controller                   | Display                          | USB serial transport       |
  | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------ | -------------------------------- | -------------------------- |
  | `e1001`                                                                      | ESP32-S3                                                         | GDEY075T7 / UC8179_BW                | mono 800×480 (panel does 4-gray) | **CH340C → UART0**         |
  | `e1002`                                                                      | ESP32-S3                                                         | GDEP073E01 / ACeP (see palette note) | 800×480 (default build)          | **CH340C → UART0**         |
  | `e1003`                                                                      | ESP32-S3                                                         | ED103TC2 / IT8951                    | **16-gray / 4bpp, 1872×1404**    | **CH340K → UART0**         |
  | `d1001`                                                                      | **ESP32-P4** + ESP32-C6 (Wi-Fi via `esp_wifi_remote`/ESP-Hosted) | JD9365 MIPI-DSI **LCD**              | 800×1280                         | **native USB-Serial-JTAG** |
  | **Every S3 model needs its console overlay** (`sdkconfig.defaults.e1001` /   |
  | `.e1002` / `.e1003` on top of `sdkconfig.defaults.s3`) — they differ by more |
  | than panel Kconfig. A model without one silently inherits the base           |
  | `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`, which is wrong for all three.        |
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
  All three therefore read USB power from the **SY6974B charger (0x6B) over
  I²C** (`components/board/board.c` `charger_reports_usb_power()`, host-tested in
  `test_sy6974b_power.c`). **The charger bus differs per model**: E1001 and E1002
  on **SDA39/SCL40**, E1003 on **SDA19/SCL20**. For E1001 this is corroborated by
  Seeed's own Zephyr board port, whose devicetree puts `charger: sy6974b@6b` on
  `i2c1` (SDA39/SCL40) while `i2c0` (SDA19/SCL20) carries only the SHT4x and the
  PCF8563 RTC — and whose battery-divider enable (GPIO21, ADC0 ch0) matches this
  repo's `VELLUM_BATTERY_EN_GPIO` default of 21. Only D1001 uses a VBUS sense
  channel (`d1001_usb_voltage()`), and only D1001 may use the USJ signal.
  A "fix" that routes either console or USB-power detection uniformly across
  models WILL break several.
- Unused E1001/E1003 hardware, for reference: both carry a **PCF8563 RTC** and an
  **SHT4x** temperature/humidity sensor on `i2c0`; Vellum currently implements RTC
  support only for D1001 and reads neither sensor on the E-Series.
- **Audible feedback is not uniform either.** The E-Series have a PWM buzzer on
  `CONFIG_VELLUM_BUZZER_GPIO`; D1001 has **no buzzer** but an **ES8311 codec at
  0x18 on I2C bus 1** driving a 2 W mono speaker, so `board_buzzer_beep()` plays a
  recorded chime there (`components/vellum_audio`, P4-only, `esp_codec_dev`).
  Do NOT route D1001 through the LEDC path: `LEDC_TIMER_0`/`LEDC_CHANNEL_0` are the
  **LCD backlight**, so a "beep" left the display dark at 0% duty — which is why
  the model was deliberately silent before. I2S is MCLK33/BCLK32/WS31/DOUT30, and
  the power amplifier is gated by `D1001_EXP_AMP_EN` (PCA9535 pin 11 = Seeed's
  P13), driven only while a chime plays. **Seeed documents the microphone input on
  GPIO11, which is this firmware's `D1001_WIFI_SDIO_CLK`** — adding capture means
  resolving that conflict, not just filling in the pin. Frequency/duration
  arguments are meaningless on D1001: every event plays the same sample, where the
  E-Series distinguish events by pitch.
- **Sound has a policy, and it is short: a failure, or acknowledging a button
  someone just pressed. Nothing else.** No sound on waking, on an update starting,
  or on an update succeeding: a rollout across a building would otherwise chime
  its way through the night, and a display in a meeting room is not a device that
  announces itself. If some new event seems to deserve a sound, ask the owner
  rather than deciding in passing — the two admitted cases are deliberate, and
  widening them is a product call. The three call sites that violated this were removed in
  `fix/beep-policy-and-rtc-pullup`; the remaining ones are the OTA failure notice,
  the factory-reset acknowledgement, and the refresh button. A genuine button wake
  is silent too: EXT1 is level-triggered, so a wake cause cannot distinguish a
  finger from a floating pin, and the acknowledgement belongs to the paths that
  observe a press while the device runs.
- **EXT1 wake pins need their pull armed in the RTC domain, and this was missing
  for a long time.** The buttons (GPIO3 refresh / GPIO4 / GPIO5, active low) carry
  **no external pull-up on any E-Series board** — Seeed's board ports declare all
  three `GPIO_PULL_UP`, i.e. the SoC's internal one. `buttons_init()` sets that
  pull in the DIGITAL domain only, which stops applying the moment a pin is handed
  to the RTC domain for EXT1, and because `sleep_manager` keeps RTC_PERIPH powered
  the automatic HOLD path does not act either. ESP-IDF requires
  `rtc_gpio_init()` + `rtc_gpio_pullup_en()` + `rtc_gpio_pulldown_dis()` in
  exactly that configuration (see its `deep_sleep` example). Without them the wake
  pin floats through deep sleep while `ANY_LOW` is armed, which is a wake condition
  already satisfied: the display woke early, reported a button nobody touched,
  beeped about it, and served a fraction of its assigned interval. `arm_button_wake()`
  now does this for every pin in the mask, and `sleep_manager_init()` logs
  `esp_sleep_get_ext1_wakeup_status()` so "a button woke us" is checkable rather
  than asserted. The beep was the mildest symptom: `main.c`'s boot path takes
  `WAKE_REASON_BUTTON` plus a low KEY0 as a factory-reset gesture, so a floating
  pin could reboot an unenrolled display or erase its NVS. Only
  `factory_reset_permitted()` stood between that and an enrolled one.
- **Two wake sources are armed on every sleep, so the wake reason needs a
  precedence rule, and A BUTTON OUTRANKS THE TIMER.** Somebody standing at the
  display pressed it; that the interval expired in the same second is a
  coincidence, and swallowing the press would make the button feel broken at
  random. This became explicit when `sleep_manager_init()` moved to
  `esp_sleep_get_wakeup_causes()` — the singular `esp_sleep_get_wakeup_cause()`
  is deprecated in IDF 6.0 precisely because it "will only return one wakeup
  source", which for this firmware is not a corner case but the normal
  configuration. The choice is load-bearing: `WAKE_REASON_BUTTON` is what sends
  `main()` into the factory-reset hold check and into `buttons_poll()`.
- **`CONFIG_GPIO_ESP32_SUPPORT_SWITCH_SLP_PULL=n` used to sit in the defaults
  with the comment "breaks IT8951 BUSY pin", and it is gone — the symbol does not
  exist in IDF 6.0, so that protection had been inert for a while.** It is not in
  conflict with the RTC pull-up above: the old knob governed switching pulls on
  ALL pins at sleep entry (BUSY is GPIO13), while `arm_button_wake()` touches only
  the pins in the wake mask. It also mattered mainly to light sleep, which this
  firmware has no path into today. Three other vanished symbols were removed with it
  (`ESP_WIFI_REMOTE_ENABLED`, `LV_MEM_CUSTOM`, `LV_MEMCPY_MEMSET_STD`); all four
  had been producing "unknown kconfig symbol" warnings on every build of every
  model. **The firmware build is warning-free as of that cleanup, and worth
  keeping so, because a build that prints warnings on every run teaches people to
  scroll past them.** Where a warning is genuinely unavoidable, suppress it at the
  line with a comment saying why, rather than leaving it to accumulate.
- **The status LED is per-model: E1001/E1002 on GPIO6, E1003 on GPIO16.** The
  shared `VELLUM_LED_GPIO` default of 6 lit nothing on an E1003 and drove a pin
  that appears nowhere in that board's device tree. Same class as the
  `VELLUM_BATTERY_EN_GPIO` exception (21 vs 40) directly above it. Seeed's Zephyr
  board ports (`boards/seeed/reterminal_e100{1,2,3}`) are the authority for all of
  this, and they are worth reading before assuming any E-Series pin is uniform.
  **The D1001 has an RGB indicator** (R GPIO22, G GPIO36, B GPIO23,
  `d1001_board.h`), and only red was ever driven, which announced ordinary work in
  the colour a person reads as a fault.
  - **All three legs are active-low, and this is established rather than
    assumed.** Seeed publishes a BSP for this board
    (`Seeed-Studio/reTerminal-D1001`, `components/esp32_p4_re_terminal_d1001`)
    whose commented-out GPIO writes use `cmd ? false : true` identically for R, G
    and B, and whose shipped PWM path computes
    `duty = 1024 * (100 - percent) / 100` — full brightness is duty zero. Both
    mean the pin sinks the current. That BSP is the reference for this board the
    way the Zephyr ports are for the E-Series; there is no Zephyr port for the
    D1001.
  - **The three colours are NOT interchangeable and are dimmed per colour.** The
    schematic gives red and green 1 kΩ (R135, R132) and blue 499 Ω (R133), and the
    vendor accordingly drives green at 8 %, red at 20 %, blue at 50 %. Switching
    all three fully on, which is what a plain GPIO does, puts green about an order
    of magnitude past that. `board_led_channel_t` therefore carries an optional
    LEDC channel plus duty, and the D1001 table uses the vendor's numbers on LEDC
    channels 2-4. **Timer 1**, because timer 0 is the LCD backlight here and the
    buzzer on the E-Series.
- **Indicators are addressed by state rather than by pin or colour**
  (`board_led.h`, `led_indicator.c`). Reaching for a pin directly is for bring-up
  and hardware diagnostics; anything that ships names a state. A board supplies two tables — the channels it physically
  carries, and one row per `board_led_state_t` mapping that state to a channel
  plus a pattern — and a new board needs to add nothing else. `board_led_on()` /
  `board_led_off()` are gone with the scheme that lit the LED for every awake
  moment, which conveyed nothing.
  - **Dark is the normal state**, same reasoning as the audio policy: a wall
    display should not blink at the room, so light means somebody is working on
    the device or something wants attention. Widening that is a product call
    worth raising rather than settling in passing.
  - **A state may map to no channel, and that is an answer.** The E-Series map
    `FAULT` to nothing: the board sleeps through nearly all its life, no core runs
    to blink, and a held light would spend the standby budget the product is built
    around. It also does not need one — a failed render leaves a status screen and
    e-paper keeps showing it, so the panel is that board's persistent indicator.
    The D1001 is mains-oriented and stays awake between polls, so it can afford
    to hold red instead.
  - Pattern arithmetic lives in `led_pattern.h` as pure inlines (the
    `lcd_rotation.h` shape) and is covered by `host_test/test_led_pattern.c`. Two
    properties there are load-bearing: every lighting pattern is lit at phase 0,
    so a state change shows at once instead of up to a period later; and only
    time-varying patterns request the tick, since an idle timer costs current for
    nothing. `esp_timer` had to be added to the board component's `REQUIRES` —
    it is not one of the implicit common requirements.
- Panel-capability inconsistencies — **unresolved, do not "fix" one side blindly;
  confirm against the physical panel first**:
  - E1003: code and server use **1872×1404** (landscape) while
    `main/Kconfig.projbuild:19` labels it `1404x1872`. Not a typo — the vendor
    spec is portrait 1404×1872 and Vellum drives the panel landscape, so the two
    are the same panel under different orientation conventions. Leave both alone.
  - **E1002's 6-colour palette is RESOLVED — do not "re-fix" it.** A palette
    position _is_ the on-wire pixel code, and GDEP073E01's code space has a hole:
    `0x0` black, `0x1` white, `0x2` yellow, `0x3` red, **`0x4` unused**, `0x5`
    blue, `0x6` green. The gap is why deleting the orange entry is wrong — it
    slides blue onto `0x4` and green onto `0x5`. The open question in earlier
    editions ("does 0x4 become blue, or stay unused?") was answered from the
    driver itself: `epaper_lvgl.c`'s own palette has always had six entries and
    skipped `0x4`. Position 4 therefore stays, holds a duplicate of white, and is
    reported in the new optional caps field **`reservedPaletteIndices: [4]`**
    (`displayCapsSchema`), which the renderer excludes from both nearest-colour
    passes and from `colorCount`. Firmware predating the field reports nothing
    reserved and behaves as before. `src/lib/display.ts`'s registry entry now
    matches the firmware's order — it previously listed the same colours in ACeP
    _Gallery_ order (green/blue at `0x2`/`0x3`), a different panel family, so every
    simulator preview disagreed with the hardware.
  - **E1001's panel does 4-level grayscale (hardware-confirmed) but the firmware
    drives it 1-bit mono** (`PANEL_BPP 1`, `PANEL_COLORS "mono"`, `UC8179_BW`;
    server palette is 2 entries). The library already has `EPD_COLOR_4GRAY`, so
    this is unexploited capability, not a hardware limit — switching would change
    the payload from 48 KB to 96 KB per refresh.
- Server-side `src/lib/display.ts` is a **static registry** used by the flash UI,
  simulator and preview. Runtime rendering resolves device-reported caps via
  `resolveDisplayCaps()`, and since 1.15.0 the firmware reports a real capability
  list over `X-Display-Caps` (geometry, current mounting, mountings it can
  deliver). The e-paper panels report **`["landscape"]` only**: no e-paper driver
  rotates — UC8179 declares a `rotation` field no `.c` file reads, and IT8951
  hardwires `rotate=0` into its `LD_IMG_AREA` argument. The registry's
  `["portrait","landscape"]` for e1003 is intent, not capability.
- **Orientation describes how the device is mounted**, not a server-side render
  preference — that distinction is the whole bug class. `devices.orientation_override`
  is the operator's choice and what the renderer uses until the device re-reports its
  surface. Resolution is two stages and **no longer guesses**: operator choice, then
  the mounting the device reports, then `landscape` as the default. The removed third
  stage derived a mounting from the geometry, and since the D1001's panel is natively
  800x1280 that guess read as portrait although no device had said so. The UI has no
  "auto" entry either, because it hid which mounting was actually in effect. Picking
  one in the devices list queues a signed `orientation` command
  (a third `device_configuration_commands.kind` beside `server_url` and `wifi`),
  and the device applies it by committing NVS and restarting, because
  `esp_lv_adapter` fixes its rotation at init and sizes its framebuffers from it.
  Both ends refuse a mounting the panel does not list, so the e-paper models
  currently accept `landscape` only. Before this existed the server silently swapped
  the rendered geometry while the panel's surface stayed as built, which cost a
  portrait D1001 480px off the bottom of every frame.
- Display backend is a **3-way split**, not one esp_epaper: `panel_epaper.c`
  (S3 e-paper: custom `epaper_uc8179` for e1001/e1002, `epaper_it8951` for e1003)
  - `panel_lcd.c` (P4 d1001 LCD). `components-epaper/epaper_uc8179` is a
    **vendored fork** of `tuanpmt/esp_epaper` — do NOT re-pull it from the ESP-IDF
    registry (would clobber Vellum's added `uc8179_bw.c` / `ed103tc2.c`). Note the
    registry copy is still _declared and linked_ alongside the fork
    (`components/vellum_display/CMakeLists.txt`) — a real cleanup, not just a doc
    nit. `components-lcd/esp_io_expander_pca9535` is likewise **vendored because
    the registry version fails on IDF 6.0**; its README (verbatim upstream) tells
    you to `idf.py add-dependency` it — don't.
- **Brightness is per-model and remembered.** `d1001_backlight_set(percent)` drives
  LEDC channel 0 (10-bit, 5 kHz) and existed unused for a long time;
  `d1001_backlight_on()` sets a hardcoded **80 %**, so `panel_lcd` keeps the
  server's value as a target and restores that on wake and after every render.
  Without the remembered target, every wake would undo the configured value. Only
  the D1001 reports `has_backlight`; no e-paper panel has one.
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

## Settings model: sites, profiles, overrides

Three primitives and one resolver, introduced over four staged PRs (#295, #296,
#298, and the UI/naming follow-up). The point of the shape is that adding a
setting does not add a mechanism.

- **Site** (`sites`) = a physical location: an IANA timezone plus defaults
  (profile, theme, content) for the displays in it. A device belongs to **at most
  one** and may belong to **none** — that is what let each stage ship on its own,
  since a siteless display resolves exactly as it did before sites existed.
  `user_role_assignments.scope_type` was already reserved for a `site` scope, so
  the RBAC seam fits this rather than a parallel concept.
- **Profile** (`refresh_profiles`) = a named policy bundle with **sections**, not
  one profile type per subject. `config` holds cadence today and `brightness`
  alongside it. **The UI calls it a "display profile"; the table is still
  `refresh_profiles`.** That drift is deliberate: a rename migration in this
  repo's history costs more than it returns.
- **Override** = an explicit per-device column (`orientation_override`,
  `timezone`, `backlight_percent`, `log_verbose`). Kept as columns, not a JSONB
  bag, because `check-schema-migrations.mjs` verifies column coverage and a blob
  is invisible to it. At three overrides the column count is not a burden; the
  calculation changes at ten.

**Two operations, deliberately separate** (`src/lib/settings/`): `cascade()`
resolves configuration over ordered layers (`builtin → site → profile → device`)
with per-key provenance; the evaluators (`computeSleep`, `evaluateBrightness`)
then judge the resolved policy against runtime state (power source, battery, time
of day, whether content is assigned). `computeSleep` used to do both, and adding
brightness would have duplicated the mixing.

Rules that hold across the model:

- **A `null` in a layer means silence, not "explicitly none".** `devices.theme_id`
  is null for nearly every display; reading that as a choice would make the device
  layer override every site with emptiness. There is no way to say "none, and
  ignore the site" — assign an empty object instead, which an operator can see.
- **Arrays replace wholesale.** "Does a site's schedule extend the profile's or
  replace it?" has no predictable answer; replacement fits in one sentence.
- **Tiers for power, rules for time.** Power has a fixed small vocabulary (USB,
  battery, low battery), so it stays a table of base values. Time is open-ended,
  so it uses rules — `days` / `startHour` / `endHour`, wrapping past midnight,
  first match wins. Cadence and brightness each have their own rule list of the
  same shape; sharing one list would force duplicate rules for the ordinary case.
- **Schedules are evaluated on the server, in the display's zone,** and the device
  receives a resolved number. No clock or timezone logic in firmware, and a
  schedule change takes effect on the next poll. `SleepContext.timezone` was
  declared and unread until #295 — rules were judged by the container's clock and
  were correct only because it runs `TZ=Europe/Berlin`.
- **Zone precedence**: `devices.timezone` → its site's → the server clock. The
  room-booking renderer's own `timezone` (default `UTC`) still wins when set, and
  otherwise now falls back to the display's, so the clock on screen cannot
  disagree with the schedule that decided when to draw it.
- **Capabilities gate controls.** `X-Display-Caps` has a fourth, optional field
  for flags; `backlight` is the first. Firmware predating it sends three fields,
  so a control is **withheld** rather than offered and silently ignored. Note the
  flag is only written into the stored row when it says something or the row
  already carries it — writing it unconditionally made every older device look
  changed on every poll, one needless write per cycle per display.
- **`zod`'s `.partial()` cannot produce a cascade layer.** Every field carries a
  `.default()`, and an absent optional key still resolves to it:
  `.partial().parse({ usbIntervalS: 30 })` returns ten keys, which would then
  outrank the layer below. `parseRefreshProfilePatch` picks only the keys present.

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
  everything else → server. **A commit is attributed to EVERY component whose
  paths it touches**, and it drops out of one only when ALL of its files there are
  excluded (`commit-exclude.ts`, `.every(...)`). A `feat(firmware)` that also
  edited a repo-root doc therefore asked for a server release carrying no server
  change; two such PRs were closed unmerged (#304, #306) before the exclusion list
  below existed.
- **The server component excludes `docs`, `.github`, `.githooks` and `.claude`
  besides `firmware`**, asserted by `pnpm release:check`, because none of them can
  change what the image or the deployment assets contain. `deploy/` is
  deliberately NOT excluded: its compose file and env example ship as release
  assets. **`exclude-paths` matches DIRECTORY prefixes only** — the check is
  `file.indexOf(path + "/") === 0`, so a root-level file such as `CLAUDE.md`,
  `README.md` or `ROADMAP.md` cannot be excluded at all. Keep edits to those in
  their own `docs:` commit when the rest of the branch is firmware; a `docs:`
  commit bumps nothing, so attribution to the server then costs nothing. A server `fix:` does NOT rebuild firmware and vice
  versa. The two components are independent in what they _release_, but **not
  independent when two release PRs are open at once** — see the manifest note
  below. That line used to claim "no merge order is required"; two incidents
  (#265, #273) proved otherwise.
- **`.release-please-manifest.json` is ONE file for BOTH components**, so every
  release PR carries a snapshot of _both_ versions, each frozen when that PR was
  generated. Merging the first one moves `main`; the second then arrives holding a
  stale copy of the version the first just bumped. release-please only regenerates
  a PR when its _own_ component changed, so it left the other PR untouched.
  `always-update: true` is now set in `release-please-config.json` to force a
  refresh whenever the base branch moves; the schema documents it as being for
  exactly this ("pull requests must not be out-of-date with the base branch").
  It has NOT yet been observed working, because it only takes effect on the next
  cycle with two PRs open.
  - If it still conflicts, resolve by hand rather than trusting either side:
    check out the release branch, `git merge origin/main`, and write the manifest
    so **each component keeps its own new version** (server from the server PR,
    firmware from the firmware PR), then push to the release branch.
  - The conflict is currently _loud_ only because the file is four lines, so
    everything lands in one diff hunk and git refuses. **With a third component
    the hunks separate, git auto-merges cleanly, and a merge would silently roll a
    version back.** If a component is ever added, add a CI guard that fails a
    release PR whose manifest disagrees with `main` on lines it is not releasing.
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

- **The walk itself is unchanged, but it is no longer a direct synchronous
  call.** `getAllManifests()` now reads a persistent Postgres snapshot
  (`firmware_catalog_state`), hydrated at boot by `initializeFirmwareCatalog()` /
  `syncAutoPoll()` (`src/instrumentation.ts`) and refreshed asynchronously with
  lease coordination across replicas — this replaced an earlier design where an
  expired poll interval made the _next_ request block on GitHub, including the
  admin dashboard's cold path.
- **The server now proxies the firmware binary itself, not just its
  discovery.** `/api/v1/ink/firmware` (`src/lib/firmware-download.ts` +
  `firmware-binary-cache.ts`, a bounded 128 MiB in-memory LRU with
  request-coalescing) serves the binary behind an HMAC-signed, device-bound
  download grant (mac/tag/model/expiry, signed with the device token, 10-minute
  TTL). `/api/v1/ink/config` hands the device a Vellum URL built by
  `createOtaDownloadUrl()` **only when `VELLUM_PUBLIC_URL` is set and HTTPS**
  (`otaOrigin.startsWith("https://")` in `config/route.ts`); otherwise it falls
  back to the raw GitHub URL, which is a **local-HTTP-dev accommodation, not a
  security fallback** — production firmware refuses plaintext OTA transport
  either way. Devices still verify model, SHA-256 and the Ed25519 signature
  before boot regardless of which origin served the bytes.

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
