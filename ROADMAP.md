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

- [x] **The E1003 can carry colour after all; the projection was wrong.** Both badge
      colours snapped to the same grey, and so did the accents, but not because a grey
      ramp cannot hold the distinction: Euclidean distance to a ramp depends only on
      the SUM of the channels, and pure red, green and blue share it. Of sixteen levels
      the theme reached two. `snapThemeToPalette` now matches a greyscale palette by
      perceived LIGHTNESS, which is the only thing such a panel can carry of a colour,
      so free `#DDDDDD` and busy `#777777` now sit 3.3:1 apart with opposite text
      polarity. Palettes with hue keep the Euclidean match.
  - The name plate's accent is no longer switched off on greyscale. Its four levels are
    CHOSEN rather than derived, because deriving them puts green at 87 % lightness and
    yellow at 97 %, which as a full-width bar on a white panel reach 1.4:1 and 1.0:1
    against the page. They are spread across the usable band instead, keeping the hues'
    lightness order: blue `#222222`, red `#444444`, green `#666666`, yellow `#888888`.
  - Honest limit, recorded in the code: four grey levels are told apart side by side,
    not from down a corridor. On the E1003 an accent is a marker for someone at the
    door. Two or three classes carry reliably in grey.
  - The header's text colour stays DECLARED on hue panels and is derived only on grey.
    A Spectra pigment is mid-dark where its code `#00FF00` measures 1.4:1 against
    white, so deriving there would take the preview's word over the wall's.

- [x] **`/api/v1/admin/preview` now snaps the theme to the palette**, as the render
      route always did. Without it, preview and device disagreed by construction on
      any panel whose palette moves a theme colour, which is why the mono defect
      above showed up in no preview for months: every one of them drew the grey as
      grey.

- [x] **A clipped timeline block kept the time range and dropped the occupant.** The
      eight-hour window clips a booking at `areaTop`, so a RUNNING meeting shrinks in
      two-hour steps as the day passes, and the occupant's line was gated on that
      clipped height. Measured on an E1003 in landscape, where a line is 70 px and
      the threshold is therefore 140: a 10:00-13:00 booking rendered at 10:30 had
      387 px of visible block and printed "Maria Warnking", the same booking at
      12:30 had 129 px and printed only "Projektbesprechung 10:00 - 13:00". The
      800x480 panels reach the same cliff at 132 px against 48, since `scale` moves
      line height and drawing area together and the threshold lands at about 1.08 h
      of visible booking on every panel. So the line saying WHO is in the room went
      first,
      and it went precisely while the meeting ran, since only a running booking is
      clipped at the top.
  - `planBlockText` in `room-booking-blocks.ts` now fills the available lines by
    priority instead of by a fixed stack. One line goes to the occupant, because a
    sign beside a door answers "who is in there" and a passer-by can do without the
    meeting's title. The time range keeps the right end of line one and costs no
    line, giving way only when a single line would otherwise be cut short.
  - It is a separate pure module so the invariant can be asserted directly: a block
    the window has clipped must not identify the occupant less well than the same
    booking unclipped. Same shape as the monotonic reach test on the name plate.
  - The duplicate check went from exact equality to a prefix test, because the
    redundant case is the normal one. anny reports the subject as "Lukas Thiele
    (Hochschule Hannover)" and the organizer as "Lukas Thiele", so the second line
    repeated the first on every booking that provider serves. It stops short of a
    substring search, which would swallow "Besprechung mit Thiele".
  - Why it read as a preview-versus-device bug: the preview renders at the instant it
    is opened, the panel shows the frame from its last poll, and two moments in
    different two-hour buckets disagree about the same booking.

