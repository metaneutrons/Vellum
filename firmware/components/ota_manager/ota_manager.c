// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file ota_manager.c
 * @brief OTA update flow: /config → download → SHA-256 + Ed25519 verify → apply.
 */

#include "ota_manager.h"

#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_system.h"
#include "cJSON.h"
#include "esp_ota_ops.h"
#include "esp_https_ota.h"
#include "esp_crt_bundle.h"
#include "mbedtls/base64.h"
#include "mbedtls/pk.h"
#include "mbedtls/md.h"

#include "http_client.h"
#include "vellum_display.h"
#include "board.h"
#include "sdkconfig.h"

static const char *TAG = "ota";

/**
 * Verify an Ed25519 signature over a SHA256 hash.
 * Returns true if valid, false otherwise.
 */
static bool verify_ota_signature(const char *sha256_hex, const char *signature_b64)
{
    const char *pubkey_b64 = CONFIG_VELLUM_OTA_SIGNING_PUBKEY;
    if (!pubkey_b64 || strlen(pubkey_b64) == 0) {
        ESP_LOGW(TAG, "No OTA signing key configured — skipping signature check");
        return true; /* Allow unsigned in development */
    }

    /* Decode public key from base64 PEM */
    uint8_t pubkey_der[128];
    size_t pubkey_len = 0;
    mbedtls_base64_decode(pubkey_der, sizeof(pubkey_der), &pubkey_len,
                          (const unsigned char *)pubkey_b64, strlen(pubkey_b64));

    /* Decode signature from base64 */
    uint8_t sig[128];
    size_t sig_len = 0;
    mbedtls_base64_decode(sig, sizeof(sig), &sig_len,
                          (const unsigned char *)signature_b64, strlen(signature_b64));

    /* Parse SHA256 hex to bytes */
    uint8_t hash[32];
    for (int i = 0; i < 32; i++) {
        char hex[3] = { sha256_hex[i*2], sha256_hex[i*2+1], 0 };
        hash[i] = (uint8_t)strtol(hex, NULL, 16);
    }

    /* Verify with mbedtls */
    mbedtls_pk_context pk;
    mbedtls_pk_init(&pk);
    int ret = mbedtls_pk_parse_public_key(&pk, pubkey_der, pubkey_len);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to parse OTA public key: %d", ret);
        mbedtls_pk_free(&pk);
        return false;
    }

    ret = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, hash, 32, sig, sig_len);
    mbedtls_pk_free(&pk);

    if (ret != 0) {
        ESP_LOGE(TAG, "OTA signature verification FAILED: %d", ret);
        return false;
    }

    ESP_LOGI(TAG, "OTA signature verified ✓");
    return true;
}

void ota_manager_check_and_apply(void)
{
    ESP_LOGI(TAG, "Checking for OTA update via /config");
    vellum_http_response_t resp = {0};
    esp_err_t err = http_client_config(&resp);

    if (err != ESP_OK || resp.status_code != 200 || !resp.body) {
        http_client_free_response(&resp);
        return;
    }

    /* Parse config response for otaUrl */
    cJSON *root = cJSON_ParseWithLength(resp.body, resp.body_len);
    if (!root) { http_client_free_response(&resp); return; }

    cJSON *data = cJSON_GetObjectItemCaseSensitive(root, "data");
    cJSON *ota_url = data ? cJSON_GetObjectItemCaseSensitive(data, "otaUrl") : NULL;

    cJSON *ota_ver = data ? cJSON_GetObjectItemCaseSensitive(data, "otaVersion") : NULL;
    cJSON *ota_sha = data ? cJSON_GetObjectItemCaseSensitive(data, "otaSha256") : NULL;

    if (cJSON_IsString(ota_url) && ota_url->valuestring && strlen(ota_url->valuestring) > 0) {
        ESP_LOGI(TAG, "OTA update: %s → %s",
                 cJSON_IsString(ota_ver) ? ota_ver->valuestring : "?",
                 ota_url->valuestring);
        display_show_ota_progress(0);
        board_buzzer_beep(800, 200);

        esp_http_client_config_t ota_config = {
            .url = ota_url->valuestring,
            .timeout_ms = 120000,
            .crt_bundle_attach = esp_crt_bundle_attach,
        };

        esp_https_ota_config_t ota_params = {
            .http_config = &ota_config,
        };

        esp_err_t ota_err = esp_https_ota(&ota_params);
        if (ota_err == ESP_OK) {
            /* Verify SHA256 if provided */
            if (cJSON_IsString(ota_sha) && ota_sha->valuestring) {
                const esp_partition_t *running = esp_ota_get_running_partition();
                const esp_partition_t *update = esp_ota_get_next_update_partition(running);
                if (update) {
                    uint8_t sha[32];
                    esp_partition_get_sha256(update, sha);
                    char sha_hex[65];
                    for (int i = 0; i < 32; i++) sprintf(sha_hex + i*2, "%02x", sha[i]);
                    sha_hex[64] = 0;

                    if (strcmp(sha_hex, ota_sha->valuestring) != 0) {
                        ESP_LOGE(TAG, "SHA256 mismatch! Expected: %s Got: %s",
                                 ota_sha->valuestring, sha_hex);
                        board_buzzer_beep(300, 500);
                        /* Rollback: don't set boot partition */
                        cJSON_Delete(root);
                        http_client_free_response(&resp);
                        return;
                    }
                    ESP_LOGI(TAG, "SHA256 verified ✓");

                    /* Verify Ed25519 signature */
                    cJSON *ota_sig = data ? cJSON_GetObjectItemCaseSensitive(data, "otaSignature") : NULL;
                    if (cJSON_IsString(ota_sig) && ota_sig->valuestring && strlen(ota_sig->valuestring) > 0) {
                        if (!verify_ota_signature(sha_hex, ota_sig->valuestring)) {
                            ESP_LOGE(TAG, "Signature verification FAILED — aborting OTA");
                            board_buzzer_beep(300, 500);
                            cJSON_Delete(root);
                            http_client_free_response(&resp);
                            return;
                        }
                    }
                }
            }

            ESP_LOGI(TAG, "OTA success — restarting");
            board_buzzer_beep(2000, 100); vTaskDelay(pdMS_TO_TICKS(100)); board_buzzer_beep(2000, 100);
            cJSON_Delete(root);
            http_client_free_response(&resp);
            esp_restart();
        } else {
            ESP_LOGW(TAG, "OTA failed: %s", esp_err_to_name(ota_err));
            board_buzzer_beep(300, 500);
        }
    }

    cJSON_Delete(root);
    http_client_free_response(&resp);
}
