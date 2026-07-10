// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file ota_trust_keys.h
 * @brief Compile-time Ed25519 OTA-signing trust store.
 *
 * The set of public keys a device will accept OTA signatures from. It is baked
 * into the (Secure-Boot-signed, once the prod overlay is burned) application
 * image, so it cannot be rewritten in the field without a firmware update — it
 * is the anchor of the app-level OTA trust chain.
 *
 * A signature is accepted if it validates under ANY entry here whose id is not
 * listed in CONFIG_VELLUM_OTA_REVOKED_KEY_IDS. Carrying a primary key plus a
 * reserved "next" slot lets a signing key be rotated across firmware
 * generations WITHOUT a hard, fleet-wide cutover:
 *
 *   gen N   — ship the successor's pubkey in the "next" slot (trusted, not yet
 *             signing). Devices now trust {primary, next}.
 *   gen N+1 — start signing releases with the successor key. Devices on gen N
 *             still accept them because they already trust it.
 *   gen N+2 — promote the successor to primary, clear "next", and add the
 *             retired id to CONFIG_VELLUM_OTA_REVOKED_KEY_IDS.
 *
 * Always keep a populated spare so an emergency hotfix can be signed by a key
 * every fielded device already trusts. See the Secure Boot / KMS runbook.
 */
#pragma once

#include <stddef.h>
#include "sdkconfig.h"

/**
 * One trusted key: a stable id + the raw 32-byte Ed25519 public key, base64.
 * An entry whose pubkey_b64 is empty is an inert reserved slot (e.g. the
 * not-yet-staged "next" key before a rotation is armed) and is skipped.
 */
typedef struct {
    const char *key_id;
    const char *pubkey_b64;
} ota_trusted_key_t;

static const ota_trusted_key_t s_trusted_keys[] = {
    { CONFIG_VELLUM_OTA_SIGNING_KEY_ID,      CONFIG_VELLUM_OTA_SIGNING_PUBKEY      }, /* primary */
    { CONFIG_VELLUM_OTA_SIGNING_KEY_ID_NEXT, CONFIG_VELLUM_OTA_SIGNING_PUBKEY_NEXT }, /* next (empty until a rotation is staged) */
};
static const size_t s_trusted_keys_len =
    sizeof(s_trusted_keys) / sizeof(s_trusted_keys[0]);
