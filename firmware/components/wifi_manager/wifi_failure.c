// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "wifi_failure.h"

/* Values are the stable IEEE/ESP-IDF values from wifi_err_reason_t. Keeping
 * them here rather than importing ESP-IDF makes this safety-critical display
 * logic independently host-testable. */
enum {
    WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT_VALUE = 15,
    WIFI_REASON_8021X_AUTH_FAILED_VALUE = 23,
    WIFI_REASON_TIMEOUT_VALUE = 39,
    WIFI_REASON_BEACON_TIMEOUT_VALUE = 200,
    WIFI_REASON_NO_AP_FOUND_VALUE = 201,
    WIFI_REASON_AUTH_FAIL_VALUE = 202,
    WIFI_REASON_ASSOC_FAIL_VALUE = 203,
    WIFI_REASON_HANDSHAKE_TIMEOUT_VALUE = 204,
    WIFI_REASON_CONNECTION_FAIL_VALUE = 205,
    WIFI_REASON_NO_AP_COMPATIBLE_SECURITY_VALUE = 210,
    WIFI_REASON_NO_AP_AUTHMODE_THRESHOLD_VALUE = 211,
    WIFI_REASON_NO_AP_RSSI_THRESHOLD_VALUE = 212,
    WIFI_REASON_ASSOC_TOOMANY_VALUE = 5,
    WIFI_REASON_CIPHER_SUITE_REJECTED_VALUE = 24,
    WIFI_REASON_BAD_CIPHER_OR_AKM_VALUE = 29,
};

wifi_failure_kind_t wifi_failure_from_disconnect_reason(uint8_t reason)
{
    switch (reason) {
    case WIFI_REASON_NO_AP_FOUND_VALUE:
    case WIFI_REASON_NO_AP_RSSI_THRESHOLD_VALUE:
        return WIFI_FAILURE_NETWORK_NOT_FOUND;
    case WIFI_REASON_AUTH_FAIL_VALUE:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT_VALUE:
    case WIFI_REASON_HANDSHAKE_TIMEOUT_VALUE:
    case WIFI_REASON_8021X_AUTH_FAILED_VALUE:
        return WIFI_FAILURE_PASSWORD_REJECTED;
    case WIFI_REASON_BEACON_TIMEOUT_VALUE:
        return WIFI_FAILURE_SIGNAL_LOST;
    case WIFI_REASON_ASSOC_TOOMANY_VALUE:
        return WIFI_FAILURE_NETWORK_BUSY;
    case WIFI_REASON_NO_AP_COMPATIBLE_SECURITY_VALUE:
    case WIFI_REASON_NO_AP_AUTHMODE_THRESHOLD_VALUE:
    case WIFI_REASON_CIPHER_SUITE_REJECTED_VALUE:
    case WIFI_REASON_BAD_CIPHER_OR_AKM_VALUE:
        return WIFI_FAILURE_SECURITY_MISMATCH;
    case WIFI_REASON_TIMEOUT_VALUE:
    case WIFI_REASON_ASSOC_FAIL_VALUE:
    case WIFI_REASON_CONNECTION_FAIL_VALUE:
        return WIFI_FAILURE_TIMED_OUT;
    default:
        return WIFI_FAILURE_UNKNOWN;
    }
}

const char *wifi_failure_message(wifi_failure_kind_t failure)
{
    switch (failure) {
    case WIFI_FAILURE_NETWORK_NOT_FOUND: return "Saved network not found";
    case WIFI_FAILURE_PASSWORD_REJECTED: return "Wi-Fi password was rejected";
    case WIFI_FAILURE_SIGNAL_LOST: return "Wi-Fi signal was lost";
    case WIFI_FAILURE_NETWORK_BUSY: return "Wi-Fi network is busy";
    case WIFI_FAILURE_SECURITY_MISMATCH: return "Wi-Fi security is incompatible";
    case WIFI_FAILURE_TIMED_OUT: return "Wi-Fi connection timed out";
    case WIFI_FAILURE_UNKNOWN:
    default: return "Could not join saved Wi-Fi";
    }
}