- [x] **Frames are now observable, and five invariants hold across renderers,
      panels, clocks and booking shapes.** Stage 1 of the renderer refactor. A
      renderer asks a `SurfaceFactory` for somewhere to draw instead of calling
      `createCanvas`, so a test can hand it a canvas that also RECORDS every piece of
      text and every filled rectangle (`lib/render/surface.ts`). The seam wraps the
      CONTEXT rather than the drawing helpers, because renderers reach for
      `ctx.fillText` directly in several places and the offline screen does nothing
      else, so a helper-level seam would be blind exactly where the least-tested code
      is.
  - The five, in `lib/render/frame-invariants.ts`: every string the model owes is
    drawn (READS), exactly one state label appears (STATE), no text below 3:1 against
    the ground it sits on (CONTRAST), no ink outside the panel (BOUNDS), nothing
    condensed past 0.8 of its width (LEGIBLE). The ground comes from a painter's-
    algorithm walk of the recorded fills, sampled at three points across the ink; over
    a QR code or a background image there is no resolvable ground and the check
    ABSTAINS rather than guessing, with the bitmap count kept so the abstention stays
    visible.
  - Why relations and not stored pixels: a hash of a frame breaks on a Skia or font
    update that changes nothing anyone cares about, and then gets updated without
    being read. A claim about what the frame SAYS survives both.
  - The sweep (`renderers/__tests__/frame-sweep.test.ts`, 100 cases) is factored, not
    exhaustive: the clock is swept on the two 800x480 panels and the geometry on all
    four at three times, because clipping is scale-invariant and geometry does not
    depend on the clock. Full multiplication would mean 500 renders of a 1872x1404
    surface in a suite that has to run on every commit.
  - Both invariants that matter were mutation-tested rather than assumed. Reverting
    `planBlockText` to put the subject on a one-line block fails 12 cases; removing
    `readableOn` from the event block fails 13 with CONTRAST. A green invariant suite
    that cannot fail is worse than none, because it reads as coverage.
  - Coverage 75.2 / 68.3 / 76.1 / 77.8, floors raised to 74 / 67 / 74 / 76.
  - Three things stage 1 could NOT reach, all waiting on the fetch seam of stage 2:
    a name plate's "Frei" and "Belegt" (a static seat may not be nameless, so only the
    unreachable-provider state is drivable without a database), the two retired door
    signs (wired for the seam, not swept), and room-booking's stacked layout beyond its
    offline fallback.

- [x] **A renderer is two steps now: `load` fetches, `draw` paints.** Stage 2. The
      interface enforces it rather than recommending it, because `DrawParams` carries
      no clock and no timezone: anything that depends on the moment has to be put in
      the model by `load`. A frame's instant is DATA; reading the wall clock while
      painting is not.
  - What it bought, measured rather than asserted. `room-booking.ts` went from 51.9
    to 68.8 % of statements and 38.6 to 57.6 % of branches, `name-plate.ts`'s branches
    from 31.6 to 43.4 %. Nobody wrote a test for either file. The code simply became
    reachable without a database, which is the same effect that had already put
    `name-plate-layout` and `name-plate-sizes` at 100 %: coverage follows
    decomposition, not diligence.
  - The three cases stage 1 could not reach are swept: a plate's "Frei", its "Belegt"
    and its "Keine Verbindung" on all four panels, and room-booking's stacked layout
    against every booking shape. 128 cases in the sweep, up from 100.
  - Mutation-tested like stage 1. Making a free band say nothing fails four cases with
    "no state label appears". Without that check the free state was untestable and, on
    the retired door sign, still is broken.
  - Two findings from writing the sweep, both mine rather than the renderers'. Hand-built
    seat objects bypassed zod, so `role` and `unit` were undefined where the code trims
    them; the sweep now parses its configs through the real schema. And the occupied
    state's wording depends on `showStatus`, by design, because the pill carries the
    DETAIL ("bis 12:00") when there is one: each case therefore brings its own set of
    mutually exclusive wordings instead of the assertion being loosened to fit.
  - `drawPlate` and `drawRoom` were kept under the complexity limit by pulling the
    plate's measurements into a pure `planPlate`, which is the same move again.
  - Not done here, deliberately: `renderContent` composes the two halves in one place
    so that caching `load` per content instance rather than per device is a one-line
    change, but the cache itself is stage 4. Today N displays on one room each fetch.

