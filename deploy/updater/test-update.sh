#!/usr/bin/env bash
set -Eeuo pipefail

export UPDATE_ONCE=true
export COMPOSE_FILE="${BASH_SOURCE[0]}"
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

printf 'updater shell tests passed\n'
