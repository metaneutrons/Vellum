// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file nvs_manager.h
 * @brief NVS storage for Vellum device credentials and configuration.
 *
 * At-rest confidentiality of these values (WiFi PSK, device token, X25519
 * private key) depends on NVS encryption, which is rooted in an eFuse key and
 * is therefore activated by the production hardening profile — see SECURITY.md.
 * Development builds do NOT encrypt NVS.
 */

#pragma once

#include "esp_err.h"
#include <stddef.h>
#include <stdbool.h>

#define NVS_NAMESPACE       "vellum"
#define NVS_MAX_SSID_LEN    33   /* 32 chars + null */
#define NVS_MAX_PASS_LEN    65   /* 64 chars + null */
#define NVS_MAX_TOKEN_LEN   65   /* 64 hex chars + null */
#define NVS_MAX_URL_LEN     256
#define NVS_MAX_NTP_SERVER_LEN 256 /* DNS name or IP literal + null */
#define NVS_MAX_KEY_LEN     45   /* 44 base64 chars + null (32 bytes X25519) */
#define NVS_REMOTE_COMMAND_ID_LEN 37 /* UUID + null */

typedef enum {
    NVS_INTEGRITY_DISABLED = 0,
    NVS_INTEGRITY_VALID,
    NVS_INTEGRITY_INVALID,
} nvs_integrity_status_t;

#ifdef __cplusplus
extern "C" {
#endif

/** Initialize NVS flash. Must be called once at boot. */
esp_err_t nvs_manager_init(void);

/** Runtime status of the reversible HMAC seal over sensitive configuration. */
nvs_integrity_status_t nvs_manager_integrity_status(void);
const char *nvs_manager_integrity_status_name(void);

/** Check if Wi-Fi credentials are stored. */
bool nvs_manager_has_wifi_credentials(void);

/** Check if a device token is stored. */
bool nvs_manager_has_device_token(void);

/**
 * Whether this NVS lifecycle has ever enrolled. The lock survives token
 * rotation and is cleared only by a full physical factory reset.
 */
bool nvs_manager_is_provisioning_locked(void);

/** Read Wi-Fi SSID. Returns ESP_OK on success. */
esp_err_t nvs_manager_get_wifi_ssid(char *buf, size_t buf_len);

/** Read Wi-Fi password. Returns ESP_OK on success. */
esp_err_t nvs_manager_get_wifi_pass(char *buf, size_t buf_len);

/** Read device token. Returns ESP_OK on success. */
esp_err_t nvs_manager_get_token(char *buf, size_t buf_len);

/** Read server URL. Returns ESP_OK on success. */
esp_err_t nvs_manager_get_server_url(char *buf, size_t buf_len);

/** How the panel is mounted: "portrait" or "landscape". ESP_ERR_NVS_NOT_FOUND
 *  when the operator has never chosen, which means the panel's native mounting. */
esp_err_t nvs_manager_get_orientation(char *buf, size_t buf_len);
esp_err_t nvs_manager_set_orientation(const char *orientation);

/** Read the optional administrator-provisioned NTP server. */
esp_err_t nvs_manager_get_ntp_server(char *buf, size_t buf_len);

/** Store Wi-Fi credentials. */
esp_err_t nvs_manager_store_wifi(const char *ssid, const char *pass);

/** Store TOFU authentication token. */
esp_err_t nvs_manager_store_token(const char *token);

/** Store backend server URL. */
esp_err_t nvs_manager_store_server_url(const char *url);

/** Last successfully applied remote-configuration command UUID. */
esp_err_t nvs_manager_get_remote_command_id(char *buf, size_t buf_len);

/** Atomically store a validated server migration and its idempotency marker. */
esp_err_t nvs_manager_apply_remote_server_url(const char *url, const char *command_id);

/** Atomically stage new Wi-Fi credentials while retaining a rollback profile. */
esp_err_t nvs_manager_stage_remote_wifi(const char *ssid, const char *pass,
                                        const char *command_id);

/** Commit a staged Wi-Fi change and its idempotency marker. */
esp_err_t nvs_manager_finalize_remote_wifi(const char *command_id);

/** Restore the previous Wi-Fi profile and persist a deferred failure report. */
esp_err_t nvs_manager_rollback_remote_wifi(const char *error_code);

/** Read/clear a configuration outcome that must be reported after reconnect. */
esp_err_t nvs_manager_get_deferred_config_report(char *command_id, size_t command_id_len,
                                                 char *error_code, size_t error_code_len);
esp_err_t nvs_manager_clear_deferred_config_report(void);

/** Store or clear the administrator-provisioned NTP server. */
esp_err_t nvs_manager_store_ntp_server(const char *server);

/** Read X25519 private key (base64). */
esp_err_t nvs_manager_get_private_key(char *buf, size_t buf_len);

/** Read X25519 public key (base64). */
esp_err_t nvs_manager_get_public_key(char *buf, size_t buf_len);

/** Store X25519 keypair (both base64). */
esp_err_t nvs_manager_store_keypair(const char *private_key, const char *public_key);

/** Check if X25519 keypair exists. */
bool nvs_manager_has_keypair(void);

/** Erase all Vellum keys (factory reset). */
esp_err_t nvs_manager_clear_all(void);

#ifdef __cplusplus
}
#endif

/* Generic key-value store */
esp_err_t nvs_manager_set_str(const char *key, const char *value);
esp_err_t nvs_manager_get_str(const char *key, char *buf, size_t buf_len);
