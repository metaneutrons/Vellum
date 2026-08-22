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
 * firmware image with Ed25519; otaSignature is base64 of the 64-byte sig. The
 * device verifies it against a compile-time trust store (ota_trust_keys.h) — a
 * primary key plus an optional reserved "next" key — accepting the signature if
 * it validates under ANY non-revoked trusted key. That keyring is what makes
 * signing-key rotation possible without a hard, fleet-wide cutover.
 */

#include "ota_manager.h"

#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>
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
#include "mbedtls/platform_util.h"
#include "psa/crypto.h"
#include "sodium/crypto_sign.h"

#include "http_client.h"
#include "vellum_display.h"
#include "board.h"
#include "nvs_manager.h"
#include "vellum_log.h"
#include "wifi_manager.h"
#include "esp_attr.h"
#include "esp_rom_crc.h"
#include "sdkconfig.h"
#include "ota_trust_keys.h"
#include "ota_model_guard.h"

static const char *TAG = "ota";

/* A failed image must not monopolise an externally powered display by being
 * retried on every render. Persist this across deep sleep, but bind it to the
 * offered version so a later fixed release can apply immediately. */
#define OTA_RETRY_KEY "ota_retry"
#define OTA_RETRY_GRACE_SEC (15 * 60)
#define OTA_FAILURE_NOTICE_MS 5000
#define REMOTE_CONFIG_CONTEXT "vellum-remote-config-v1\n"
#define REMOTE_WIFI_CONTEXT "vellum-remote-wifi-v1\n"
#define REMOTE_ORIENTATION_CONTEXT "vellum-remote-orientation-v1\n"

static bool constant_time_equal(const uint8_t *a, const uint8_t *b, size_t len)
{
    uint8_t difference = 0;
    for (size_t i = 0; i < len; i++) difference |= a[i] ^ b[i];
    return difference == 0;
}

static bool valid_command_uuid(const char *id)
{
    if (!id || strlen(id) != 36) return false;
    for (size_t i = 0; i < 36; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (id[i] != '-') return false;
        } else if (!((id[i] >= '0' && id[i] <= '9') ||
                     (id[i] >= 'a' && id[i] <= 'f'))) return false;
    }
    return true;
}

static bool decode_hex_32(const char *hex, uint8_t output[32])
{
    if (!hex || strlen(hex) != 64) return false;
    for (size_t i = 0; i < 32; i++) {
        char pair[3] = { hex[i * 2], hex[i * 2 + 1], '\0' };
        char *end = NULL;
        unsigned long value = strtoul(pair, &end, 16);
        if (!end || *end != '\0') return false;
        output[i] = (uint8_t)value;
    }
    return true;
}

/*
 * One HMAC primitive for every authenticated desired-state command.
 *
 * The context string prefixed by each caller is what separates the kinds: a
 * signature minted for a server migration can never validate a Wi-Fi rotation or
 * a mounting change, even though all three are keyed by the same device token.
 * Keeping the PSA sequence in one place also keeps the three kinds from drifting
 * apart -- a constant-time comparison or a zeroization fixed in one copy and
 * forgotten in another is exactly the bug this shape prevents.
 */
static bool token_hmac_matches(const char *message, size_t message_len,
                               const char *signature_hex)
{
    uint8_t provided[32], expected[32];
    if (!message || message_len == 0 || !decode_hex_32(signature_hex, provided)) return false;

    char token[NVS_MAX_TOKEN_LEN] = {0};
    if (nvs_manager_get_token(token, sizeof(token)) != ESP_OK || strlen(token) != 64) {
        mbedtls_platform_zeroize(token, sizeof(token));
        return false;
    }

    psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_type(&attributes, PSA_KEY_TYPE_HMAC);
    psa_set_key_bits(&attributes, strlen(token) * 8);
    psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_MESSAGE);
    psa_set_key_algorithm(&attributes, PSA_ALG_HMAC(PSA_ALG_SHA_256));
    psa_key_id_t key = 0;
    size_t output_len = 0;
    psa_status_t status = psa_crypto_init();
    if (status == PSA_SUCCESS) {
        status = psa_import_key(&attributes, (const uint8_t *)token, strlen(token), &key);
    }
    psa_reset_key_attributes(&attributes);
    if (status == PSA_SUCCESS) {
        status = psa_mac_compute(key, PSA_ALG_HMAC(PSA_ALG_SHA_256),
                                 (const uint8_t *)message, message_len,
                                 expected, sizeof(expected), &output_len);
    }
    if (key != 0) psa_destroy_key(key);
    bool valid = status == PSA_SUCCESS && output_len == sizeof(expected) &&
                 constant_time_equal(expected, provided, sizeof(expected));
    mbedtls_platform_zeroize(token, sizeof(token));
    mbedtls_platform_zeroize(expected, sizeof(expected));
    return valid;
}

static bool verify_remote_config_signature(const char *id, const char *server_url,
                                           const char *signature_hex)
{
    if (!valid_command_uuid(id) || !server_url || strncmp(server_url, "https://", 8) != 0 ||
        strlen(server_url) >= NVS_MAX_URL_LEN) return false;
    char message[sizeof(REMOTE_CONFIG_CONTEXT) + 36 + NVS_MAX_URL_LEN + 1];
    int message_len = snprintf(message, sizeof(message), "%s%s\n%s",
                               REMOTE_CONFIG_CONTEXT, id, server_url);
    if (message_len < 0 || message_len >= (int)sizeof(message)) return false;
    return token_hmac_matches(message, (size_t)message_len, signature_hex);
}

