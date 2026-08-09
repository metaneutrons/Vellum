// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file wifi_manager.h
 * @brief Wi-Fi station and SoftAP provisioning for Vellum.
 */

#pragma once

#include "esp_err.h"
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    WIFI_RESULT_CONNECTED,
    WIFI_RESULT_FAILED,
    WIFI_RESULT_NO_CREDENTIALS,
} wifi_result_t;

/** One nearby network from wifi_manager_scan(). */
typedef struct {
    char ssid[33];   /* NUL-terminated */
    int8_t rssi;     /* dBm */
    bool open;       /* true if the network is open (no auth) */
} wifi_ap_info_t;

/**
 * Initialize the shared Wi-Fi driver and network stack once. Safe to call
 * repeatedly; no radio mode is started until scan/connect/SoftAP needs it.
 */
void wifi_manager_init(void);

/**
 * Scan for nearby Wi-Fi networks (blocking). Fills up to @p max entries in
 * @p out and returns the number found (0 on error / if Wi-Fi isn't ready).
 */
int wifi_manager_scan(wifi_ap_info_t *out, int max);

/**
 * Attempt station-mode connection using NVS credentials.
 * Retries up to CONFIG_VELLUM_WIFI_MAX_RETRIES times.
 */
wifi_result_t wifi_manager_connect_station(void);

/**
 * Start SoftAP mode with captive portal for provisioning.
 * Blocks until credentials are submitted, then restarts the device.
 */
void wifi_manager_start_softap(void);

/** Get the SoftAP SSID ("Vellum-XXXX"). */
void wifi_manager_get_softap_ssid(char *buf, size_t buf_len);

/** Get the device MAC as "XX:XX:XX:XX:XX:XX". */
void wifi_manager_get_mac(char *buf, size_t buf_len);

/** Get current Wi-Fi RSSI (only valid when connected). */
int wifi_manager_get_rssi(void);

#ifdef __cplusplus
}
#endif
