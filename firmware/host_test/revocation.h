// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file revocation.h
 * @brief Host-testable mirror of the OTA key-revocation CSV membership test.
 *
 * MIRROR OF firmware/components/ota_manager/ota_manager.c csv_contains_token(),
 * which backs key_is_revoked(CONFIG_VELLUM_OTA_REVOKED_KEY_IDS, key_id). A bug
 * here is security-critical in both directions: a false positive would reject a
 * still-trusted signing key (bricking OTA), and a false negative (e.g. a
 * substring match of "key1" against "key10") would keep accepting a REVOKED
 * key. Keep this in lockstep with ota_manager.c — test_key_revocation.c pins the
 * membership contract.
 */
#pragma once

#include <stdbool.h>

/**
 * True iff @p id appears as a whole, comma-separated token in @p csv.
 * Separators are ',' with optional surrounding spaces; matching is
 * exact-length (never a prefix/substring). Empty csv or id → false.
 */
bool rev_csv_contains_token(const char *csv, const char *id);