static bool verify_remote_wifi_signature(const char *id, const char *ssid,
                                         const char *password, const char *signature_hex)
{
    if (!valid_command_uuid(id) || !ssid || !password || strlen(ssid) == 0 ||
        strlen(ssid) >= NVS_MAX_SSID_LEN || strlen(password) >= NVS_MAX_PASS_LEN) return false;

    unsigned char ssid_b64[48] = {0}, pass_b64[92] = {0};
    size_t ssid_b64_len = 0, pass_b64_len = 0;
    if (mbedtls_base64_encode(ssid_b64, sizeof(ssid_b64) - 1, &ssid_b64_len,
                              (const unsigned char *)ssid, strlen(ssid)) != 0 ||
        mbedtls_base64_encode(pass_b64, sizeof(pass_b64) - 1, &pass_b64_len,
                              (const unsigned char *)password, strlen(password)) != 0) return false;
    ssid_b64[ssid_b64_len] = '\0';
    pass_b64[pass_b64_len] = '\0';

    char message[sizeof(REMOTE_WIFI_CONTEXT) + 36 + sizeof(ssid_b64) + sizeof(pass_b64) + 3];
    int message_len = snprintf(message, sizeof(message), "%s%s\n%s\n%s",
                               REMOTE_WIFI_CONTEXT, id, ssid_b64, pass_b64);
    if (message_len < 0 || message_len >= (int)sizeof(message)) {
        mbedtls_platform_zeroize(message, sizeof(message));
        return false;
    }
    bool valid = token_hmac_matches(message, (size_t)message_len, signature_hex);
    /* The message carries the PSK in base64; do not leave it on the stack. */
    mbedtls_platform_zeroize(message, sizeof(message));
    mbedtls_platform_zeroize(pass_b64, sizeof(pass_b64));
    return valid;
}

/*
 * A mounting is not a secret, but it is still authenticated: the device reboots to
 * apply it, and a wrong mounting leaves a wall panel cropped and unreadable. So the
 * same token-keyed HMAC gates it, under its own context string.
 */
static bool verify_remote_orientation_signature(const char *id, const char *orientation,
                                                const char *signature_hex)
{
    if (!valid_command_uuid(id) || !orientation ||
        (strcmp(orientation, "portrait") != 0 && strcmp(orientation, "landscape") != 0)) {
        return false;
    }
    char message[sizeof(REMOTE_ORIENTATION_CONTEXT) + 36 + 16];
    int message_len = snprintf(message, sizeof(message), "%s%s\n%s",
                               REMOTE_ORIENTATION_CONTEXT, id, orientation);
    if (message_len < 0 || message_len >= (int)sizeof(message)) return false;
    return token_hmac_matches(message, (size_t)message_len, signature_hex);
}

static void rollback_remote_wifi(const char *command_id, const char *error_code)
{
    if (nvs_manager_rollback_remote_wifi(error_code) != ESP_OK) {
        ESP_LOGE(TAG, "Could not restore the previous Wi-Fi profile");
        http_client_config_report(command_id, "failed", "storage_failed");
        vTaskDelay(pdMS_TO_TICKS(250));
        esp_restart();
        return;
    }
    if (wifi_manager_reconnect_station() == WIFI_RESULT_CONNECTED &&
        http_client_config_report(command_id, "failed", error_code) == ESP_OK) {
        nvs_manager_clear_deferred_config_report();
    }
    vTaskDelay(pdMS_TO_TICKS(250));
    esp_restart();
}

void ota_manager_report_deferred_configuration(void)
{
    char command_id[NVS_REMOTE_COMMAND_ID_LEN] = {0};
    char error_code[48] = {0};
    if (nvs_manager_get_deferred_config_report(command_id, sizeof(command_id),
                                               error_code, sizeof(error_code)) != ESP_OK) return;
    ESP_LOGI(TAG, "Reporting recovered configuration command %s", command_id);
    if (http_client_config_report(command_id, "failed", error_code) == ESP_OK) {
        nvs_manager_clear_deferred_config_report();
    }
}

