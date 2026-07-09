// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file ota_manager.c
 * @brief OTA update flow: /config → download → verify → apply.
 *
 * Trust chain (all BEFORE the image is made bootable):
 *   1. Download into the inactive OTA slot via esp_https_ota_begin/perform.
 *   2. SHA-256 the staged partition; require it to equal the server's otaSha256.
 *   3. Ed25519-verify the server's signature over that 32-byte digest
 *      (PSA_ALG_PURE_EDDSA). Fail-closed: in production a missing/invalid
 *      signature aborts the update.
 *   4. Only then esp_https_ota_finish() sets the boot partition.
 *
 * With bootloader rollback enabled, the new image boots PENDING_VERIFY and is
 * confirmed by ota_manager_mark_valid() after a good server round-trip; an
 * image that fails to do so is rolled back by the bootloader on next boot.
 *
 * The signing contract: the server signs the raw 32-byte SHA-256 digest of the
 * firmware image with Ed25519; CONFIG_VELLUM_OTA_SIGNING_PUBKEY is the base64
 * of the 32-byte raw public key; otaSignature is base64 of the 64-byte sig.
 */

#include "ota_manager.h"

#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_app_desc.h"
#include "cJSON.h"
#include "esp_ota_ops.h"
#include "esp_https_ota.h"
#include "esp_crt_bundle.h"
#include "mbedtls/base64.h"
#include "psa/crypto.h"

#include "http_client.h"
#include "vellum_display.h"
#include "board.h"
#include "sdkconfig.h"

static const char *TAG = "ota";

#if defined(CONFIG_VELLUM_OTA_REQUIRE_SIGNATURE)
  #define OTA_REQUIRE_SIGNATURE 1
#else
  #define OTA_REQUIRE_SIGNATURE 0
#endif

/**
 * Verify an Ed25519 signature over the 32-byte SHA-256 digest of the image.
 * @param digest   32-byte SHA-256 of the staged firmware.
 * @param sig_b64  base64 of the 64-byte Ed25519 signature.
 * @return true if a valid signature was verified; false otherwise.
 *         When no signing key is configured, returns !OTA_REQUIRE_SIGNATURE
 *         (allow unsigned only in development).
 */
static bool verify_ota_signature(const uint8_t digest[32], const char *sig_b64)
{
    const char *pubkey_b64 = CONFIG_VELLUM_OTA_SIGNING_PUBKEY;
    if (!pubkey_b64 || strlen(pubkey_b64) == 0) {
        ESP_LOGW(TAG, "No OTA signing key configured");
        return !OTA_REQUIRE_SIGNATURE;
    }
    if (!sig_b64 || strlen(sig_b64) == 0) {
        ESP_LOGE(TAG, "OTA signature missing");
        return false;
    }

    uint8_t pubkey[32];
    size_t pubkey_len = 0;
    if (mbedtls_base64_decode(pubkey, sizeof(pubkey), &pubkey_len,
                              (const unsigned char *)pubkey_b64, strlen(pubkey_b64)) != 0 ||
        pubkey_len != 32) {
        ESP_LOGE(TAG, "Bad OTA public key (need raw 32-byte Ed25519, base64)");
        return false;
    }

    uint8_t sig[64];
    size_t sig_len = 0;
    if (mbedtls_base64_decode(sig, sizeof(sig), &sig_len,
                              (const unsigned char *)sig_b64, strlen(sig_b64)) != 0 ||
        sig_len != 64) {
        ESP_LOGE(TAG, "Bad OTA signature length");
        return false;
    }

    if (psa_crypto_init() != PSA_SUCCESS) {
        ESP_LOGE(TAG, "psa_crypto_init failed");
        return false;
    }

    psa_key_attributes_t attr = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_usage_flags(&attr, PSA_KEY_USAGE_VERIFY_MESSAGE);
    psa_set_key_algorithm(&attr, PSA_ALG_PURE_EDDSA);
    psa_set_key_type(&attr, PSA_KEY_TYPE_ECC_PUBLIC_KEY(PSA_ECC_FAMILY_TWISTED_EDWARDS));
    psa_set_key_bits(&attr, 255);

    psa_key_id_t key;
    if (psa_import_key(&attr, pubkey, pubkey_len, &key) != PSA_SUCCESS) {
        ESP_LOGE(TAG, "psa_import_key (Ed25519) failed");
        return false;
    }

    psa_status_t st = psa_verify_message(key, PSA_ALG_PURE_EDDSA, digest, 32, sig, sig_len);
    psa_destroy_key(key);

    if (st != PSA_SUCCESS) {
        ESP_LOGE(TAG, "OTA signature verification FAILED: %d", (int)st);
        return false;
    }
    ESP_LOGI(TAG, "OTA signature verified ✓");
    return true;
}

