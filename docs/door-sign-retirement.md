# Retiring `door-sign` and `door-sign-multi`

Both types are retired in favour of `name-plate`. They still render, they can no
longer be created, and their code stays in the tree because the free-positioning
editor is the obvious starting point for a free-form sign later. This file is the
record of why, and of what is still outstanding.

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

- `ContentRenderer.deprecated` marks a type as retired. `getAllContentTypes` filters
  those out, which removes them from the "new content" menu; `createContentInstance`
  refuses them outright, because a hidden option is a suggestion and this is a rule.
- The two labels say "stillgelegt" / "retired" in all five locales, so the pill on
  the existing instance is honest about what it is.
- `src/lib/content/__tests__/retirement.test.ts` asserts both halves: still
  registered and still renderable, and no live type carries the flag by accident.

Nothing about rendering changed. The two devices on that instance are unaffected.

## What is outstanding

1. ~~**Check production.**~~ Done on 2026-08-25. There is one database, `vellum` on
   192.168.2.20, and it is the one `.env` names; there is no separate development
   instance, so the counts below are the counts that matter.

   ```
   room-booking     3
   door-sign        1
   name-plate       1
   door-sign-multi  0
   ```

   So `door-sign-multi` can be unregistered without any migration at all, and the
   migration below is one instance, "2C.3.03", carrying two devices: the wall-mounted
   `58E6C50F4054` (d1001) and `DEADBEEFCAFE`, which is the development SIMULATOR
   rather than a stale test device. The simulator must NOT be deleted to tidy up: it
   re-enrols the next time the page is opened.

2. **Migrate the surviving instances.** `door-sign` → `name-plate` is mechanical:
   `providerId` and `resourceId` become one calendar seat, the `Raum {…}` box becomes
   `roomName`. The devices gain a correct free state and lose the geometry override.
3. **Then, and only then, unregister and park the code.** Removing a slug while an
   instance still names it makes `getContentRenderer` return undefined and the render
   route answer 500, which on a wall is a display that stops updating. Migration
   first, verification second, code move third.

Step 3 is where the physical mothballing belongs, because until the slugs are
unregistered the files have to stay where the registry can reach them.

## What is worth keeping, and why

Roughly 1 640 lines across `door-sign.ts`, `door-sign-multi.ts`, their two type
files, `shared.ts`, the two editors and `text-box-canvas.tsx`. The valuable part is
not the door-sign semantics but the **free-positioning editor**: a canvas, boxes in
fractions of the panel, template strings resolved against a context, per-geometry
overrides. That is most of a "free sign" content type, which is a plausible thing to
want and a poor thing to write twice.

Two notes for whoever revives it:

- `door-sign-types.ts` is imported by four places in the admin UI, largely for
  `KNOWN_DISPLAYS`. That belongs in `src/lib/display.ts` and should move there when
  the rest is parked, rather than travelling into the attic with it.
- Keeping the parked code under `src/` means `tsc` keeps checking it, so it will not
  rot into unbuildable archaeology. The cost is that a refactor of the UI kit has to
  fix code nobody uses. If that cost starts being paid regularly, delete it: git has
  it, and this file says what it was.
