# Releasing

Vellum ships two independently-versioned artifacts on separate cadences. They are
decoupled so a server-only change never rebuilds firmware or pushes a needless
OTA to the fleet, and a firmware-only change never rebuilds/re-tags the server
image.

| Artifact | release-please component | Version SSOT | Git tag | Built by |
|----------|--------------------------|--------------|---------|----------|
| **Server** (Next.js / Docker) | `server` (`.` root, `node`) | `package.json` | `vX.Y.Z` | `docker.yml` |
| **Firmware** (ESP32 OTA) | `firmware` (`simple`) | `.release-please-manifest.json` → `firmware/main/Kconfig.projbuild` | `firmware-vX.Y.Z` | `firmware.yml` |

> The firmware version of record is the `firmware` key in
> `.release-please-manifest.json`; release-please propagates it into
> `firmware/main/Kconfig.projbuild` (the `x-release-please-version` default),
> which the build reads. `firmware/version.txt` is **gitignored** (the build
> regenerates it for `PROJECT_VER`) and is **not** a source of truth.

## How it works

release-please routes each Conventional Commit to a component by the paths it
touches: changes under `firmware/**` bump the **firmware** version; everything
else bumps the **server** version. It opens (and keeps updated) a separate
release PR per component. Their titles always include the component and version
(`chore(main): release server X.Y.Z` or `chore(main): release firmware X.Y.Z`),
which makes the post-merge lookup unambiguous. Merging a release PR publishes a
GitHub Release under that component's tag, which triggers exactly one build
workflow:

- **Server release** (`vX.Y.Z`) → `docker.yml` builds + signs the multi-arch
  image and moves `latest`. `deployment-assets.yml` attaches the versioned
  `docker-compose.yml`, `vellum.env.example`, and their `SHA256SUMS` file.
  `firmware.yml` also triggers on the same
  `release: published` event, but its jobs skip (gated on the tag name — the
  `version` job's `if:` requires a `firmware-*` tag, so it and the downstream
  `build` / `sign-and-release` jobs skip on a server release).
- **Firmware release** (`firmware-vX.Y.Z`) → `firmware.yml` builds the model
  matrix, signs each OTA image (Ed25519), and uploads `firmware-manifest.json`
  to the release. `docker.yml` also triggers, but its jobs skip (its `build` job
  is gated to non-firmware tag names).

> **Merge release-please PRs with a merge commit, not a squash.** Squashing a
> release PR rewrites the release commit, and release-please can then fail to
> create the GitHub Release object from it (observed on v1.2.1 under the
> multi-component config — the tag/release had to be created by hand). A merge
> commit preserves the release commit release-please expects. Only the two
> `chore: release …` PRs need this; ordinary feature/fix PRs stay squash-merged.

`pnpm release:check` guards the component split, parseable PR-title contract,
tag formats, workflow wiring, and both version sources. It runs during pre-push
and as the dedicated **Release Config** CI check.

An existing server release can be backfilled without rebuilding an image or
firmware by manually running **Deployment Assets** with its `vX.Y.Z` tag. The
workflow checks out that tag, so the uploaded deployment files always match the
released server source.

## Why this is safe for the fleet

Devices discover updates by scanning GitHub Releases **newest-first for the first
stable release carrying a `firmware-manifest.json` asset** (`src/lib/firmware.ts`),
not by "latest release" or tag name. Server releases publish no such asset, so
they are simply skipped — a device sees a new firmware version only when a real
firmware release exists. Because the release version is baked into the binary
(`CONFIG_VELLUM_FIRMWARE_VERSION`), the manifest version always equals the
version the device reports after flashing, so there is no update-loop from a
version that can never be reached.

Because server releases now share the same `/releases` list the fleet walks, the
newest stable firmware can sit several manifest-less releases deep. The walk is
bounded (`MAX_RELEASE_PAGES`) with large headroom, backed by a page-1 ETag
fast-path and a permanent per-release manifest cache, so steady-state polling
cost stays near zero and the bound only matters on a cold cache.

## Database migrations (server)

Server schema changes ship as `drizzle/*.sql` files — generate with
`pnpm db:generate` after editing `src/db/schema.ts`, and commit the SQL plus
`drizzle/meta`. They are applied by **`pnpm db:migrate`** (`scripts/migrate.mjs`),
**not** `drizzle-kit migrate` — whose journal is empty here because the databases
were created with `drizzle-kit push`, so `drizzle-kit migrate` would try to replay
`0000…` against existing tables. The runner is idempotent and **self-baselining**:
a statement whose object already exists is recorded rather than failed, so it
adopts a pre-existing DB and applies only genuinely-new statements.

The Docker image runs `db:migrate` on container start (**fail-open** — see the
Dockerfile `CMD`), so a server release deploys with no manual migration step.
Migrations are additive, and the app degrades gracefully if it happens to start
before the schema catches up.

## Onboarding the firmware component (one-time)

The `firmware` component is anchored by the tag **`firmware-v1.2.0`** at the
`v1.2.0` release commit. Without it, release-please would have no prior-release
SHA for the component and would open a first firmware PR enumerating all
historical firmware commits. The tag has no GitHub Release attached, so the fleet
(which discovers by release asset) never sees it — it exists purely as a
release-please anchor — there is intentionally no `firmware-v1.2.0` *release*.
That anchor has since been superseded by the first real firmware release,
**`firmware-v1.2.1`**, now the firmware version of record
(`.release-please-manifest.json` `firmware` = `1.2.1`, propagated into the
Kconfig default). The next firmware version is **whatever release-please
computes** from the `firmware/**` commits landed since `firmware-v1.2.1` — don't
assume a specific number.

## Beta firmware

Any push under `firmware/**` (that is not a release-please release commit) builds
a prerelease. The version / manifest string is `firmware-vX.Y.Z-beta.N+<sha>`,
but because `+` (SemVer build metadata) is illegal in a git ref, the git tag and
release name rewrite the `+` to `-` (e.g. version `1.2.1-beta.7+42b4910` → tag
`firmware-v1.2.1-beta.7-42b4910`). Betas also carry a manifest; the server
exposes them on the `beta` channel.