static void apply_remote_configuration(cJSON *data)
{
    cJSON *remote = data ? cJSON_GetObjectItemCaseSensitive(data, "remoteConfiguration") : NULL;
    if (!cJSON_IsObject(remote)) return;
    cJSON *protocol = cJSON_GetObjectItemCaseSensitive(remote, "protocol");
    cJSON *id = cJSON_GetObjectItemCaseSensitive(remote, "id");
    cJSON *kind = cJSON_GetObjectItemCaseSensitive(remote, "kind");
    cJSON *server_url = cJSON_GetObjectItemCaseSensitive(remote, "serverUrl");
    cJSON *ssid = cJSON_GetObjectItemCaseSensitive(remote, "ssid");
    cJSON *password = cJSON_GetObjectItemCaseSensitive(remote, "password");
    cJSON *orientation = cJSON_GetObjectItemCaseSensitive(remote, "orientation");
    cJSON *signature = cJSON_GetObjectItemCaseSensitive(remote, "signature");
    bool server_command = cJSON_IsString(kind) && strcmp(kind->valuestring, "server_url") == 0;
    bool wifi_command = cJSON_IsString(kind) && strcmp(kind->valuestring, "wifi") == 0;
    bool orientation_command = cJSON_IsString(kind) && strcmp(kind->valuestring, "orientation") == 0;
    bool signature_valid = cJSON_IsString(signature) && cJSON_IsString(id) &&
        ((server_command && cJSON_IsString(server_url) &&
          verify_remote_config_signature(id->valuestring, server_url->valuestring,
                                         signature->valuestring)) ||
         (wifi_command && cJSON_IsString(ssid) && cJSON_IsString(password) &&
          verify_remote_wifi_signature(id->valuestring, ssid->valuestring,
                                       password->valuestring, signature->valuestring)) ||
         (orientation_command && cJSON_IsString(orientation) &&
          verify_remote_orientation_signature(id->valuestring, orientation->valuestring,
                                              signature->valuestring)));
    if (!cJSON_IsNumber(protocol) || protocol->valueint != 1 ||
        !cJSON_IsString(id) || (!server_command && !wifi_command && !orientation_command) ||
        !signature_valid) {
        ESP_LOGE(TAG, "Rejected invalid remote configuration command");
        if (cJSON_IsString(id) && valid_command_uuid(id->valuestring)) {
            http_client_config_report(id->valuestring, "failed", "invalid_signature");
        }
        return;
    }

    char applied_id[NVS_REMOTE_COMMAND_ID_LEN] = {0};
    if (nvs_manager_get_remote_command_id(applied_id, sizeof(applied_id)) == ESP_OK &&
        strcmp(applied_id, id->valuestring) == 0) {
        ESP_LOGI(TAG, "Remote configuration %s already applied; acknowledging retry",
                 id->valuestring);
        http_client_config_report(id->valuestring, "applied", NULL);
        return;
    }

    if (orientation_command) {
        /* The panel is the authority on what it can deliver: the server checks the
         * reported capability list too, but that list can be stale after a downgrade,
         * and an unsupported mounting would leave the display cropped rather than
         * merely wrong. Refuse it here with a distinguishable reason. */
        vellum_display_caps_t caps = {0};
        bool supported = false;
        if (display_get_caps(&caps) == ESP_OK) {
            for (uint8_t i = 0; i < caps.orientation_count; i++) {
                if (caps.orientations[i] &&
                    strcmp(caps.orientations[i], orientation->valuestring) == 0) {
                    supported = true;
                    break;
                }
            }
        }
        if (!supported) {
            ESP_LOGE(TAG, "Panel cannot be mounted %s", orientation->valuestring);
            http_client_config_report(id->valuestring, "failed", "orientation_not_supported");
            return;
        }
        /* Already mounted this way: acknowledge without a pointless reboot. The
         * marker is still written so a re-delivery short-circuits above. */
        char current[16] = {0};
        bool unchanged = nvs_manager_get_orientation(current, sizeof(current)) == ESP_OK &&
                         strcmp(current, orientation->valuestring) == 0;
        if (http_client_config_report(id->valuestring, "applying", NULL) != ESP_OK) {
            ESP_LOGW(TAG, "Remote orientation claim was not acknowledged; retrying later");
            return;
        }
        if (nvs_manager_apply_remote_orientation(orientation->valuestring,
                                                 id->valuestring) != ESP_OK) {
            http_client_config_report(id->valuestring, "failed", "storage_failed");
            return;
        }
        http_client_config_report(id->valuestring, "applied", NULL);
        if (unchanged) {
            ESP_LOGI(TAG, "Orientation already %s; no restart needed", orientation->valuestring);
            return;
        }
        /* The display adapter fixes its rotation at init and sizes its framebuffers
         * from it, so the surface can only change across a restart. */
        ESP_LOGI(TAG, "Orientation set to %s; restarting to re-init the panel",
                 orientation->valuestring);
        vTaskDelay(pdMS_TO_TICKS(250));
        esp_restart();
        return;
    }

    if (wifi_command) {
        /* Claim while the known-good profile is still connected, then stage
         * old+new credentials in one NVS commit. A reboot before finalization
         * is detected during NVS init and rolls back automatically. */
        if (http_client_config_report(id->valuestring, "applying", NULL) != ESP_OK) {
            ESP_LOGW(TAG, "Remote Wi-Fi claim was not acknowledged; retrying later");
            return;
        }
        if (nvs_manager_stage_remote_wifi(ssid->valuestring, password->valuestring,
                                          id->valuestring) != ESP_OK) {
            http_client_config_report(id->valuestring, "failed", "storage_failed");
            return;
        }
        mbedtls_platform_zeroize(password->valuestring, strlen(password->valuestring));
        if (wifi_manager_reconnect_station() != WIFI_RESULT_CONNECTED) {
            ESP_LOGE(TAG, "Remote Wi-Fi connection failed; restoring previous profile");
            rollback_remote_wifi(id->valuestring, "wifi_connection_failed");
            return;
        }
        char current_server[NVS_MAX_URL_LEN] = {0};
        if (nvs_manager_get_server_url(current_server, sizeof(current_server)) != ESP_OK ||
            http_client_probe_server(current_server, id->valuestring) != ESP_OK) {
            ESP_LOGE(TAG, "Vellum server unavailable through new Wi-Fi; rolling back");
            rollback_remote_wifi(id->valuestring, "server_reconnect_failed");
            return;
        }
        if (nvs_manager_finalize_remote_wifi(id->valuestring) != ESP_OK) {
            rollback_remote_wifi(id->valuestring, "storage_failed");
            return;
        }
        http_client_config_report(id->valuestring, "applied", NULL);
        vTaskDelay(pdMS_TO_TICKS(250));
        esp_restart();
        return;
    }

    /* Anti-lockout gate: the target must complete authenticated TLS and expose
     * this exact desired-state command before its URL can enter NVS. */
    if (http_client_probe_server(server_url->valuestring, id->valuestring) != ESP_OK) {
        ESP_LOGE(TAG, "Remote server migration target validation failed");
        http_client_config_report(id->valuestring, "failed", "target_validation_failed");
        return;
    }
    /* Claim the command before mutating NVS. Queue/cancel operations can still
     * supersede a delivered command, but never one that the device has claimed
     * for application. This closes the validation-to-commit race. */
    if (http_client_config_report(id->valuestring, "applying", NULL) != ESP_OK) {
        ESP_LOGW(TAG, "Remote server migration claim was not acknowledged; retrying later");
        return;
    }
    if (nvs_manager_apply_remote_server_url(server_url->valuestring, id->valuestring) != ESP_OK) {
        ESP_LOGE(TAG, "Remote server migration could not be persisted");
        http_client_config_report(id->valuestring, "failed", "storage_failed");
        return;
    }

    ESP_LOGI(TAG, "Remote server migration applied; restarting");
    /* Best effort before restart. If the response is lost, the target server
     * re-delivers the same command and the idempotency marker re-acknowledges it. */
    http_client_config_report(id->valuestring, "applied", NULL);
    vTaskDelay(pdMS_TO_TICKS(250));
    esp_restart();
}

