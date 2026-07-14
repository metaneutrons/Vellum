# Releasing

Vellum ships two independently-versioned artifacts on separate cadences. They are
decoupled so a server-only change never rebuilds firmware or pushes a needless
OTA to the fleet, and a firmware-only change never rebuilds/re-tags the server
image.

| Artifact | release-please component | Version SSOT | Git tag | Built by |
|----------|--------------------------|--------------|---------|----------|
| **Server** (Next.js / Docker) | `.` (root, `node`) | `package.json` | `vX.Y.Z` | `docker.yml` |
| **Firmware** (ESP32 OTA) | `firmware` (`simple`) | `firmware/version.txt` + `firmware/main/Kconfig.projbuild` | `firmware-vX.Y.Z` | `firmware.yml` |

## How it works

release-please routes each Conventional Commit to a component by the paths it
touches: changes under `firmware/**` bump the **firmware** version; everything
else bumps the **server** version. It opens (and keeps updated) a separate
release PR per component. Merging a release PR publishes a GitHub Release under
that component's tag, which triggers exactly one build workflow:

- **Server release** (`vX.Y.Z`) → `docker.yml` builds + signs the multi-arch
  image and moves `latest`. `firmware.yml` does **not** run (its release job is
  gated to `firmware-*` tags).
- **Firmware release** (`firmware-vX.Y.Z`) → `firmware.yml` builds the model
  matrix, signs each OTA image (Ed25519), and uploads `firmware-manifest.json`
  to the release. `docker.yml` does **not** run (gated to non-firmware tags).

> **Merge release-please PRs with a merge commit, not a squash.** Squashing a
> release PR rewrites the release commit, and release-please can then fail to
> create the GitHub Release object from it (observed on v1.2.1 under the
> multi-component config — the tag/release had to be created by hand). A merge
> commit preserves the release commit release-please expects. Only the two
> `chore: release …` PRs need this; ordinary feature/fix PRs stay squash-merged.

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

## Onboarding the firmware component (one-time)

The `firmware` component is anchored by the tag **`firmware-v1.2.0`** at the
`v1.2.0` release commit. Without it, release-please would have no prior-release
SHA for the component and would open a first firmware PR enumerating all
historical firmware commits. The tag has no GitHub Release attached, so the fleet
(which discovers by release asset) never sees it — it exists purely as a
release-please anchor. The first real firmware release will be `firmware-v1.3.0`
(there is intentionally no `firmware-v1.2.0` *release*).

## Beta firmware

Any push under `firmware/**` (that is not a release-please release commit) builds
a prerelease tagged `firmware-vX.Y.Z-beta.N+<sha>`. Betas also carry a manifest;
the server exposes them on the `beta` channel.
