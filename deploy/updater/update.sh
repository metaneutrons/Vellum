#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Fabian Schmieder. All rights reserved.

set -Eeuo pipefail

readonly RELEASE_API="${RELEASE_API:-https://api.github.com/repos/metaneutrons/Vellum/releases/latest}"
readonly IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-ghcr.io/metaneutrons/vellum}"
readonly COMPOSE_FILE="${COMPOSE_FILE:-/stack/docker-compose.yml}"
readonly VELLUM_ENV_FILE="${VELLUM_ENV_FILE:-/run/vellum/vellum.env}"
readonly ENV_BACKUP_FILE="${ENV_BACKUP_FILE:-/state/vellum.env.backup}"
readonly COMPOSE_PROJECT="${COMPOSE_PROJECT:-vellum}"
readonly COMPOSE_SERVICE="${COMPOSE_SERVICE:-server}"
readonly TARGET_CONTAINER="${TARGET_CONTAINER:-vellum}"
readonly DATABASE_CONTAINER="${DATABASE_CONTAINER:-vellum-postgres}"
readonly DATABASE_USER="${POSTGRES_USER:-vellum}"
readonly DATABASE_NAME="${POSTGRES_DB:-vellum}"
readonly BACKUP_DIR="${BACKUP_DIR:-/backups}"
readonly BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
readonly POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-900}"
readonly READINESS_URL="${READINESS_URL:-http://server:3000/api/v1/health}"
readonly READINESS_TIMEOUT_SECONDS="${READINESS_TIMEOUT_SECONDS:-120}"
readonly COSIGN_ISSUER="https://token.actions.githubusercontent.com"
readonly COSIGN_IDENTITY_REGEXP='^https://github\.com/metaneutrons/Vellum/\.github/workflows/docker\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$'
# The updater image is built by a DIFFERENT workflow than the server image, so it
# needs its own Sigstore identity — reusing the server regexp would reject every
# legitimate updater image (or, worse, accept the wrong provenance).
readonly UPDATER_IMAGE_REPOSITORY="${UPDATER_IMAGE_REPOSITORY:-ghcr.io/metaneutrons/vellum-updater}"
readonly COSIGN_UPDATER_IDENTITY_REGEXP='^https://github\.com/metaneutrons/Vellum/\.github/workflows/updater\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$'
readonly UPDATER_SERVICE="${UPDATER_SERVICE:-updater}"
# Opt-in: a container replacing itself is the one operation that can leave the
# stack with no updater at all. Default off until an operator has watched it once.
readonly AUTO_UPDATE_UPDATER="${AUTO_UPDATE_UPDATER:-false}"
readonly UPDATER_SWAP_TIMEOUT_SECONDS="${UPDATER_SWAP_TIMEOUT_SECONDS:-180}"
# The swap outcome outlives the container that performed it, so the NEW updater
# can report what happened to the admin UI.
readonly SWAP_RESULT_FILE="${SWAP_RESULT_FILE:-/state/updater-swap.json}"

