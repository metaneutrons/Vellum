#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#
# Vellum production installer.
#
# Downloads the release's Compose stack, verifies it against the release
# SHA256SUMS, generates every secret, writes a 0600 .env, and starts the stack.
#
#   ./install.sh                                  # zero questions, latest release
#   ./install.sh --dir /srv/vellum --url https://vellum.example.com
#   ./install.sh --version v1.9.6
#   ./install.sh --dry-run                        # prepare the directory only
#   ./install.sh --from ./assets                  # local assets, no download
#
# Also works piped, which is the documented one-command install:
#   curl -fsSL .../install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --dir /srv/vellum
#
# ── Why this exists ───────────────────────────────────────────────────
#
# The documented install was eleven manual steps ending in "edit .env and replace
# every placeholder": seven placeholder values covering six distinct secrets,
# because the database password had to be typed identically into both
# POSTGRES_PASSWORD and DATABASE_URL. Getting that pair out of sync produces a
# stack that starts and then fails to authenticate against its own database — the
# failure lands at runtime, far from the typo.
#
# The installer generates all six, and the Compose file now derives DATABASE_URL
# from POSTGRES_*, so the password exists in exactly one place.
set -Eeuo pipefail

readonly REPO="metaneutrons/Vellum"
readonly DEFAULT_DIR="vellum"
readonly HEALTH_URL="http://127.0.0.1:3000/api/v1/health"
readonly HEALTH_TIMEOUT=180

version_tag="latest"
source_dir=""
target_dir=""
public_url=""
timezone=""
admin_user="admin"
assume_yes=0
dry_run=0
force=0

die() { printf '\nError: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }

usage() {
  sed -n '5,17p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) target_dir="${2:?--dir needs a path}"; shift 2 ;;
    --url) public_url="${2:?--url needs an https origin}"; shift 2 ;;
    --tz) timezone="${2:?--tz needs an IANA zone}"; shift 2 ;;
    --admin-user) admin_user="${2:?--admin-user needs a name}"; shift 2 ;;
    --version) version_tag="${2:?--version needs a tag}"; shift 2 ;;
    --from) source_dir="${2:?--from needs a directory}"; shift 2 ;;
    --yes|-y) assume_yes=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --force) force=1; shift ;;
    --help|-h) usage ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *) [ -n "$target_dir" ] && die "give the target directory once"; target_dir="$1"; shift ;;
  esac
done

# ── Preflight ─────────────────────────────────────────────────────────
# Every dependency is checked up front: discovering a missing openssl after the
# stack is half-configured leaves a directory nobody can finish installing.

step "Checking prerequisites"

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed$2"; }
need curl ""
need openssl ""
need awk ""
need docker " — see https://docs.docker.com/engine/install/"

if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  # Only v2+ is acceptable: the stack uses `depends_on: condition:`, healthcheck
  # `start_period`, and `security_opt`, none of which v1 honours correctly.
  case "$(docker-compose version --short 2>/dev/null)" in
    2.*|3.*|4.*|5.*|6.*|7.*|8.*|9.*) compose() { docker-compose "$@"; } ;;
    *) die "Docker Compose v2 or newer is required (found $(docker-compose version --short 2>/dev/null))" ;;
  esac
else
  die "Docker Compose v2 is required — install the 'docker compose' CLI plugin"
fi

docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable (is it running, and may this account use it?)"

if command -v sha256sum >/dev/null 2>&1; then
  verify_sums() { sha256sum --check SHA256SUMS; }
elif command -v shasum >/dev/null 2>&1; then
  verify_sums() { shasum --algorithm 256 --check SHA256SUMS; }
else
  die "neither sha256sum nor shasum is available — cannot verify the download"
fi

info "  docker, compose, curl, openssl, checksum tool: ok"

# ── Target directory ──────────────────────────────────────────────────

[ -n "$source_dir" ] && { source_dir="$(cd "$source_dir" 2>/dev/null && pwd)" || die "--from directory not found"; }