static bool ota_retry_is_deferred(const char *version)
{
    if (!version || !*version) return false;
    char value[96] = {0};
    if (nvs_manager_get_str(OTA_RETRY_KEY, value, sizeof(value)) != ESP_OK) return false;

    char *separator = strrchr(value, '|');
    if (!separator) return false;
    *separator++ = '\0';
    if (strcmp(value, version) != 0) return false;

    char *end = NULL;
    long long retry_at = strtoll(separator, &end, 10);
    time_t now = time(NULL);
    if (!end || *end != '\0' || retry_at <= 0 || now < 1700000000) return false;
    if ((long long)now < retry_at) {
        ESP_LOGW(TAG, "OTA %s deferred for another %lld seconds after a prior failure",
                 version, retry_at - (long long)now);
        return true;
    }
    return false;
}

static void ota_defer_retry(const char *version)
{
    if (!version || !*version) return;
    time_t now = time(NULL);
    if (now < 1700000000) {
        ESP_LOGW(TAG, "No valid clock; cannot persist OTA retry grace period");
        return;
    }
    char value[96];
    snprintf(value, sizeof(value), "%s|%lld", version,
             (long long)now + OTA_RETRY_GRACE_SEC);
    if (nvs_manager_set_str(OTA_RETRY_KEY, value) != ESP_OK) {
        ESP_LOGW(TAG, "Could not persist OTA retry grace period");
    }
}

static ota_check_result_t ota_show_failure_and_restore(const char *version,
                                                        const char *detail)
{
    ota_defer_retry(version);
    char message[160];
    snprintf(message, sizeof(message), "%s\nWill retry automatically",
             detail && *detail ? detail : "The update could not be completed");
    display_show_status_message(VD_ICON_WARNING, "Firmware update failed",
                                message);
    board_buzzer_beep(500, 500);
    /* Error feedback needs to be visible, but must not become the display's
     * steady state. The caller redraws normal content immediately afterwards. */
    vTaskDelay(pdMS_TO_TICKS(OTA_FAILURE_NOTICE_MS));
    return OTA_CHECK_RESTORE_RENDER;
}

#if defined(CONFIG_VELLUM_OTA_REQUIRE_SIGNATURE)
  #define OTA_REQUIRE_SIGNATURE 1
#else
  #define OTA_REQUIRE_SIGNATURE 0
#endif

/** True if `id` appears as a whole comma-separated token in `csv`
 *  (surrounding spaces tolerated). Used for the revoked-key-id check. */
static bool csv_contains_token(const char *csv, const char *id)
{
    if (!csv || !*csv || !id || !*id) return false;
    const size_t idlen = strlen(id);
    const char *p = csv;
    while (*p) {
        while (*p == ',' || *p == ' ') p++;      /* skip separators + leading space */
        const char *start = p;
        while (*p && *p != ',') p++;             /* to next comma / end */
        size_t len = (size_t)(p - start);
        while (len > 0 && start[len - 1] == ' ') len--;  /* trim trailing space */
        if (len == idlen && strncmp(start, id, idlen) == 0) return true;
    }
    return false;
}

/** True if a trusted key's id has been revoked (CONFIG_VELLUM_OTA_REVOKED_KEY_IDS). */
static bool key_is_revoked(const char *key_id)
{
    return csv_contains_token(CONFIG_VELLUM_OTA_REVOKED_KEY_IDS, key_id);
}