/** True if the offered version differs from the running one (avoid reflash loop). */
static bool version_is_new(const char *offered)
{
    if (!offered || strlen(offered) == 0) return false;
    const esp_app_desc_t *app = esp_app_get_description();
    if (app && strncmp(app->version, offered, sizeof(app->version)) == 0) {
        ESP_LOGI(TAG, "OTA offered version %s == running — skipping", offered);
        return false;
    }
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

    cJSON *root = cJSON_ParseWithLength(resp.body, resp.body_len);
    if (!root) { http_client_free_response(&resp); return; }

    cJSON *data = cJSON_GetObjectItemCaseSensitive(root, "data");
    cJSON *ota_url = data ? cJSON_GetObjectItemCaseSensitive(data, "otaUrl") : NULL;
    cJSON *ota_ver = data ? cJSON_GetObjectItemCaseSensitive(data, "otaVersion") : NULL;
    cJSON *ota_sha = data ? cJSON_GetObjectItemCaseSensitive(data, "otaSha256") : NULL;
    cJSON *ota_sig = data ? cJSON_GetObjectItemCaseSensitive(data, "otaSignature") : NULL;

    if (!cJSON_IsString(ota_url) || !ota_url->valuestring || strlen(ota_url->valuestring) == 0) {
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return;
    }

    /* Enterprise transport policy: firmware images are fetched over validated
     * TLS only. The Ed25519 signature is still the integrity backstop, but https
     * prevents passive disclosure and redirect-based downgrade of the download. */
    if (strncmp(ota_url->valuestring, "https://", 8) != 0) {
        ESP_LOGE(TAG, "Refusing OTA over insecure URL (https:// required): %s",
                 ota_url->valuestring);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return;
    }

    /* Version gate: don't re-flash the version we're already running. */
    if (cJSON_IsString(ota_ver) && !version_is_new(ota_ver->valuestring)) {
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return;
    }

    ESP_LOGI(TAG, "OTA update: %s → %s",
             cJSON_IsString(ota_ver) ? ota_ver->valuestring : "?", ota_url->valuestring);
    display_show_ota_progress(0);
    board_buzzer_beep(800, 200);

    esp_http_client_config_t http_cfg = {
        .url = ota_url->valuestring,
        .timeout_ms = 120000,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_https_ota_config_t ota_cfg = { .http_config = &http_cfg };

    esp_https_ota_handle_t handle = NULL;
    if (esp_https_ota_begin(&ota_cfg, &handle) != ESP_OK || handle == NULL) {
        ESP_LOGW(TAG, "esp_https_ota_begin failed");
        board_buzzer_beep(300, 500);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return;
    }

    /* Download the image into the inactive slot (not yet bootable). */
    do {
        err = esp_https_ota_perform(handle);
    } while (err == ESP_ERR_HTTPS_OTA_IN_PROGRESS);

    bool ok = (err == ESP_OK) && esp_https_ota_is_complete_data_received(handle);
    if (!ok) {
        ESP_LOGW(TAG, "OTA download incomplete: %s", esp_err_to_name(err));
        esp_https_ota_abort(handle);
        board_buzzer_beep(300, 500);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return;
    }

    /* ── Verify the staged image BEFORE making it bootable ──────── */
    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_partition_t *update = esp_ota_get_next_update_partition(running);
    bool verified = false;

    if (update) {
        uint8_t sha[32];
        if (esp_partition_get_sha256(update, sha) == ESP_OK) {
            char sha_hex[65];
            for (int i = 0; i < 32; i++) sprintf(sha_hex + i * 2, "%02x", sha[i]);
            sha_hex[64] = '\0';

            bool sha_ok = !cJSON_IsString(ota_sha) ||
                          strcmp(sha_hex, ota_sha->valuestring) == 0;
            if (!sha_ok) {
                ESP_LOGE(TAG, "SHA256 mismatch: expected %s got %s",
                         ota_sha->valuestring, sha_hex);
            } else {
                ESP_LOGI(TAG, "SHA256 verified ✓");
                verified = verify_ota_signature(
                    sha, cJSON_IsString(ota_sig) ? ota_sig->valuestring : NULL);
            }
        } else {
            ESP_LOGE(TAG, "esp_partition_get_sha256 failed");
        }
    }

    if (!verified) {
        ESP_LOGE(TAG, "OTA verification failed — aborting (image not booted)");
        esp_https_ota_abort(handle);
        board_buzzer_beep(300, 500);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return;
    }

    /* Verified — finish() sets the boot partition (PENDING_VERIFY w/ rollback). */
    esp_err_t fin = esp_https_ota_finish(handle);
    cJSON_Delete(root);
    http_client_free_response(&resp);

    if (fin != ESP_OK) {
        ESP_LOGE(TAG, "esp_https_ota_finish failed: %s", esp_err_to_name(fin));
        board_buzzer_beep(300, 500);
        return;
    }

    ESP_LOGI(TAG, "OTA verified + applied — restarting");
    board_buzzer_beep(2000, 100); vTaskDelay(pdMS_TO_TICKS(100)); board_buzzer_beep(2000, 100);
    esp_restart();
}

void ota_manager_mark_valid(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) != ESP_OK) return;
    if (state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGI(TAG, "First boot of new image confirmed good — cancelling rollback");
        esp_ota_mark_app_valid_cancel_rollback();
    }
}