log() {
  printf '%s vellum-updater: %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

die() {
  log "ERROR: $*"
  return 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

validate_config() {
  for command in curl jq docker cosign; do
    require_command "$command"
  done
  [[ -r "$COMPOSE_FILE" ]] || die "compose file is not readable: $COMPOSE_FILE"
  [[ -r "$VELLUM_ENV_FILE" ]] || die "environment file is not readable: $VELLUM_ENV_FILE"
  [[ -w "$VELLUM_ENV_FILE" ]] || die "environment file is not writable: $VELLUM_ENV_FILE"
  [[ "$POLL_INTERVAL_SECONDS" =~ ^[0-9]+$ ]] || die "POLL_INTERVAL_SECONDS must be numeric"
  (( POLL_INTERVAL_SECONDS >= 300 )) || die "POLL_INTERVAL_SECONDS must be at least 300"
  [[ "$READINESS_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || die "READINESS_TIMEOUT_SECONDS must be numeric"
  (( READINESS_TIMEOUT_SECONDS >= 30 )) || die "READINESS_TIMEOUT_SECONDS must be at least 30"
  [[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] || die "BACKUP_RETENTION_DAYS must be numeric"
}

github_curl() {
  local -a headers=(
    -H "Accept: application/vnd.github+json"
    -H "X-GitHub-Api-Version: 2022-11-28"
    -H "User-Agent: vellum-updater"
  )
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    headers+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  fi
  curl --fail --silent --show-error --location --max-time 30 "${headers[@]}" "$@"
}

latest_server_tag() {
  local release tag draft prerelease
  release="$(github_curl "$RELEASE_API")" || return 1
  tag="$(jq -er '.tag_name' <<<"$release")" || return 1
  draft="$(jq -r 'if .draft == false then "false" elif .draft == true then "true" else error("missing draft") end' <<<"$release")" || return 1
  prerelease="$(jq -r 'if .prerelease == false then "false" elif .prerelease == true then "true" else error("missing prerelease") end' <<<"$release")" || return 1

  if [[ "$draft" != "false" || "$prerelease" != "false" ]]; then
    die "GitHub latest points to a draft or prerelease"
    return 1
  fi
  if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    die "refusing non-server or malformed release tag: $tag"
    return 1
  fi
  printf '%s\n' "$tag"
}

current_version() {
  local image_id
  image_id="$(docker inspect --format '{{.Image}}' "$TARGET_CONTAINER" 2>/dev/null)" || return 1
  docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
    "$image_id" 2>/dev/null
}

version_is_newer() {
  local current="${1#v}" candidate="${2#v}"
  [[ "$current" != "$candidate" ]] || return 1
  [[ "$(printf '%s\n%s\n' "$current" "$candidate" | sort -V | tail -n1)" == "$candidate" ]]
}

verify_image() {
  local candidate="$1" repository="${2:-$IMAGE_REPOSITORY}" identity="${3:-$COSIGN_IDENTITY_REGEXP}" digest
  docker pull --quiet "$candidate" >/dev/null
  digest="$(docker image inspect --format '{{ json .RepoDigests }}' "$candidate" |
    jq -er --arg prefix "${repository}@sha256:" 'map(select(startswith($prefix))) | first')"
  [[ "$digest" == "${repository}@sha256:"* ]] ||
    die "pulled image has unexpected digest identity: $digest"

  log "verifying Sigstore identity for $digest"
  cosign verify \
    --certificate-oidc-issuer "$COSIGN_ISSUER" \
    --certificate-identity-regexp "$identity" \
    "$digest" >/dev/null
}

backup_database() {
  [[ "${BACKUP_ENABLED:-true}" == "true" ]] || return 0
  mkdir -p "$BACKUP_DIR"
  local destination temporary
  destination="${BACKUP_DIR}/vellum-pre-${1}-$(date -u +'%Y%m%dT%H%M%SZ').dump"
  temporary="${destination}.tmp"

  log "creating pre-update database backup"
  if ! docker exec "$DATABASE_CONTAINER" pg_dump \
      --username "$DATABASE_USER" --dbname "$DATABASE_NAME" --format custom >"$temporary"; then
    rm -f "$temporary"
    die "database backup failed; update aborted"
  fi
  [[ -s "$temporary" ]] || {
    rm -f "$temporary"
    die "database backup is empty; update aborted"
  }
  mv "$temporary" "$destination"
  find "$BACKUP_DIR" -type f -name 'vellum-pre-*.dump' \
    -mtime "+${BACKUP_RETENTION_DAYS}" -delete
  log "database backup stored at $destination"
}

compose_deploy() {
  local image="$1"
  VELLUM_IMAGE="$image" docker compose \
    --env-file "$VELLUM_ENV_FILE" \
    --project-name "$COMPOSE_PROJECT" \
    --file "$COMPOSE_FILE" \
    up --detach --no-deps --pull never --force-recreate "$COMPOSE_SERVICE"
}

# Rewrite exactly one KEY=image line, keeping a restorable copy first. Shared by
# the server pin and the updater pin so the careful backup/verify path is not
# duplicated — the updater pin is what stops a later `docker compose up` from
# silently reinstating the old updater.
persist_env_pin() {
  local key="$1" image="$2" count temporary backup_temporary
  count="$(grep -c "^${key}=" "$VELLUM_ENV_FILE" || true)"
  [[ "$count" == "1" ]] || {
    die "environment file must contain exactly one ${key} setting"
    return 1
  }

  mkdir -p "$(dirname "$ENV_BACKUP_FILE")"
  temporary="$(mktemp)"
  backup_temporary="${ENV_BACKUP_FILE}.tmp"
  awk -v key="$key" -v image="$image" '
    index($0, key "=") == 1 { print key "=" image; next }
    { print }
  ' "$VELLUM_ENV_FILE" >"$temporary"
  cp -p "$VELLUM_ENV_FILE" "$backup_temporary"
  mv -f "$backup_temporary" "$ENV_BACKUP_FILE"

  if ! cp "$temporary" "$VELLUM_ENV_FILE" ||
      ! grep -Fx "${key}=${image}" "$VELLUM_ENV_FILE" >/dev/null; then
    cp "$ENV_BACKUP_FILE" "$VELLUM_ENV_FILE" || true
    rm -f "$temporary"
    die "could not persist ${key}"
    return 1
  fi
  rm -f "$temporary"
  sync -f "$VELLUM_ENV_FILE" 2>/dev/null || true
  log "persisted image pin: ${key}=${image}"
}

persist_server_image() {
  persist_env_pin VELLUM_IMAGE "$1"
}

wait_for_readiness() {
  local deadline=$((SECONDS + READINESS_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    if curl --fail --silent --show-error --max-time 5 "$READINESS_URL" |
        jq -e '.status == "ok" and .database.connected == true' >/dev/null; then
      return 0
    fi
    sleep 3
  done
  return 1
}

deploy_with_rollback() {
  local candidate="$1" old_id rollback_ref
  old_id="$(docker inspect --format '{{.Image}}' "$TARGET_CONTAINER")"
  rollback_ref="${IMAGE_REPOSITORY}:rollback"
  docker image tag "$old_id" "$rollback_ref"

  log "deploying $candidate"
  if compose_deploy "$candidate" && wait_for_readiness; then
    if persist_server_image "$candidate"; then
      log "deployment healthy: $candidate"
      return 0
    fi
    log "deployment healthy but image pin persistence failed; rolling back"
  fi

  log "deployment failed; rolling back to $old_id"
  if ! compose_deploy "$rollback_ref" || ! wait_for_readiness; then
    die "automatic rollback failed; operator intervention required"
  fi
  die "deployment rolled back because the new release did not become ready"
}

# ── Updater self-update ───────────────────────────────────────────────
#
# The updater must never recreate its own container directly: `compose up` would
# kill the very process issuing the call, leaving the swap half-done with nothing
# left to finish or undo it. Instead the running (known-good) updater verifies the
# candidate, then hands the swap to a DETACHED one-shot container and exits. The
# one-shot is not a child process, so it survives its parent being replaced.
#
# It runs from the CURRENT image on purpose: if the new image were broken, a
# helper built from it could not roll anything back.

updater_container_id() {
  # Resolved through compose rather than a fixed name: deployments created before
  # `container_name` was added to the compose file run as <project>-updater-1.
  docker compose \
    --env-file "$VELLUM_ENV_FILE" \
    --project-name "$COMPOSE_PROJECT" \
    --file "$COMPOSE_FILE" \
    ps --quiet "$UPDATER_SERVICE" 2>/dev/null | head -n1
}

record_swap_result() {
  local outcome="$1" detail="$2"
  mkdir -p "$(dirname "$SWAP_RESULT_FILE")" 2>/dev/null || true
  jq -n --arg outcome "$outcome" --arg detail "$detail" \
        --arg at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
        '{outcome: $outcome, detail: $detail, at: $at}' \
    >"${SWAP_RESULT_FILE}.tmp" 2>/dev/null &&
    mv -f "${SWAP_RESULT_FILE}.tmp" "$SWAP_RESULT_FILE" 2>/dev/null || true
}

wait_for_container_health() {
  local container="$1" deadline=$((SECONDS + UPDATER_SWAP_TIMEOUT_SECONDS)) state health
  while (( SECONDS < deadline )); do
    state="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)"
    if [[ "$state" == "running" && ( "$health" == "healthy" || "$health" == "none" ) ]]; then
      return 0
    fi
    [[ "$state" == "exited" || "$state" == "dead" ]] && return 1
    sleep 3
  done
  return 1
}

compose_up_updater() {
  local image="$1"
  UPDATER_IMAGE="$image" docker compose \
    --env-file "$VELLUM_ENV_FILE" \
    --project-name "$COMPOSE_PROJECT" \
    --file "$COMPOSE_FILE" \
    up --detach --no-deps --pull never --force-recreate "$UPDATER_SERVICE"
}

# Runs INSIDE the one-shot helper. Owns the rollback: if the new updater does not
# come up healthy, nothing else is left that could undo the swap.
swap_updater() {
  local candidate="$1" previous_image previous_id new_id
  previous_id="$(updater_container_id)"
  previous_image="$(docker inspect --format '{{.Config.Image}}' "$previous_id" 2>/dev/null || true)"
  [[ -n "$previous_image" ]] || {
    record_swap_result failed "could not determine the running updater image"
    die "could not determine the running updater image"
    return 1
  }

  log "swapping updater: $previous_image -> $candidate"
  if compose_up_updater "$candidate"; then
    new_id="$(updater_container_id)"
    if [[ -n "$new_id" ]] && wait_for_container_health "$new_id"; then
      if persist_env_pin UPDATER_IMAGE "$candidate"; then
        log "updater swap healthy: $candidate"
        record_swap_result succeeded "$candidate"
        return 0
      fi
      log "updater came up healthy but the pin could not be persisted; rolling back"
    else
      log "replacement updater did not become healthy; rolling back"
    fi
  else
    log "could not start the replacement updater; rolling back"
  fi

  if compose_up_updater "$previous_image" && wait_for_container_health "$(updater_container_id)"; then
    record_swap_result "rolled-back" "restored $previous_image"
    die "updater swap rolled back to $previous_image"
    return 1
  fi
  record_swap_result failed "rollback to $previous_image failed; operator intervention required"
  die "updater rollback failed; operator intervention required"
  return 1
}

# Runs in the ORIGINAL updater, after a healthy server update.
schedule_updater_swap() {
  local tag="$1" candidate self_id self_image
  [[ "$AUTO_UPDATE_UPDATER" == "true" ]] || return 0

  candidate="${UPDATER_IMAGE_REPOSITORY}:${tag}"
  if [[ "${UPDATER_VERSION:-}" == "$tag" ]]; then
    return 0
  fi
  if [[ "${UPDATER_VERSION:-}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] &&
      ! version_is_newer "$UPDATER_VERSION" "$tag"; then
    return 0
  fi

  # Verify here, in the known-good container, so a helper is never launched for an
  # image that failed its signature check.
  if ! verify_image "$candidate" "$UPDATER_IMAGE_REPOSITORY" "$COSIGN_UPDATER_IDENTITY_REGEXP"; then
    log "updater image signature verification failed; keeping ${UPDATER_VERSION:-current}"
    record_swap_result failed "signature verification failed for $candidate"
    return 1
  fi

  self_id="$(updater_container_id)"
  self_image="$(docker inspect --format '{{.Config.Image}}' "$self_id" 2>/dev/null || true)"
  if [[ -z "$self_id" || -z "$self_image" ]]; then
    log "could not resolve this updater container; skipping self-update"
    return 1
  fi

  log "handing the updater swap to a detached helper (${UPDATER_VERSION:-unknown} -> $tag)"
  # --volumes-from inherits the socket and the stack mounts. Passing -v here would
  # be wrong: paths inside this container are not paths on the host.
  docker run --detach --rm \
    --volumes-from "$self_id" \
    --network none \
    --label vellum.role=updater-swap \
    --env "COMPOSE_PROJECT=$COMPOSE_PROJECT" \
    --env "COMPOSE_FILE=$COMPOSE_FILE" \
    --env "VELLUM_ENV_FILE=$VELLUM_ENV_FILE" \
    --env "UPDATER_SERVICE=$UPDATER_SERVICE" \
    --env "UPDATER_SWAP_TIMEOUT_SECONDS=$UPDATER_SWAP_TIMEOUT_SECONDS" \
    --env "SWAP_RESULT_FILE=$SWAP_RESULT_FILE" \
    --entrypoint /usr/local/bin/vellum-update \
    "$self_image" --swap-updater "$candidate" >/dev/null
}

update_once() {
  local tag candidate current
  if ! tag="$(latest_server_tag)"; then
    die "could not determine latest server release"
    return 1
  fi
  candidate="${IMAGE_REPOSITORY}:${tag}"
  current="$(current_version 2>/dev/null || true)"

  if [[ "$current" == "$tag" || "$current" == "${tag#v}" ]]; then
    log "already current: $tag"
    return 0
  fi
  if [[ "$current" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] && ! version_is_newer "$current" "$tag"; then
    log "refusing downgrade from $current to $tag"
    return 0
  fi

  log "new server release detected: ${current:-unknown} -> $tag"
  if ! verify_image "$candidate"; then
    die "image signature verification failed"
    return 1
  fi
  backup_database "$tag" || return 1
  deploy_with_rollback "$candidate" || return 1
  # Only after the server is verifiably healthy — never leave the stack mid-update
  # with a swapped updater on top.
  schedule_updater_swap "$tag" || log "updater self-update skipped"
}

main() {
  if [[ "${1:-}" == "--swap-updater" ]]; then
    require_command docker
    require_command jq
    [[ -n "${2:-}" ]] || die "--swap-updater needs an image reference"
    swap_updater "$2"
    return
  fi
  validate_config
  if [[ "${UPDATE_ONCE:-false}" == "true" ]]; then
    update_once
    return
  fi

  log "watching stable server releases every ${POLL_INTERVAL_SECONDS}s"
  while true; do
    update_once || log "cycle failed; keeping the current deployment"
    sleep "$POLL_INTERVAL_SECONDS" &
    wait $!
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
