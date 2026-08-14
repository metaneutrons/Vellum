#!/usr/bin/env bash
set -Eeuo pipefail

export UPDATE_ONCE=true
export AUTO_UPDATE_UPDATER=false
export COMPOSE_FILE="${BASH_SOURCE[0]}"
test_directory="$(mktemp -d)"
trap 'rm -rf "$test_directory"' EXIT
export VELLUM_ENV_FILE="${test_directory}/.env"
export ENV_BACKUP_FILE="${test_directory}/state/vellum.env.backup"
export PROGRESS_FILE="${test_directory}/state/progress.json"
printf '%s\n' \
  'VELLUM_IMAGE=ghcr.io/metaneutrons/vellum:v1.8.1' \
  'UPDATER_IMAGE=ghcr.io/metaneutrons/vellum-updater:v1.8.1' \
  'SOME_SETTING=preserved' >"$VELLUM_ENV_FILE"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/update.sh"

assert() { "$@" || { printf 'FAILED: %q ' "$@" >&2; printf '\n' >&2; exit 1; }; }

assert version_is_newer v1.8.1 v1.8.2
assert version_is_newer 1.8.9 v1.9.0
assert version_is_newer v1.9.9 v2.0.0
if version_is_newer v1.8.2 v1.8.2; then exit 1; fi
if version_is_newer v2.0.0 v1.9.9; then exit 1; fi

# Invoked indirectly by latest_server_tag; ShellCheck versions use either code.
# shellcheck disable=SC2317,SC2329
github_curl() { printf '%s' '{"tag_name":"v1.8.2","draft":false,"prerelease":false}'; }
assert test "$(latest_server_tag)" = "v1.8.2"

# shellcheck disable=SC2317,SC2329
github_curl() { printf '%s' '{"tag_name":"firmware-v1.3.2","draft":false,"prerelease":false}'; }
if latest_server_tag; then exit 1; fi

persist_server_image 'ghcr.io/metaneutrons/vellum:v1.8.2'
assert grep -Fx 'VELLUM_IMAGE=ghcr.io/metaneutrons/vellum:v1.8.2' "$VELLUM_ENV_FILE"
assert grep -Fx 'UPDATER_IMAGE=ghcr.io/metaneutrons/vellum-updater:v1.8.1' "$VELLUM_ENV_FILE"
assert grep -Fx 'SOME_SETTING=preserved' "$VELLUM_ENV_FILE"
assert grep -Fx 'VELLUM_IMAGE=ghcr.io/metaneutrons/vellum:v1.8.1' "$ENV_BACKUP_FILE"

printf 'updater shell tests passed\n'

# ── Updater self-update ───────────────────────────────────────────────
# The pin rewrite must be surgical: one key, others untouched.
assert persist_env_pin UPDATER_IMAGE 'ghcr.io/metaneutrons/vellum-updater:v1.8.2'
assert grep -Fqx 'UPDATER_IMAGE=ghcr.io/metaneutrons/vellum-updater:v1.8.2' "$VELLUM_ENV_FILE"
assert grep -Fqx 'VELLUM_IMAGE=ghcr.io/metaneutrons/vellum:v1.8.2' "$VELLUM_ENV_FILE"
assert grep -Fqx 'SOME_SETTING=preserved' "$VELLUM_ENV_FILE"

# Explicitly disabled policy: a server update must not swap the updater.
assert test "$AUTO_UPDATE_UPDATER" = "false"
assert schedule_updater_swap v1.9.0

# The enabled path needs its own process because the flag is readonly once sourced.
update_sh="$(dirname "${BASH_SOURCE[0]}")/update.sh"

swap_probe() {
  # `env` rather than a command prefix: the flag is readonly in this shell once
  # update.sh has been sourced, and bash rejects even a prefix assignment.
  # The single-quoted body is deliberate — those variables must expand in the
  # INNER shell, from the environment set here.
  # shellcheck disable=SC2016
  env AUTO_UPDATE_UPDATER=true UPDATER_VERSION="$1" UPDATE_ONCE=true \
    COMPOSE_FILE="$COMPOSE_FILE" VELLUM_ENV_FILE="$VELLUM_ENV_FILE" \
    ENV_BACKUP_FILE="$ENV_BACKUP_FILE" SWAP_RESULT_FILE="${test_directory}/state/swap.json" \
    PROBE_LOG="$PROBE_LOG" UPDATE_SH="$update_sh" \
    bash -c '
    source "$UPDATE_SH"
    verify_image() { return 0; }
    updater_container_id() { printf "self-id"; }
    docker() {
      case "$1" in
        inspect) printf "ghcr.io/metaneutrons/vellum-updater:%s\n" "${UPDATER_VERSION#v}" ;;
        run) printf "%s\n" "$*" >>"$PROBE_LOG" ;;
      esac
    }
    schedule_updater_swap "$1" || true
  ' _ "$2"
}

export PROBE_LOG="${test_directory}/probe.log"
: >"$PROBE_LOG"

# Behind the release -> hand off to a detached helper for the right candidate.
swap_probe v1.8.1 v1.8.2
assert grep -q -- '--swap-updater ghcr.io/metaneutrons/vellum-updater:v1.8.2' "$PROBE_LOG"
# Must inherit the mounts rather than pass container paths as host paths.
assert grep -q -- '--volumes-from self-id' "$PROBE_LOG"
# Must not reach the network while swapping.
assert grep -q -- '--network none' "$PROBE_LOG"

# Already current, and newer than the release: never launch a helper.
: >"$PROBE_LOG"
swap_probe v1.8.2 v1.8.2
swap_probe v1.9.9 v1.8.2
if [[ -s "$PROBE_LOG" ]]; then
  printf 'FAILED: helper launched despite an up-to-date updater\n' >&2
  exit 1
fi

printf 'updater self-update assertions passed\n'

# ── Phase journal ─────────────────────────────────────────────────────
# The server cannot narrate its own restart, so the journal is the only progress
# the UI can show. Pin its shape.
export PHASE_STARTED_AT="2026-08-13T00:00:00Z"
set_phase "deploying" "ghcr.io/metaneutrons/vellum:v1.8.2"
assert test -f "$PROGRESS_FILE"
assert jq -e '.phase == "deploying"' "$PROGRESS_FILE" >/dev/null
assert jq -e '.detail == "ghcr.io/metaneutrons/vellum:v1.8.2"' "$PROGRESS_FILE" >/dev/null
# startedAt must survive across phases so the UI can show elapsed time.
assert jq -e '.startedAt == "2026-08-13T00:00:00Z"' "$PROGRESS_FILE" >/dev/null
set_phase "done"
assert jq -e '.phase == "done" and .detail == null' "$PROGRESS_FILE" >/dev/null
assert jq -e '.startedAt == "2026-08-13T00:00:00Z"' "$PROGRESS_FILE" >/dev/null

# A journal write must never abort an update, even if the path is unwritable.
# Subshell because PROGRESS_FILE is readonly once update.sh has been sourced.
# shellcheck disable=SC2016
if ! env PROGRESS_FILE=/proc/nonexistent/progress.json UPDATE_SH="$update_sh" \
     bash -c 'source "$UPDATE_SH"; set_phase "verifying"' >/dev/null 2>&1; then
  printf 'FAILED: set_phase must stay advisory when the journal is unwritable\n' >&2
  exit 1
fi

printf 'phase journal assertions passed\n'
