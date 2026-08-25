# Retiring `door-sign` and `door-sign-multi`

Both types are retired in favour of `name-plate`. As of 2026-08-25 the retirement is
complete: they are unregistered, they no longer render, and their code is parked
under `retired/` because the free-positioning editor is the obvious starting point
for a free-form sign later. This file is the record of why, and of what was done.

## Why

Three door-sign types stood in the menu at once, which was worse than the two the
operator complained about in the first place. Deciding which to keep was not a
matter of taste, because the estate answers it:

- **`door-sign-multi` has never been used.** Zero instances, in a database that has
  five.
- **`door-sign` has exactly one instance**, on two devices, and it uses none of what
  the type is for. No background image, white ground, two text boxes reading
  `{full_name}` and `Raum {resource_name}`, and one hand-made design override for
  800×480 — the per-geometry duplication that prompted the whole exercise.
- That instance has **no `freeTextBoxes`**, so when the room is free the sign renders
  a blank white panel. A live defect, not a preference.
- Its config also carries a stray `policy` key, which belongs to `room-booking`, is
  absent from `doorSignConfigSchema`, and is silently dropped by zod.

So the one real door-sign is a worse expression of what `name-plate` already does:
room in the header, occupant in ranks, an explicit "Frei", and a layout that
survives a change of panel.

What the retired types can do that `name-plate` cannot is a short list, and none of
it is in use: a background image, freely positioned template text, and
`cachedProperties` for arbitrary provider fields in a template.

## What is done

Staged, because the order was the safety property rather than a preference. Removing
a slug while an instance still names it makes `getContentRenderer` return undefined
and the render route answer 500, which on a wall is a display that quietly stops
updating.

1. **Held them registered but deprecated.** `ContentRenderer.deprecated` kept the two
   types renderable while removing them from the "new content" menu, and
   `createContentInstance` refused them outright, because a hidden option is a
   suggestion and this needed to be a rule. The labels read "stillgelegt" / "retired"
   in all five locales so the pill on the surviving instance was honest.
2. **Counted the estate.** Production held no door sign at all; see below.
3. **Migrated the one surviving instance.** Development's `door-sign` "2C.3.03"
   became a `name-plate` with two seats on 2026-08-25, applied against the
   development database directly. It gained a correct free state and lost its
   800×480 geometry override.
4. **Unregistered both slugs and parked the code.** `src/lib/content/retired/` and
   `src/components/retired/`. Two things came out of the attic on the way, because
   they were never door-sign concerns: `KNOWN_DISPLAYS`, `DisplaySize` and
   `DEFAULT_DISPLAY` now live in `src/lib/display.ts`, and the calendar fetch is
   shared through `src/lib/calendar/source.ts`.
5. **Removed what only the retired code fed.** `getKnownDisplaySizes` in
   `admin/actions.ts` existed for the two parked editors alone. An exported server
   action is a reachable RPC endpoint, so it went rather than idling behind a
   permission check; the parked editors still take `knownDisplays` as a prop, and
   whoever revives them supplies it. The `door-sign` branch of `testContentInstance`
   went too, as it had become unreachable rather than merely unused.

`src/lib/content/__tests__/retirement.test.ts` now asserts the end state: neither
slug resolves, nothing carries the `deprecated` flag any more, exactly
`name-plate` and `room-booking` are creatable, and every live type has both a `load`
and a `draw`.

## What is outstanding

1. ~~**Check production.**~~ Done on 2026-08-25, and the answer changes the rest of
   this list. **Production holds no door sign at all.**

   ```
   room-booking     1     ← "lexICT Besprechungsraum"
   door-sign        0
   door-sign-multi  0
   name-plate       0
   ```

   Read from the production database itself, which is the container
   `vellum-postgres` on spock. Note the trap that cost a wrong answer first: its 5432
   is published only INSIDE the compose network, so a host-port query on
   `192.168.2.20:5432` reaches the DEVELOPMENT container instead and both databases
   are called `vellum`. Reach production through the container:

   ```
   ssh spock "docker exec vellum-postgres psql -U vellum -d vellum -tAc '…'"
   ```

   All three production devices are on that one room-booking instance, and each has a
   different panel: `10B41DE59E7C` (e1002), `E072A1D85BD0` (e1003), `58E6C50F4054`
   (d1001). Worth knowing for the preview, which until 2026-08-25 chose among them
   arbitrarily.

   The single `door-sign` instance, "2C.3.03", exists only in the development
   database. One of its two devices is `DEADBEEFCAFE`, which is the development
   SIMULATOR rather than a stale test device: it re-enrols the next time the page is
   opened, so it must not be deleted to tidy up.

2. ~~**Migrate the surviving instances.**~~ Done; see step 3 above.
3. ~~**Unregister and park the code.**~~ Done; see step 4 above.
4. **Confirm the migrated sign on the panel.** The one thing still genuinely open.
   The content and the code are right and the tests cover the layout, but nobody has
   yet looked at `58E6C50F4054` showing a two-seat name plate. That verification is
   blocked on the path-MTU black hole to 192.168.2.20 rather than on any code.

## What is worth keeping, and why

Roughly 1 640 lines across `door-sign.ts`, `door-sign-multi.ts`, their two type
files, `shared.ts`, the two editors and `text-box-canvas.tsx`. The valuable part is
not the door-sign semantics but the **free-positioning editor**: a canvas, boxes in
fractions of the panel, template strings resolved against a context, per-geometry
overrides. That is most of a "free sign" content type, which is a plausible thing to
want and a poor thing to write twice.

Two notes for whoever revives it:

- The parked files import `@/lib/display` for `KNOWN_DISPLAYS` and `DisplaySize`,
  which stayed behind deliberately: they were never door-sign concerns and four
  places in the live admin UI need them.
- `DoorSignEditor` and `DoorSignMultiEditor` still take a `knownDisplays` prop, but
  nothing supplies it any more. Reviving them means writing that source again;
  `getKnownDisplaySizes` in `admin/actions.ts` is what it used to be, recoverable
  from git history at the commit that parked this.
- Keeping the parked code under `src/` means `tsc` keeps checking it, so it will not
  rot into unbuildable archaeology. The cost is that a refactor of the UI kit has to
  fix code nobody uses. If that cost starts being paid regularly, delete it: git has
  it, and this file says what it was.
