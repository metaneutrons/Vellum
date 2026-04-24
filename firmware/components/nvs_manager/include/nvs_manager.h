/**
 * @file nvs_manager.h
 * @brief Encrypted NVS storage for Vellum device credentials and configuration.
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
#define NVS_MAX_KEY_LEN     45   /* 44 base64 chars + null (32 bytes X25519) */

#ifdef __cplusplus
extern "C" {
#endif

/** Initialize NVS flash. Must be called once at boot. */
esp_err_t nvs_manager_init(void);

/** Check if Wi-Fi credentials are stored. */
bool nvs_manager_has_wifi_credentials(void);

/** Check if a device token is stored. */
bool nvs_manager_has_device_token(void);

/** Read Wi-Fi SSID. Returns ESP_OK on success. */
esp_err_t nvs_manager_get_wifi_ssid(char *buf, size_t buf_len);

/** Read Wi-Fi password. Returns ESP_OK on success. */
esp_err_t nvs_manager_get_wifi_pass(char *buf, size_t buf_len);

/** Read device token. Returns ESP_OK on success. */
esp_err_t nvs_manager_get_token(char *buf, size_t buf_len);

/** Read server URL. Returns ESP_OK on success. */
esp_err_t nvs_manager_get_server_url(char *buf, size_t buf_len);

/** Store Wi-Fi credentials. */
esp_err_t nvs_manager_store_wifi(const char *ssid, const char *pass);

/** Store TOFU authentication token. */
esp_err_t nvs_manager_store_token(const char *token);

/** Store backend server URL. */
esp_err_t nvs_manager_store_server_url(const char *url);

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
