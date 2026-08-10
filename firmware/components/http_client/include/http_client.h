// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file http_client.h
 * @brief HTTP client for Vellum backend communication.
 */

#pragma once

#include "esp_err.h"
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Telemetry data sent with every request. */
typedef struct {
    float       battery_voltage;
    int         battery_level;
    int         wifi_rssi;
    const char *firmware_ver;
} vellum_telemetry_t;

/** The safe, user-actionable category of a failed HTTP transport. Detailed
 * mbedTLS values remain available in the response for the USB serial log. */
typedef enum {
    VELLUM_HTTP_FAILURE_NONE = 0,
    VELLUM_HTTP_FAILURE_TRANSPORT,
    VELLUM_HTTP_FAILURE_TLS_CERTIFICATE,
    VELLUM_HTTP_FAILURE_TLS_HANDSHAKE,
} vellum_http_failure_t;

/** HTTP response from the backend. */
typedef struct {
    int       status_code;    /**< HTTP status (200, 400, 401, 5xx, or -1) */
    int       sleep_duration; /**< Parsed X-Sleep-Duration header (0 if absent) */
    char     *body;           /**< Text body (caller must free via http_client_free_response) */
    size_t    body_len;       /**< Length of text body */
    uint8_t  *binary_body;    /**< Binary body for render endpoint (caller must free) */
    size_t    binary_len;     /**< Length of binary body */
    vellum_http_failure_t failure; /**< Safe classification when the request fails */
    int       tls_error_code; /**< mbedTLS code for USB diagnostics; 0 if unavailable */
    int       tls_verify_flags; /**< mbedTLS certificate flags; 0 if unavailable */
} vellum_http_response_t;

/** Initialize the HTTP client module. Call once after Wi-Fi is connected. */
void http_client_init(const char *server_base_url, const char *mac);

/** Set the device token for authenticated requests. Pass NULL to clear. */
void http_client_set_token(const char *token);

/** Set the device's X25519 public key (base64) to include in /hello. */
void http_client_set_public_key(const char *public_key_base64);

/** Set telemetry data to include in request headers. */
void http_client_set_telemetry(const vellum_telemetry_t *telemetry);

/** POST /api/v1/ink/hello */
esp_err_t http_client_hello(vellum_http_response_t *resp);

/** GET /api/v1/ink/render */
esp_err_t http_client_render(vellum_http_response_t *resp);

/** POST /api/v1/ink/report */
esp_err_t http_client_report(const char *issue, vellum_http_response_t *resp);

/** POST /api/v1/ink/ota-report — fire-and-forget OTA outcome event. Any arg
 *  except `phase` may be NULL. */
esp_err_t http_client_ota_report(const char *model, const char *from_version,
                                 const char *to_version, const char *phase,
                                 const char *error_code);

/** GET /api/v1/ink/config */
esp_err_t http_client_config(vellum_http_response_t *resp);

/** Free any allocated memory in a response. */
void http_client_free_response(vellum_http_response_t *resp);

#ifdef __cplusplus
}
#endif