- [x] **The two layouts share their frame, and the stacked layout names the
      occupant.** Stage 3. `renderToCanvas` (115 NLOC, 14 positional parameters) and
      `renderStacked` (114 NLOC, 13) opened with the same twenty lines and closed with
      the same eight. Both now take ONE `FrameSpec` and call `openFrame` and
      `closeFrame`; the timeline is 18 lines of its own, the stacked layout 20.
  - The extraction is pixel-neutral for the timeline, checked rather than assumed: the
    same inputs rendered before and after produce a **byte-identical** PNG.
  - Two drifts surfaced while merging the two openings, neither intended. The timeline
    computed a `footerH` the stacked layout did not, and the stacked layout skipped the
    alignment reset before its footer.
  - The stacked CARD now fills its two lines with `planBlockText`, the same rule the
    timeline block uses, so a room display naming nobody is no longer possible in one
    layout while being impossible in the other. The time moves to the right end of line
    one, where the timeline has always kept it, and costs no line. This is the fix for
    the item that stood open here: on Microsoft 365 the subject is the meeting title, so
    the card used to show no person at all.
  - The sweep demands the occupant on the stacked layout from now on, over two clock
    positions so that most shapes actually owe something. 148 cases, up from 128, and
    721 tests. Mutation-tested: restoring the old card text fails 16 cases with
    "is on no line of the frame".
  - Left standing on purpose: `renderBookingQr` (57 NLOC) and `renderHeader` (54) are
    the only two functions still over the complexity limit in this file, neither
    introduced nor touched here. The first is the QR-duplication item below.

- [x] **Four event caches became one, and it can now say what it saves.** Stage 4a.
      `room-booking`, `door-sign`, `door-sign-multi` and `name-plate` each held their
      own `TtlCache` under their own key prefix, so a name plate and a door sign
      pointed at the same anny desk fetched it twice, three of the four ignored the
      configured `cacheTtlS` in favour of a hard-coded minute, and none could report a
      hit rate. `calendar/source.ts` replaces all four.
  - All four keyed on `providerId + roomConfig` and IGNORED the window they had asked
    for, so a hit could answer a different question than the one asked. The window is
    part of the key now, rounded outward to whole hours so that being part of the key
    does not defeat it, and the wider result is clipped on the way out.
  - Twenty displays polling one room within an hour now cost ONE provider call, which
    is asserted rather than asserted-in-prose: `source.test.ts` counts them.
  - The limit is written down in the module and asserted too: sharing needs the
    ROUNDED windows to coincide, so the three day-window renderers share with each
    other, and a room display's rolling sixteen hours does not share with a name
    plate's calendar day. Closing that means partitioning by day, and anny fetches
    every page of a resource's bookings per call regardless of window, so a two-day
    span would double the most expensive thing here. Revisit when a room and a desk on
    one provider are actually polled together.
  - Side effect worth having: `room-booking.ts` no longer imports `@/db` at all. Its
    one remaining hand-rolled provider read, in `resolveBookingUrl`, went to the same
    loader the source uses.

- [x] **All four calendar providers now pass one shared contract.** Stage 4b. The two
      that talk to the outside world were the two with no tests at all, which is the
      wrong way round: `microsoft365` sat at 11.1 % of statements and **0 %** of
      branches, `google` at 12.0 % and 0 %. Four implementations of one interface had
      four ideas of what the interface promises and nothing said which was right.
  - Where it stands now. microsoft365 **100 % / 80.8 %**, google **92 % / 62.5 %**,
    ical 88.5 % / 73.0 %, anny 79.3 % / 66.2 %; the provider directory as a whole from
    58.7 / 46.2 to 86.2 / 69.9.
  - Five shared cases, none of them invented: every field is the type the renderers
    assume without checking (a provider returning undefined for `organizer` is a crash
    on a wall); a local time with an offset is read as the right instant; a private
    booking is marked private; an unattributed booking yields a STRING organizer; and
    an out-of-order source loses nothing.
  - Each provider brings a `serve` that translates the neutral case descriptions into
    its own wire format. Writing those four adapters is half the value: they are the
    only place in the repository where each provider's payload shape is written down,
    and the double behaves like the real source, including whether the WINDOW is
    filtered server-side (Graph and Google) or by the provider (anny, iCal).
  - A skip has to give a reason, and the suite reports it as a passing test rather
    than as silence. anny has no privacy flag; Graph has no offset to read, because it
    reports naive local time plus a `timeZone` field and this provider sends no
    `Prefer: outlook.timezone`, so the "Z" it appends is right only for as long as
    that stays true.
  - Graph's own rule finally has tests: a resource mailbox that auto-accepts becomes
    the organizer of the booking it accepted, so the provider falls back to the
    attendees rather than printing the room's name on the room's own sign. Six cases
    around it, including the case-insensitive address match and the "(+2)" suffix.
    Mutation-tested: letting the room name itself fails four of them.