/**
 * Verify the 64-byte Ed25519 `sig` over `digest` under ONE base64 public key.
 * @return true on a valid Ed25519 signature; false on decode/verify failure.
 *         Isolated so the trust store can try each key in turn.
 */
static bool verify_one_key(const char *pubkey_b64, const uint8_t digest[32],
                           const uint8_t *sig, size_t sig_len)
{
    uint8_t pubkey[32];
    size_t pubkey_len = 0;
    if (mbedtls_base64_decode(pubkey, sizeof(pubkey), &pubkey_len,
                              (const unsigned char *)pubkey_b64, strlen(pubkey_b64)) != 0 ||
        pubkey_len != 32) {
        ESP_LOGE(TAG, "Bad OTA public key (need raw 32-byte Ed25519, base64)");
        return false;
    }

    if (sig_len != crypto_sign_BYTES) {
        ESP_LOGE(TAG, "Bad OTA signature length: %u", (unsigned)sig_len);
        return false;
    }

    return crypto_sign_verify_detached(sig, digest, 32, pubkey) == 0;
}

/**
 * Verify an Ed25519 signature over the 32-byte SHA-256 digest of the image
 * against the on-device trust store (ota_trust_keys.h). Accepts the signature
 * if it validates under ANY non-revoked trusted key.
 * @param digest       32-byte SHA-256 of the staged firmware.
 * @param sig_b64      base64 of the 64-byte Ed25519 signature.
 * @param key_id_hint  optional key id from /config (otaKeyId). Only a fast-path
 *                     hint — NEVER authoritative; a wrong/absent hint just costs
 *                     a fallback over the full store, so a crafted /config can't
 *                     force-select or skip keys.
 * @return true if a valid signature was verified; false otherwise.
 *         When the store holds no usable key this fails CLOSED unless
 *         CONFIG_VELLUM_OTA_ALLOW_UNSIGNED is set for local development.
 */
