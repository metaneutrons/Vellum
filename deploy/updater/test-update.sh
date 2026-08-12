#!/usr/bin/env bash
set -Eeuo pipefail

export UPDATE_ONCE=true
export COMPOSE_FILE="${BASH_SOURCE[0]}"
test_directory="$(mktemp -d)"
trap 'rm -rf "$test_directory"' EXIT
export VELLUM_ENV_FILE="${test_directory}/.env"
export ENV_BACKUP_FILE="${test_directory}/state/vellum.env.backup"
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
