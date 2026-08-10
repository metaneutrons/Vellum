#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Fabian Schmieder. All rights reserved.

set -Eeuo pipefail

readonly RELEASE_API="${RELEASE_API:-https://api.github.com/repos/metaneutrons/Vellum/releases/latest}"
readonly IMAGE_REPOSITORY="${IMAGE_REPOSITORY:-ghcr.io/metaneutrons/vellum}"
readonly COMPOSE_FILE="${COMPOSE_FILE:-/stack/docker-compose.yml}"
readonly VELLUM_ENV_FILE="${VELLUM_ENV_FILE:-/run/vellum/vellum.env}"
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
  local candidate="$1" digest
  docker pull --quiet "$candidate" >/dev/null
  digest="$(docker image inspect --format '{{ json .RepoDigests }}' "$candidate" |
    jq -er --arg prefix "${IMAGE_REPOSITORY}@sha256:" 'map(select(startswith($prefix))) | first')"
  [[ "$digest" == "${IMAGE_REPOSITORY}@sha256:"* ]] ||
    die "pulled image has unexpected digest identity: $digest"

  log "verifying Sigstore identity for $digest"
  cosign verify \
    --certificate-oidc-issuer "$COSIGN_ISSUER" \
    --certificate-identity-regexp "$COSIGN_IDENTITY_REGEXP" \
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
    log "deployment healthy: $candidate"
    return 0
  fi

  log "deployment failed readiness; rolling back to $old_id"
  if ! compose_deploy "$rollback_ref" || ! wait_for_readiness; then
    die "automatic rollback failed; operator intervention required"
  fi
  die "deployment rolled back because the new release did not become ready"
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
  deploy_with_rollback "$candidate"
}

main() {
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