static bool verify_ota_signature(const uint8_t digest[32], const char *sig_b64,
                                 const char *key_id_hint)
{
    /* Is any key actually usable (non-empty pubkey, not revoked)? */
    bool have_key = false;
    for (size_t i = 0; i < s_trusted_keys_len; i++) {
        if (s_trusted_keys[i].pubkey_b64 && s_trusted_keys[i].pubkey_b64[0] &&
            !key_is_revoked(s_trusted_keys[i].key_id)) {
            have_key = true;
            break;
        }
    }
    if (!have_key) {
#if defined(CONFIG_VELLUM_OTA_ALLOW_UNSIGNED)
        /* Two flags must BOTH be set to accept unsigned firmware: ALLOW_UNSIGNED
         * (this #if) AND !REQUIRE_SIGNATURE. So REQUIRE_SIGNATURE=y (the default)
         * stays fail-closed even if someone also enabled ALLOW_UNSIGNED. */
        if (OTA_REQUIRE_SIGNATURE) {
            ESP_LOGE(TAG, "No OTA signing key, but signatures are REQUIRED "
                          "(CONFIG_VELLUM_OTA_REQUIRE_SIGNATURE) — refusing (fail-closed). "
                          "To accept unsigned on the bench, also set REQUIRE_SIGNATURE=n.");
            return false;
        }
        /* Dev-only escape hatch. Log loudly so this never passes unnoticed. */
        ESP_LOGW(TAG, "!!! No OTA signing key configured — ACCEPTING UNSIGNED "
                      "firmware (CONFIG_VELLUM_OTA_ALLOW_UNSIGNED + REQUIRE_SIGNATURE=n). "
                      "This must NEVER be enabled in production.");
        return true;
#else
        ESP_LOGE(TAG, "No OTA signing key configured — refusing OTA (fail-closed)");
        return false;
#endif
    }
    if (!sig_b64 || strlen(sig_b64) == 0) {
        ESP_LOGE(TAG, "OTA signature missing");
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

    /* Fast path: try the hinted key first (never authoritative). */
    if (key_id_hint && *key_id_hint) {
        for (size_t i = 0; i < s_trusted_keys_len; i++) {
            const ota_trusted_key_t *k = &s_trusted_keys[i];
            if (!k->pubkey_b64 || !k->pubkey_b64[0]) continue;
            if (key_is_revoked(k->key_id)) continue;
            if (strcmp(k->key_id, key_id_hint) != 0) continue;
            if (verify_one_key(k->pubkey_b64, digest, sig, sig_len)) {
                ESP_LOGI(TAG, "OTA signature verified ✓ (key %s)", k->key_id);
                return true;
            }
            break;  /* hinted key present but didn't verify — fall through to full scan */
        }
    }

    /* Fallback: try every non-revoked, non-empty trusted key. */
    for (size_t i = 0; i < s_trusted_keys_len; i++) {
        const ota_trusted_key_t *k = &s_trusted_keys[i];
        if (!k->pubkey_b64 || !k->pubkey_b64[0]) continue;   /* inert reserved slot */
        if (key_is_revoked(k->key_id)) continue;
        if (verify_one_key(k->pubkey_b64, digest, sig, sig_len)) {
            ESP_LOGI(TAG, "OTA signature verified ✓ (key %s)", k->key_id);
            return true;
        }
    }

    ESP_LOGE(TAG, "OTA signature verified by NO trusted key");
    return false;
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

/* Parse leading major.minor.patch from a version string (ignores -pre/+build). */
static void ota_parse_mmp(const char *v, int out[3])
{
    out[0] = out[1] = out[2] = 0;
    if (!v) return;
    if (*v == 'v') v++;
    sscanf(v, "%d.%d.%d", &out[0], &out[1], &out[2]);
}

/* True if `offered` is a strictly-older RELEASE than the running one (compares
 * major.minor.patch only — a pre-release-only difference is not treated as a
 * downgrade). Defense-in-depth against a replayed/tampered older signed image. */
static bool ota_is_downgrade(const char *offered)
{
    const esp_app_desc_t *app = esp_app_get_description();
    if (!app || !offered) return false;
    int o[3], r[3];
    ota_parse_mmp(offered, o);
    ota_parse_mmp(app->version, r);
    for (int i = 0; i < 3; i++) if (o[i] != r[i]) return o[i] < r[i];
    return false;
}

/* Fire-and-forget OTA outcome report to the server. `to` is the target version. */
static esp_err_t ota_report(const char *to, const char *phase, const char *err)
{
    const esp_app_desc_t *app = esp_app_get_description();
    return http_client_ota_report(CONFIG_VELLUM_DISPLAY_MODEL,
                                  app ? app->version : NULL, to, phase, err);
}

/* If the bootloader rolled a failed image back to us, report the FAILED version
 * so the server blocklists it — otherwise we'd re-report our old version and be
 * re-served the exact same bad image forever (the brick-retry loop). RTC memory
 * dedups across deep-sleep wakes; a magic guard resets it on a cold boot
 * (RTC_NOINIT is uninitialised at power-on). Reported once per rollback. */
#define OTA_RB_MAGIC 0x56454C55u  /* "VELU" */
RTC_NOINIT_ATTR static uint32_t s_rb_magic;
RTC_NOINIT_ATTR static uint32_t s_rb_reported_crc;

static void ota_report_rollback_if_needed(void)
{
    const esp_partition_t *bad = esp_ota_get_last_invalid_partition();
    if (!bad) return;
    esp_app_desc_t bad_desc;
    if (esp_ota_get_partition_description(bad, &bad_desc) != ESP_OK) return;

    if (s_rb_magic != OTA_RB_MAGIC) { s_rb_magic = OTA_RB_MAGIC; s_rb_reported_crc = 0; }
    uint32_t crc = esp_rom_crc32_le(0, (const uint8_t *)bad_desc.version,
                                    strlen(bad_desc.version));
    if (crc == s_rb_reported_crc) return;  /* already reported this rollback */

    ESP_LOGW(TAG, "Detected rolled-back image %s — reporting for blocklist", bad_desc.version);
    if (ota_report(bad_desc.version, "rolled_back", "boot_health_check") == ESP_OK) {
        s_rb_reported_crc = crc;
    }
}

ota_check_result_t ota_manager_check_and_apply(void)
{
    ESP_LOGI(TAG, "Checking for OTA update via /config");
    vellum_http_response_t resp = {0};
    esp_err_t err = http_client_config(&resp);

    if (err != ESP_OK || resp.status_code != 200 || !resp.body) {
        http_client_free_response(&resp);
        return OTA_CHECK_NO_RESTORE;
    }

    cJSON *root = cJSON_ParseWithLength(resp.body, resp.body_len);
    if (!root) { http_client_free_response(&resp); return OTA_CHECK_NO_RESTORE; }

    cJSON *data = cJSON_GetObjectItemCaseSensitive(root, "data");
    /* Diagnostics verbosity is a desired state like any other, so it rides the
     * ordinary poll rather than needing its own channel or a reboot. */
    cJSON *verbose = cJSON_GetObjectItemCaseSensitive(data, "logVerbose");
    if (cJSON_IsBool(verbose)) vellum_log_set_ship_everything(cJSON_IsTrue(verbose));

    /* Brightness arrives already resolved: the server evaluated the profile, the
     * schedule and the operator's override in the display's own timezone, so the
     * device applies a number and keeps no clock logic of its own. Absent means
     * the panel reported no backlight, and nothing is touched. */
    cJSON *backlight = cJSON_GetObjectItemCaseSensitive(data, "backlightPercent");
    if (cJSON_IsNumber(backlight)) {
        const int percent = backlight->valueint;
        if (percent >= 0 && percent <= 100) display_set_backlight(percent);
    }

    apply_remote_configuration(data);

    /* Power guard (anti-brick) applies to the large OTA flash write, not to the
     * tiny authenticated desired-state poll above. */
    if (!board_is_usb_powered()) {
        int battery = board_battery_level();
        if (battery < CONFIG_VELLUM_OTA_MIN_BATTERY_PCT) {
            ESP_LOGW(TAG, "Skipping OTA: battery %d%% < %d%% and not USB-powered",
                     battery, CONFIG_VELLUM_OTA_MIN_BATTERY_PCT);
            cJSON_Delete(root);
            http_client_free_response(&resp);
            return OTA_CHECK_NO_RESTORE;
        }
    }
    cJSON *ota_url = data ? cJSON_GetObjectItemCaseSensitive(data, "otaUrl") : NULL;
    cJSON *ota_ver = data ? cJSON_GetObjectItemCaseSensitive(data, "otaVersion") : NULL;
    cJSON *ota_sha = data ? cJSON_GetObjectItemCaseSensitive(data, "otaSha256") : NULL;
    cJSON *ota_sig = data ? cJSON_GetObjectItemCaseSensitive(data, "otaSignature") : NULL;
    cJSON *ota_kid = data ? cJSON_GetObjectItemCaseSensitive(data, "otaKeyId") : NULL;
    cJSON *ota_dg  = data ? cJSON_GetObjectItemCaseSensitive(data, "allowDowngrade") : NULL;
    bool allow_downgrade = cJSON_IsBool(ota_dg) && cJSON_IsTrue(ota_dg);

    if (!cJSON_IsString(ota_url) || !ota_url->valuestring || strlen(ota_url->valuestring) == 0) {
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return OTA_CHECK_NO_RESTORE;
    }

    /* Enterprise transport policy: firmware images are fetched over validated
     * TLS only. The Ed25519 signature is still the integrity backstop, but https
     * prevents passive disclosure and redirect-based downgrade of the download. */
    if (strncmp(ota_url->valuestring, "https://", 8) != 0) {
        ESP_LOGE(TAG, "Refusing OTA over insecure URL (https:// required): %s",
                 ota_url->valuestring);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return OTA_CHECK_NO_RESTORE;
    }

    /* Version gate: don't re-flash the version we're already running. */
    if (cJSON_IsString(ota_ver) && !version_is_new(ota_ver->valuestring)) {
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return OTA_CHECK_NO_RESTORE;
    }

    /* Downgrade guard (defense-in-depth): refuse a strictly-older image unless the
     * server sanctioned it (an operator pin-downgrade sets allowDowngrade). The
     * server's auto path never offers older, so an unsanctioned downgrade offer
     * means replay/tamper — don't flash it, and don't blocklist it (it's not bad). */
    if (cJSON_IsString(ota_ver) && ota_is_downgrade(ota_ver->valuestring) && !allow_downgrade) {
        ESP_LOGW(TAG, "Refusing unsanctioned downgrade to %s (running newer)",
                 ota_ver->valuestring);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return OTA_CHECK_NO_RESTORE;
    }

    ESP_LOGI(TAG, "OTA update: %s → %s",
             cJSON_IsString(ota_ver) ? ota_ver->valuestring : "?", ota_url->valuestring);
    /* Stable copy of the target version — the cJSON it lives in is freed before
     * the "applied" report point. */
    char to_ver[64];
    snprintf(to_ver, sizeof(to_ver), "%s",
             cJSON_IsString(ota_ver) && ota_ver->valuestring ? ota_ver->valuestring : "");

    if (ota_retry_is_deferred(to_ver)) {
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return OTA_CHECK_NO_RESTORE;
    }

    /* Silent: an update starting is neither a failure nor an acknowledgement of
     * a button, and those are the only two things this hardware makes noise for.
     * The progress screen is the feedback here. */
    display_show_ota_progress(0);

    esp_http_client_config_t http_cfg = {
        .url = ota_url->valuestring,
        .timeout_ms = 120000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        /* Larger buffers for delivery robustness: GitHub Releases redirects
         * carry long Location headers (rx), and weak links benefit from a bigger
         * receive window than the 512-byte default. */
        .buffer_size = 4096,
        .buffer_size_tx = 1024,
    };
    esp_https_ota_config_t ota_cfg = { .http_config = &http_cfg };

    esp_https_ota_handle_t handle = NULL;
    if (esp_https_ota_begin(&ota_cfg, &handle) != ESP_OK || handle == NULL) {
        ESP_LOGW(TAG, "esp_https_ota_begin failed");
        cJSON_Delete(root);
        http_client_free_response(&resp);
        ota_report(to_ver, "deferred", "download_begin");
        return ota_show_failure_and_restore(to_ver, "Could not start the firmware download");
    }

    /* ── Anti-brick: reject a wrong-model image BEFORE downloading it ────
     * All four models (e1001/e1002/e1003/d1001) are signed with the same key,
     * so the Ed25519 signature can't tell them apart — a mis-targeted image
     * would verify and then brick the device. The app descriptor project_name
     * is baked per-model as "vellum-<model>" (see CMakeLists.txt); compare the
     * staged image's project_name against the model compiled into this image
     * and abort on any mismatch. This also lets older/manual builds migrate to
     * the canonical per-model project name. esp_https_ota_begin() has already
     * fetched the image header, so the descriptor is available here. */
    esp_app_desc_t staged_desc;
    if (esp_https_ota_get_img_desc(handle, &staged_desc) != ESP_OK) {
        ESP_LOGE(TAG, "Cannot read staged image descriptor — aborting OTA");
        esp_https_ota_abort(handle);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        ota_report(to_ver, "verify_fail", "image_header");
        return ota_show_failure_and_restore(to_ver, "The firmware header could not be read");
    }
    if (!ota_model_matches(staged_desc.project_name, CONFIG_VELLUM_DISPLAY_MODEL)) {
        ESP_LOGE(TAG, "OTA model mismatch: staged '%s' is not model '%s' — aborting",
                 staged_desc.project_name, CONFIG_VELLUM_DISPLAY_MODEL);
        ota_report(to_ver, "verify_fail", "model_mismatch");
        esp_https_ota_abort(handle);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        return ota_show_failure_and_restore(to_ver,
                                            "Firmware is for a different display model");
    }

    /* Download the image into the inactive slot (not yet bootable).  IDF's
     * perform call returns after each received chunk, which lets us expose
     * honest byte progress instead of leaving the display at the initial 0%. */
    uint8_t displayed_percent = 0;
    do {
        err = esp_https_ota_perform(handle);
        int64_t total = esp_https_ota_get_image_size(handle);
        int64_t received = esp_https_ota_get_image_len_read(handle);
        if (total > 0 && received >= 0) {
            int calculated = (int)((received * 100) / total);
            if (calculated > 99) calculated = 99; /* 100 means verified/applied */
            uint8_t percent = (uint8_t)calculated;
            if (percent >= displayed_percent + 10) {
                displayed_percent = percent;
                display_show_ota_progress(percent);
            }
        }
    } while (err == ESP_ERR_HTTPS_OTA_IN_PROGRESS);

    bool ok = (err == ESP_OK) && esp_https_ota_is_complete_data_received(handle);
    if (!ok) {
        ESP_LOGW(TAG, "OTA download incomplete: %s", esp_err_to_name(err));
        esp_https_ota_abort(handle);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        ota_report(to_ver, "deferred", "download_interrupted");
        return ota_show_failure_and_restore(to_ver, "The firmware download was interrupted");
    }

    /* ── Verify the staged image BEFORE making it bootable ──────── */
    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_partition_t *update = esp_ota_get_next_update_partition(running);
    bool verified = false;
    const char *verify_error = "partition_missing";

    if (update) {
        uint8_t sha[32];
        if (esp_partition_get_sha256(update, sha) == ESP_OK) {
            char sha_hex[65];
            for (int i = 0; i < 32; i++) sprintf(sha_hex + i * 2, "%02x", sha[i]);
            sha_hex[64] = '\0';

            /* The expected digest is mandatory: without a server-supplied
             * otaSha256 the device has nothing to pin the image to, so treat a
             * missing digest as a failure rather than silently trusting it. */
            if (!cJSON_IsString(ota_sha) || !ota_sha->valuestring) {
                ESP_LOGE(TAG, "Server did not supply otaSha256 — refusing OTA");
                verify_error = "digest_missing";
            } else if (strcmp(sha_hex, ota_sha->valuestring) != 0) {
                ESP_LOGE(TAG, "SHA256 mismatch: expected %s got %s",
                         ota_sha->valuestring, sha_hex);
                verify_error = "digest_mismatch";
            } else {
                ESP_LOGI(TAG, "SHA256 verified ✓");
                verified = verify_ota_signature(
                    sha,
                    cJSON_IsString(ota_sig) ? ota_sig->valuestring : NULL,
                    cJSON_IsString(ota_kid) ? ota_kid->valuestring : NULL);
                if (!verified) verify_error = "signature";
            }
        } else {
            ESP_LOGE(TAG, "esp_partition_get_sha256 failed");
            verify_error = "partition_hash";
        }
    }

    if (!verified) {
        ESP_LOGE(TAG, "OTA verification failed — aborting (image not booted)");
        ota_report(to_ver, "verify_fail", verify_error);
        esp_https_ota_abort(handle);
        cJSON_Delete(root);
        http_client_free_response(&resp);
        const char *detail = strcmp(verify_error, "signature") == 0
            ? "The firmware signature is invalid"
            : "The firmware integrity check failed";
        return ota_show_failure_and_restore(to_ver, detail);
    }

    /* Verified — finish() sets the boot partition (PENDING_VERIFY w/ rollback). */
    esp_err_t fin = esp_https_ota_finish(handle);
    cJSON_Delete(root);
    http_client_free_response(&resp);

    if (fin != ESP_OK) {
        ESP_LOGE(TAG, "esp_https_ota_finish failed: %s", esp_err_to_name(fin));
        ota_report(to_ver, "deferred", "activate_failed");
        return ota_show_failure_and_restore(to_ver, "The firmware could not be activated");
    }

    ESP_LOGI(TAG, "OTA verified + applied — restarting");
    display_show_ota_progress(100);
    ota_report(to_ver, "applied", NULL);
    /* Silent for the same reason the start is: success is not a failure, and
     * nobody pressed anything. A room full of displays finishing an overnight
     * rollout should not chime in sequence. */
    esp_restart();
    return OTA_CHECK_NO_RESTORE; /* esp_restart does not return */
}

void ota_manager_mark_valid(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) == ESP_OK &&
        state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGI(TAG, "First boot of new image confirmed good — cancelling rollback");
        esp_ota_mark_app_valid_cancel_rollback();
        const esp_app_desc_t *app = esp_app_get_description();
        http_client_ota_report(CONFIG_VELLUM_DISPLAY_MODEL, NULL,
                               app ? app->version : NULL, "boot_confirmed", NULL);
    }

    /* Detect + report a bootloader rollback so the server blocklists the bad
     * version (breaks the brick-retry loop). Runs on every boot; deduped. */
    ota_report_rollback_if_needed();
}