- [x] **The device detail view was not on the design system, and its logs were
      unreadable.** Reported from use: grey text on a light ground, and nothing
      matching the rest of the admin. Measured against the real built CSS, the log
      block reached **1.05:1** in dark mode — white text on `bg-gray-50` — against
      12.90:1 after. It named a background and no foreground at all, so the text took
      whatever it inherited, which `body` sets to `--color-label`.
  - The view held **66 of the 119** raw Tailwind palette classes in the whole UI. It
    predates the Aurora tokens: a local `Card` on `bg-white`, a local `Badge` painted
    by hand, `text-gray-500` throughout, and nine borders with no colour at all, which
    Tailwind resolves to `currentColor`. None of it adapts, and the theme toggle
    defaults to `system`, so most operators see the dark set.
  - It now uses the kit: `Card` from `components/ui/card`, `StatusPill` for all six
    status chips, and tokens everywhere. Zero raw palette classes remain in it.
  - `scripts/check-theme-tokens.mjs` is new and runs inside `pnpm lint`, which is
    already a required check, so no workflow or branch-protection change was needed.
    It is a BUDGET rather than a ban, like the coverage floors: 53 occurrences remain
    across 12 other views, each file may keep what it has and no more, and the gate
    also fails when a count drops below its budget so that a gain gets locked in.

- [x] **The i18n gate could not see the page that needed it.** Its third part, the
      hard-coded-text check, ran against an allowlist of THREE files, so 108 literals
      across 26 views were never looked at. The detail view had eight English toasts
      and four English connectivity labels sitting next to a locale file that already
      translated all four.
  - Two fixes. The view joins the allowlist now that it is clean, and the checker
    learned the shape it was blind to: a string in an object-literal property named
    `label`, `title`, `message` and so on. That shape is neither JSX nor an attribute,
    which is precisely how `{ label: "Online" }` passed on every commit.
  - Units and example URLs are exempt, with the reason in the code: "dBm" and "1min"
    carry two letters and are words by the crude test, but a unit is a unit in every
    locale.

- [x] **The palette debt is gone.** All 53 raw classes across the remaining 11 views
      are on the Aurora tokens, and `scripts/check-theme-tokens.mjs` carries an empty
      budget table.
  - One more instance of the log block's defect turned up on the way, in the view the
    refresh profiles are edited in: `schedule-timeline`'s legend sits on the PAGE, not
    on its dark bar, and marked the active rule with `text-white`. White on white in
    light mode. It uses `text-label` now, which is the page's own foreground by
    definition, so it cannot be wrong the way a fixed colour can.
  - The gate learned to separate DEBT from DECISION. `db-disconnect-overlay` keeps 9
    classes and is listed under `DELIBERATE` with its reason: a blocking full-viewport
    alert over a blurred backdrop is dark in both themes on purpose. Its
    meaning-carrying colours (fault icon, circuit state, failure count) still moved to
    the tokens, because those have to stay recognisable across the admin.
  - A `dark:` variant on a token is dead weight and reintroduces the raw palette;
    `admin/error.tsx` had one.

- [x] **The hard-coded strings are gone, and most of them were duplicates.** Of 119
      literals across 28 views, only about fifty were ever translatable prose, and a
      large share of THOSE already had translated keys sitting unused: `dashboard`
      already held online / late / offline / never seen / Avg battery / Low battery /
      Weak signal, exactly the seven the fleet panel painted in English. The same
      pattern as the connectivity labels on the device page. Nineteen keys were
      genuinely new.
  - The gate guards every view now instead of an allowlist of four, and is structured
    like the theme gate: a NOT-PROSE filter, an EXEMPT table with reasons, and an empty
    budget. It refuses an exemption whose reason is shorter than a sentence.
  - What is exempt and why: the simulator (its page 404s outside development), the
    retired door-sign editors and their canvas, `theme-preview` (sample content inside
    a miniature of a rendered sign, where a device renders in the CONTENT's locale
    rather than the operator's), and `global-error` (it renders its own `<html>` and
    therefore REPLACES the provider that supplies the messages, so a translated string
    there would throw inside the handler for a crash).
  - Not prose, and named as such rather than translated: brands, the endonyms in the
    language picker (translating those defeats a language picker), units, IANA zones,
    template placeholders, firmware channel identifiers used verbatim in the API,
    HTML entities, and shell commands meant to be copied.
  - Two fixes fell out of it. The date-format options showed hardcoded GERMAN samples,
    so an operator configuring an English sign chose between "Sonntag, 3. Mai 2026" and
    "03.05.26"; they are formatted in the sign's own language now. And the root
    metadata description became `generateMetadata`, so it follows the operator's
    language like everything else.

