// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file wifi_failure.h
 * @brief Stable, user-facing classification of ESP-IDF Wi-Fi disconnect causes.
 *
 * ESP-IDF exposes numeric disconnect reasons. Keep the mapping free of ESP-IDF
 * headers so it can be host-tested and so display copy never leaks low-level
 * codes or network credentials to a public-facing screen.
 */
#pragma once

#include <stdint.h>

typedef enum {
    WIFI_FAILURE_UNKNOWN = 0,
    WIFI_FAILURE_NETWORK_NOT_FOUND,
    WIFI_FAILURE_PASSWORD_REJECTED,
    WIFI_FAILURE_SIGNAL_LOST,
    WIFI_FAILURE_NETWORK_BUSY,
    WIFI_FAILURE_SECURITY_MISMATCH,
    WIFI_FAILURE_TIMED_OUT,
} wifi_failure_kind_t;

wifi_failure_kind_t wifi_failure_from_disconnect_reason(uint8_t reason);
const char *wifi_failure_message(wifi_failure_kind_t failure);

