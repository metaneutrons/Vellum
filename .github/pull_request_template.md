## What this changes

<!-- What it does and why. The title becomes the subject line on main, because
     merges are squashes and release-please reads it, so make it a Conventional
     Commit subject. -->

## Why this way

<!-- The alternative you rejected, and what made you reject it. Skip for a
     one-line fix. -->

## How it was verified

<!-- What you ran, and what it said. "Tests pass" is not verification; name the
     case that would have failed before. For anything a panel displays, say
     whether you looked at a real device. -->

- [ ] `pnpm lint && pnpm typecheck && pnpm test`
- [ ] `pnpm i18n:check` (user-visible prose in all five locales)
- [ ] `pnpm db:check` (schema and migrations agree)
- [ ] Firmware change: built for the affected model
- [ ] Display change: seen on a real panel, not only in the preview