- [x] **The device detail view was missing what an operator most needs to know.**
      A pass over the page against what the database actually holds, prompted by
      asking whether it shows everything it could.
  - **The firmware history was absent entirely.** The page loaded the device,
    telemetry, reports, configuration commands and logs, but not `ota_events`. The
    estate holds a `rolled_back` with `error_code = boot_health_check` and a
    `verify_fail` for one wall-mounted panel, and its own page said nothing about
    either. The row renderer already existed on the firmware page, so it moved to
    `components/ota-event-list.tsx` and both callers use it; the phases are words
    now rather than identifiers.
  - **The display card printed a dead field.** `caps.quantize` is the LEGACY shape,
    migrated to `format` + `colorMode` in `lib/display.ts`, and no device in the
    estate reports it, so "Quantize" read "—" on every display. It shows colour
    mode, palette size, orientation and backlight capability instead — all of which
    were sitting unread in the same object.
  - **Four columns were invisible because the component's own prop type omitted
    them**: `orientationOverride`, `firmwareChannel`, `firmwarePinVersion` and
    `timezone`. All four are per-device settings `updateDevice` already accepts. The
    channel and the pin have a card now.
  - **"Last seen" was unreadable as a health signal.** A display that sleeps 20 575 s
    between calls can be two weeks quiet and perfectly healthy. The cadence and the
    next expected contact are shown beside it; both numbers were already on the page
    and only their difference was missing.
  - NVS encryption is collected and was the only one of the three encryption facts
    the security card did not print.
  - The heading names the room the display carries. A device has no name of its own,
    which is the next item below.

- [x] **Hard-coded locales in date formatting, and a gate against them.** Ten across
      the repository, six on the device page: `toLocaleString("de-DE")` shows an
      English operator German dates. Invisible to the text check, because a locale is
      an argument rather than a string a reader sees. `check-i18n.mjs` now refuses one,
      and the message says what to pass instead.

- [ ] **A device has no name.** It is identified by its MAC everywhere, and the only
      human handle is the content it happens to carry, which changes when the
      assignment changes. Proposed and ready to execute:
  - `devices.label text` — nullable, no default, additive. Migration
    `ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "label" text;` in the next free
    `drizzle/00NN_device_label.sql`, plus the schema snapshot that `pnpm db:check`
    requires.
  - `updateDevice` already takes a partial, so it needs one field added and no new
    action. The audit entry records the field name as it does today.
  - Display rule, one place: `label ?? content name ?? mac`. The MAC stays visible in
    the heading, because it is what the sticker on the back says and what an operator
    matches against when standing in front of the thing.
  - Touchpoints: the device table's search and column, the detail heading, the
    assignment pickers on the content and theme pages, and the preview route's
    device chooser.
  - Deliberately NOT unique and NOT required: two rooms may both hold a "Foyer" sign,
    and forcing a name at enrolment would put a dialogue in front of a display that
    is otherwise provisioned by voucher without one.

- [ ] **The offline screen ignores `scale` entirely.** `renderOffline` draws a 60 px
      header band and 32 px type at fixed offsets, so on an E1003 the room name sits
      small in the corner of a 1872 px panel. The frame invariants cannot see it: the
      text is inside the panel and the room name is present, it is merely tiny. Worth
      fixing when the offline screen next gets attention; it is the one frame a wall
      shows when everything else has failed.

- [ ] **The preview still resolves three things differently from `/render`.** Beyond
      the theme snap below, `/api/v1/admin/preview` (a) picks the device by
      `.limit(1)` with NO `ORDER BY` when several use the instance, which on the
      development estate silently chose a test device with a different panel and
      orientation than the one on the wall, (b) never resolves the `isDefault` theme,
      only an explicit `themeId` query parameter, so designating a default makes every
      preview wrong, and (c) returns the raw canvas instead of running
      `canvasToPixelBuffer`, so quantisation artefacts appear on no preview. It also
      reads `devices.contentInstanceId` directly and therefore misses content assigned
      through a site. Resolve exactly as the render route does, and name the panel the
      preview stands for.

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