[ -n "$target_dir" ] || target_dir="$DEFAULT_DIR"
mkdir -p "$target_dir" || die "cannot create $target_dir"
cd "$target_dir"
install_dir="$PWD"

if [ -e .env ] && [ "$force" -eq 0 ]; then
  die "$install_dir/.env already exists.
This installer is for a first installation; it will not overwrite live secrets.
To upgrade an existing stack, use the updater (System → Vellum Server) or
docs/DOCKER_DEPLOYMENT.md. To start over deliberately, pass --force."
fi

# ── Download and verify ───────────────────────────────────────────────

if [ -n "$source_dir" ]; then
  # Air-gapped install from assets copied in by hand, and the path the repo's own
  # tests exercise. Still verified when the checksum file came along.
  step "Copying the deployment assets from $source_dir"
  [ "$source_dir" = "$install_dir" ] || for asset in docker-compose.yml vellum.env.example; do
    [ -f "$source_dir/$asset" ] || die "$source_dir/$asset is missing"
    cp "$source_dir/$asset" "$asset"
  done
  if [ -f "$source_dir/SHA256SUMS" ]; then
    [ "$source_dir" = "$install_dir" ] || cp "$source_dir/SHA256SUMS" SHA256SUMS
    # install.sh is listed in a release SHA256SUMS but is not copied here, so
    # check only what was actually staged.
    grep -E ' (docker-compose\.yml|vellum\.env\.example)$' SHA256SUMS > SHA256SUMS.staged || true
    mv SHA256SUMS.staged SHA256SUMS
    verify_sums >/dev/null || die "checksum verification FAILED — do not use these files"
    info "  checksums verified"
  else
    info "  no SHA256SUMS present — skipping verification (local assets)"
  fi
else
  if [ "$version_tag" = "latest" ]; then
    base_url="https://github.com/${REPO}/releases/latest/download"
  else
    base_url="https://github.com/${REPO}/releases/download/${version_tag}"
  fi

  step "Downloading the ${version_tag} deployment assets"
  for asset in docker-compose.yml vellum.env.example SHA256SUMS; do
    curl --fail --silent --show-error --location --output "$asset" "${base_url}/${asset}" \
      || die "could not download ${asset} from ${base_url}
Check the release tag and network access to github.com."
  done

  # The checksum file is the release's own manifest, so a truncated or substituted
  # Compose file is rejected before it can configure anything. install.sh is in the
  # manifest too but is not re-downloaded here — verify that one yourself before
  # running it.
  grep -vE ' install\.sh$' SHA256SUMS > SHA256SUMS.staged && mv SHA256SUMS.staged SHA256SUMS
  verify_sums >/dev/null || die "checksum verification FAILED — do not use these files"
  info "  docker-compose.yml, vellum.env.example: checksums verified"
fi

# ── Settings that need a human ────────────────────────────────────────

detect_timezone() {
  [ -n "${TZ:-}" ] && { printf '%s' "$TZ"; return; }
  if [ -f /etc/timezone ]; then
    tr -d '[:space:]' < /etc/timezone; return
  fi
  # macOS and most systemd hosts: /etc/localtime is a symlink into the zoneinfo db
  if [ -L /etc/localtime ]; then
    readlink /etc/localtime | sed 's|.*/zoneinfo/||'; return
  fi
  printf 'UTC'
}

# Prompts read the terminal directly, not stdin: under `curl … | bash` stdin is
# the script itself, so reading from it would consume the rest of the script.
# No terminal (CI, a detached run) simply means every default is taken.
if { exec 3</dev/tty; } 2>/dev/null; then
  tty_available=1
else
  tty_available=0
fi

ask() { # ask <prompt> <default> ; echoes the answer
  local prompt="$1" default="$2" answer=""
  if [ "$assume_yes" -eq 1 ] || [ "$tty_available" -eq 0 ]; then
    printf '%s' "$default"; return
  fi
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$prompt" "$default" >&2
  else
    printf '%s (Enter to skip): ' "$prompt" >&2
  fi
  IFS= read -r answer <&3 || true
  printf '%s' "${answer:-$default}"
}

