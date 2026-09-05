# Contributing to Vellum

Vellum drives e-paper displays that hang on walls and update themselves. A
mistake here is not a red build, it is a sign in a corridor that quietly stops
telling people the truth. The rules below exist for that reason rather than for
tidiness.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), without exception.
release-please derives the version and the changelog from them, so a commit
outside the scheme produces a wrong version or a missing entry.

```
<type>(<scope>): <subject in the imperative>
```

Types in use: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`, `perf`,
`build`, `style`, `revert`. Anything else is rejected by
`scripts/hooks/check-commit-message.sh`, which runs in the `commit-msg` hook
and again in CI, so the two cannot drift apart.

Two consequences worth knowing:

- **`feat` bumps the minor version, `fix` the patch.** A `chore` bumps nothing.
  Choose the type by what the change does to users, not by how much work it was.
- **The pull request title is checked too.** Merges are squashes, so the title
  becomes the subject line on `main` and release-please reads exactly that.

Do not put AI attribution trailers in commits or pull request bodies — no
`Co-authored-by:` naming an assistant, no "Generated with" line. The
`commit-msg` hook and the `commit-hygiene` CI job reject them.

## Branch names

`<type>/<short-subject>`, matching the commit type: `feat/name-plate`,
`fix/first-frame-geometry`, `chore/repo-standard-class-a`. Never work directly
on `main`; it is protected and requires the `Required Gate` check.

## Before you push

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm i18n:check && pnpm db:check && pnpm release:check
```

The `pre-push` hook runs the fast subset of this. CI runs all of it plus the
build, the deployment assets and the firmware host tests, aggregated into one
required check.

Two gates deserve a word because they are easy to trip:

- **`pnpm i18n:check`** fails on user-visible prose that is not in the message
  catalogues. All five locales must carry the key.
- **`pnpm db:check`** fails when `src/db/schema.ts` and `drizzle/` disagree.
  Migrations are generated (`pnpm db:generate`), never hand-edited: production
  applies them on container start, so a migration that fails keeps the server
  from booting at all.

Coverage has a hard floor in `vitest.config.ts`. It is a ratchet — raise it when
coverage grows, never lower it to make a run pass.

## Firmware

Changes under `firmware/` and `firmware-d1001/` build a single model on every
pull request and the full signed matrix only on a `firmware-v*` release. The USB
and console wiring differs **per model**; never "fix" it uniformly across them.

## Reporting a problem instead

Bugs and features go through the issue templates. Security findings do not —
see [SECURITY.md](SECURITY.md).
