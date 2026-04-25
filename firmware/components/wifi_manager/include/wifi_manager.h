/**
 * @file wifi_manager.h
 * @brief Wi-Fi station and SoftAP provisioning for Vellum.
 */

#pragma once

#include "esp_err.h"
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    WIFI_RESULT_CONNECTED,
    WIFI_RESULT_FAILED,
    WIFI_RESULT_NO_CREDENTIALS,
} wifi_result_t;

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