step "Configuration"

# Nothing here is mandatory. An installer that stops to demand a public hostname
# cannot answer "let me look at it first", which is what most people want on the
# first run — and VELLUM_PUBLIC_URL is genuinely optional to the server: unset, it
# validates browser mutations against the request origin instead (see
# src/lib/request-origin.ts). It matters once Vellum is behind HTTPS or using
# Entra ID, and the summary says so.
if [ -z "$public_url" ]; then
  public_url="$(ask '  Public HTTPS URL, if you have one already' '')"
fi

if [ -n "$public_url" ]; then
  case "$public_url" in
    https://*) : ;;
    http://*) die "the public URL must be https:// — displays reject cleartext production servers" ;;
    *) die "the public URL must be a full https:// origin, for example https://vellum.example.com" ;;
  esac
  # An origin only: a path here silently breaks the fixed OIDC callback path.
  case "${public_url#https://}" in
    */*)
      url_host="${public_url#https://}"
      die "give the origin only, with no path — did you mean https://${url_host%%/*} ?"
      ;;
  esac
fi

[ -n "$timezone" ] || timezone="$(ask '  Timezone for the daily maintenance window' "$(detect_timezone)")"

# ── Secrets ───────────────────────────────────────────────────────────
# All URL-safe by construction: POSTGRES_PASSWORD is interpolated into a
# postgresql:// URL by the Compose file, where an unescaped @ or / would corrupt
# the connection string.

step "Generating secrets"
gen() { openssl rand -hex "$1"; }
encryption_key="$(gen 32)"
session_secret="$(gen 32)"
admin_api_key="$(gen 32)"
updater_token="$(gen 32)"
postgres_password="$(gen 24)"
admin_pass="$(gen 12)"
info "  4 × 32-byte keys, database password, owner password: generated"

# ── Write .env ────────────────────────────────────────────────────────
# Derived from the release template rather than written from scratch, so a
# variable added in a later release still reaches the installed .env with its
# documentation intact.

step "Writing .env"

# Values pass through the environment, not awk -v, which would interpret escapes.
VELLUM_PUBLIC_URL_V="$public_url" \
TZ_V="$timezone" \
ADMIN_USER_V="$admin_user" \
ADMIN_PASS_V="$admin_pass" \
ENCRYPTION_KEY_V="$encryption_key" \
SESSION_SECRET_V="$session_secret" \
ADMIN_API_KEY_V="$admin_api_key" \
UPDATER_TOKEN_V="$updater_token" \
POSTGRES_PASSWORD_V="$postgres_password" \
awk '
  function put(key, val) { print key "=" val; done_[key] = 1 }
  /^VELLUM_PUBLIC_URL=/ { put("VELLUM_PUBLIC_URL", ENVIRON["VELLUM_PUBLIC_URL_V"]); next }
  /^TZ=/                { put("TZ", ENVIRON["TZ_V"]); next }
  /^ADMIN_USER=/        { put("ADMIN_USER", ENVIRON["ADMIN_USER_V"]); next }
  /^ADMIN_PASS=/        { put("ADMIN_PASS", ENVIRON["ADMIN_PASS_V"]); next }
  /^ENCRYPTION_KEY=/    { put("ENCRYPTION_KEY", ENVIRON["ENCRYPTION_KEY_V"]); next }
  /^SESSION_SECRET=/    { put("SESSION_SECRET", ENVIRON["SESSION_SECRET_V"]); next }
  /^ADMIN_API_KEY=/     { put("ADMIN_API_KEY", ENVIRON["ADMIN_API_KEY_V"]); next }
  /^UPDATER_TOKEN=/     { put("UPDATER_TOKEN", ENVIRON["UPDATER_TOKEN_V"]); next }
  /^POSTGRES_PASSWORD=/ { put("POSTGRES_PASSWORD", ENVIRON["POSTGRES_PASSWORD_V"]); next }
  # Older templates carry an active DATABASE_URL that duplicates the password.
  # Comment it out: the Compose file derives it from POSTGRES_* now, and a stale
  # copy here would override the derived value and break authentication.
  /^DATABASE_URL=/ {
    print "# DATABASE_URL is derived from POSTGRES_* by docker-compose.yml."
    print "# Set it here only to use a database outside this stack."
    next
  }
  { print }
  END {
    # Fail loudly rather than installing a stack missing a required secret.
    n = split("VELLUM_PUBLIC_URL TZ ADMIN_USER ADMIN_PASS ENCRYPTION_KEY SESSION_SECRET ADMIN_API_KEY UPDATER_TOKEN POSTGRES_PASSWORD", req, " ")
    for (i = 1; i <= n; i++) {
      if (!(req[i] in done_)) {
        printf("installer: template has no %s= line\n", req[i]) > "/dev/stderr"
        bad = 1
      }
    }
    if (bad) exit 1
  }
' vellum.env.example > .env.tmp || { rm -f .env.tmp; die "could not fill in the environment template"; }

# Create with restrictive permissions before the secrets are visible to anyone:
# chmod after mv would leave a readable window.
chmod 600 .env.tmp
mv .env.tmp .env
rm -f SHA256SUMS vellum.env.example
info "  $install_dir/.env (0600)"

if [ "$dry_run" -eq 1 ]; then
  step "Dry run — stack not started"
  info "Review $install_dir/.env, then run:  cd $install_dir && docker compose up -d"
  printf '\n  Owner account: %s / %s\n' "$admin_user" "$admin_pass"
  exit 0
fi

# ── Start ─────────────────────────────────────────────────────────────

step "Pulling images"
compose pull --quiet || die "could not pull the release images"

step "Starting the stack"
compose up -d || die "the stack did not start — inspect: cd $install_dir && docker compose logs"

step "Waiting for the server to become healthy"
waited=0
until curl --fail --silent --show-error --output /dev/null "$HEALTH_URL" 2>/dev/null; do
  if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
    printf '\n'
    die "the server did not report healthy within ${HEALTH_TIMEOUT}s.
The stack is still running; inspect it with:
  cd $install_dir && docker compose logs --tail 50 server"
  fi
  sleep 3
  waited=$((waited + 3))
  printf '.'
done
printf '\n  healthy after %ss\n' "$waited"

printf '\n%s\n' "────────────────────────────────────────────────────────────────────────"
cat <<SUMMARY
 Vellum is running.

   Installed in   $install_dir
   Sign in at     http://127.0.0.1:3000/admin
   Owner account  $admin_user
   Password       $admin_pass

 The password is shown once here, and is also in $install_dir/.env.
SUMMARY

if [ -n "$public_url" ]; then
  cat <<SUMMARY

 Next: point an HTTPS reverse proxy at 127.0.0.1:3000 for
 $public_url — displays validate the certificate and
 reject cleartext servers. Then open $public_url/admin
 and add a booking provider.
SUMMARY
else
  cat <<'SUMMARY'

 The port is bound to loopback by design. On a remote host, reach it with:
   ssh -L 3000:127.0.0.1:3000 you@this-host

 Before displays can use this server it needs a public HTTPS name:
 put a reverse proxy in front of 127.0.0.1:3000, then set
 VELLUM_PUBLIC_URL in .env and run `docker compose up -d`. That value is
 also required for Microsoft Entra ID sign-in.
SUMMARY
fi

cat <<SUMMARY

 Also worth knowing:
   • Set TRUST_PROXY_HEADERS=false in .env if this host is exposed
     directly rather than behind a proxy.
   • Data lives in $install_dir/data. Back up data/backups/ — not
     data/postgres/ — while the stack is running.
   • Manage the stack from $install_dir with docker compose.
────────────────────────────────────────────────────────────────────────
SUMMARY
