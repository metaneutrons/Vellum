// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file nvs_manager.c
 * @brief NVS storage implementation for Vellum.
 */

#include "nvs_manager.h"

#include <string.h>
#include <stdint.h>
#include "esp_log.h"
#include "esp_random.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "psa/crypto.h"

static const char *TAG = "nvs_mgr";

#define KEY_WIFI_SSID   "wifi_ssid"
#define KEY_WIFI_PASS   "wifi_pass"
#define KEY_TOKEN       "device_token"
#define KEY_SERVER_URL  "server_url"
#define KEY_NTP_SERVER  "ntp_server"
#define KEY_PRIV_KEY    "ecdh_priv"
#define KEY_PUB_KEY     "ecdh_pub"
#define KEY_PROVISIONING_LOCK "prov_lock"
#define KEY_REMOTE_COMMAND_ID "remote_cmd"
#define KEY_WIFI_OLD_SSID "wifi_old_ssid"
#define KEY_WIFI_OLD_PASS "wifi_old_pass"
#define KEY_WIFI_PENDING "wifi_pending"
#define KEY_CONFIG_REPORT_ID "cfg_rep_id"
#define KEY_CONFIG_REPORT_ERROR "cfg_rep_err"
#define KEY_INTEGRITY_KEY "nvs_mac_key"
#define KEY_INTEGRITY_TAG "nvs_mac_tag"

#define NVS_INTEGRITY_BYTES 32

static nvs_integrity_status_t s_integrity_status = NVS_INTEGRITY_DISABLED;
static esp_err_t open_nvs(nvs_handle_t *handle, nvs_open_mode_t mode);

/* This set is deliberately explicit and versioned. Cache/display bookkeeping
 * is excluded; credentials, identity, enrollment state and remote-config
 * transaction state are covered. Appending keys is backwards-compatible only
 * when accompanied by a seal-version migration. */
static const char *const INTEGRITY_STRING_KEYS[] = {
    KEY_WIFI_SSID, KEY_WIFI_PASS, KEY_TOKEN, KEY_SERVER_URL, KEY_NTP_SERVER,
    KEY_PRIV_KEY, KEY_PUB_KEY, KEY_REMOTE_COMMAND_ID, KEY_WIFI_OLD_SSID,
    KEY_WIFI_OLD_PASS, KEY_WIFI_PENDING, KEY_CONFIG_REPORT_ID,
    KEY_CONFIG_REPORT_ERROR,
};

static esp_err_t hmac_update(psa_mac_operation_t *operation, const void *data, size_t len)
{
    return psa_mac_update(operation, data, len) == PSA_SUCCESS ? ESP_OK : ESP_FAIL;
}

static esp_err_t integrity_compute(nvs_handle_t h, const uint8_t key[NVS_INTEGRITY_BYTES],
                                   uint8_t out[NVS_INTEGRITY_BYTES])
{
    static const uint8_t domain[] = "vellum-hmac-nvs-v1\0";
    psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_type(&attributes, PSA_KEY_TYPE_HMAC);
    psa_set_key_bits(&attributes, NVS_INTEGRITY_BYTES * 8);
    psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_MESSAGE);
    psa_set_key_algorithm(&attributes, PSA_ALG_HMAC(PSA_ALG_SHA_256));
    psa_key_id_t key_id = 0;
    psa_mac_operation_t operation = PSA_MAC_OPERATION_INIT;
    psa_status_t status = psa_crypto_init();
    if (status == PSA_SUCCESS) {
        status = psa_import_key(&attributes, key, NVS_INTEGRITY_BYTES, &key_id);
    }
    psa_reset_key_attributes(&attributes);
    if (status == PSA_SUCCESS) {
        status = psa_mac_sign_setup(&operation, key_id, PSA_ALG_HMAC(PSA_ALG_SHA_256));
    }
    if (status != PSA_SUCCESS) {
        if (key_id != 0) psa_destroy_key(key_id);
        return ESP_FAIL;
    }

    esp_err_t err = hmac_update(&operation, domain, sizeof(domain));
    for (size_t i = 0; err == ESP_OK && i < sizeof(INTEGRITY_STRING_KEYS) / sizeof(INTEGRITY_STRING_KEYS[0]); i++) {
        const char *name = INTEGRITY_STRING_KEYS[i];
        uint8_t value[NVS_MAX_URL_LEN] = {0};
        size_t len = sizeof(value);
        esp_err_t read_err = nvs_get_str(h, name, (char *)value, &len);
        uint8_t present = read_err == ESP_OK ? 1 : 0;
        if (read_err != ESP_OK && read_err != ESP_ERR_NVS_NOT_FOUND) {
            err = read_err;
            break;
        }
        uint32_t payload_len = present && len > 0 ? (uint32_t)(len - 1) : 0;
        uint8_t length_be[4] = {
            (uint8_t)(payload_len >> 24), (uint8_t)(payload_len >> 16),
            (uint8_t)(payload_len >> 8), (uint8_t)payload_len,
        };
        err = hmac_update(&operation, name, strlen(name) + 1);
        if (err == ESP_OK) err = hmac_update(&operation, &present, sizeof(present));
        if (err == ESP_OK) err = hmac_update(&operation, length_be, sizeof(length_be));
        if (err == ESP_OK && payload_len > 0) err = hmac_update(&operation, value, payload_len);
        memset(value, 0, sizeof(value));
    }

    uint8_t locked = 0;
    esp_err_t lock_err = nvs_get_u8(h, KEY_PROVISIONING_LOCK, &locked);
    uint8_t lock_present = lock_err == ESP_OK ? 1 : 0;
    if (lock_err != ESP_OK && lock_err != ESP_ERR_NVS_NOT_FOUND) err = lock_err;
    if (err == ESP_OK) err = hmac_update(&operation, KEY_PROVISIONING_LOCK,
                                         strlen(KEY_PROVISIONING_LOCK) + 1);
    if (err == ESP_OK) err = hmac_update(&operation, &lock_present, sizeof(lock_present));
    if (err == ESP_OK) err = hmac_update(&operation, &locked, sizeof(locked));

    size_t output_len = 0;
    if (err == ESP_OK &&
        (psa_mac_sign_finish(&operation, out, NVS_INTEGRITY_BYTES, &output_len) != PSA_SUCCESS ||
         output_len != NVS_INTEGRITY_BYTES)) {
        err = ESP_FAIL;
    }
    if (err != ESP_OK) psa_mac_abort(&operation);
    if (key_id != 0) psa_destroy_key(key_id);
    return err;
}

static bool constant_time_equal(const uint8_t *a, const uint8_t *b, size_t len)
{
    uint8_t diff = 0;
    for (size_t i = 0; i < len; i++) diff |= a[i] ^ b[i];
    return diff == 0;
}

static esp_err_t integrity_read_blob(nvs_handle_t h, const char *name,
                                     uint8_t out[NVS_INTEGRITY_BYTES])
{
    size_t len = NVS_INTEGRITY_BYTES;
    esp_err_t err = nvs_get_blob(h, name, out, &len);
    return err == ESP_OK && len != NVS_INTEGRITY_BYTES ? ESP_ERR_NVS_INVALID_LENGTH : err;
}

#ifdef CONFIG_VELLUM_NVS_HMAC_INTEGRITY
static esp_err_t integrity_create(nvs_handle_t h)
{
    uint8_t key[NVS_INTEGRITY_BYTES];
    uint8_t tag[NVS_INTEGRITY_BYTES];
    esp_fill_random(key, sizeof(key));
    esp_err_t err = nvs_set_blob(h, KEY_INTEGRITY_KEY, key, sizeof(key));
    if (err == ESP_OK) err = integrity_compute(h, key, tag);
    if (err == ESP_OK) err = nvs_set_blob(h, KEY_INTEGRITY_TAG, tag, sizeof(tag));
    memset(key, 0, sizeof(key));
    memset(tag, 0, sizeof(tag));
    return err;
}
#endif

static esp_err_t commit_with_integrity(nvs_handle_t h)
{
    /* Once boot verification has failed, no ordinary configuration write may
     * bless the modified state with a fresh tag. Recovery is deliberately
     * restricted to nvs_manager_clear_all(), which erases both the protected
     * values and the local integrity material before re-enrollment. */
    if (s_integrity_status == NVS_INTEGRITY_INVALID) {
        return ESP_ERR_INVALID_CRC;
    }

    uint8_t key[NVS_INTEGRITY_BYTES];
    uint8_t existing_tag[NVS_INTEGRITY_BYTES];
    esp_err_t key_err = integrity_read_blob(h, KEY_INTEGRITY_KEY, key);
    esp_err_t tag_err = integrity_read_blob(h, KEY_INTEGRITY_TAG, existing_tag);
    esp_err_t err = ESP_OK;
    bool sealed = key_err == ESP_OK && tag_err == ESP_OK;

    if (key_err == ESP_OK && tag_err == ESP_OK) {
        uint8_t tag[NVS_INTEGRITY_BYTES];
        err = integrity_compute(h, key, tag);
        if (err == ESP_OK) err = nvs_set_blob(h, KEY_INTEGRITY_TAG, tag, sizeof(tag));
        memset(tag, 0, sizeof(tag));
    } else if (key_err == ESP_ERR_NVS_NOT_FOUND && tag_err == ESP_ERR_NVS_NOT_FOUND) {
#ifdef CONFIG_VELLUM_NVS_HMAC_INTEGRITY
        uint8_t locked = 0;
        if (nvs_get_u8(h, KEY_PROVISIONING_LOCK, &locked) == ESP_OK && locked == 1) {
            err = integrity_create(h);
            sealed = err == ESP_OK;
        }
#endif
    } else {
        err = ESP_ERR_INVALID_CRC;
    }
    memset(key, 0, sizeof(key));
    memset(existing_tag, 0, sizeof(existing_tag));
    if (err == ESP_OK) err = nvs_commit(h);
    if (err == ESP_OK && sealed) s_integrity_status = NVS_INTEGRITY_VALID;
    return err;
}

static esp_err_t integrity_initialize(void)
{
    nvs_handle_t h;
    esp_err_t err = open_nvs(&h, NVS_READWRITE);
    if (err != ESP_OK) return err;
    uint8_t key[NVS_INTEGRITY_BYTES];
    uint8_t stored[NVS_INTEGRITY_BYTES];
    esp_err_t key_err = integrity_read_blob(h, KEY_INTEGRITY_KEY, key);
    esp_err_t tag_err = integrity_read_blob(h, KEY_INTEGRITY_TAG, stored);
    if (key_err == ESP_ERR_NVS_NOT_FOUND && tag_err == ESP_ERR_NVS_NOT_FOUND) {
#ifdef CONFIG_VELLUM_NVS_HMAC_INTEGRITY
        uint8_t locked = 0;
        if (nvs_get_u8(h, KEY_PROVISIONING_LOCK, &locked) == ESP_OK && locked == 1) {
            err = integrity_create(h);
            if (err == ESP_OK) err = nvs_commit(h);
            s_integrity_status = err == ESP_OK ? NVS_INTEGRITY_VALID : NVS_INTEGRITY_INVALID;
        } else {
            s_integrity_status = NVS_INTEGRITY_DISABLED;
            err = ESP_OK;
        }
#else
        s_integrity_status = NVS_INTEGRITY_DISABLED;
        err = ESP_OK;
#endif
    } else if (key_err == ESP_OK && tag_err == ESP_OK) {
        uint8_t computed[NVS_INTEGRITY_BYTES];
        err = integrity_compute(h, key, computed);
        if (err == ESP_OK && constant_time_equal(stored, computed, sizeof(stored))) {
            s_integrity_status = NVS_INTEGRITY_VALID;
        } else {
            s_integrity_status = NVS_INTEGRITY_INVALID;
            err = ESP_ERR_INVALID_CRC;
        }
        memset(computed, 0, sizeof(computed));
    } else {
        s_integrity_status = NVS_INTEGRITY_INVALID;
        err = ESP_ERR_INVALID_CRC;
    }
    memset(key, 0, sizeof(key));
    memset(stored, 0, sizeof(stored));
    nvs_close(h);
    return err;
}

/* ---- internal helpers -------------------------------------------------- */

static esp_err_t open_nvs(nvs_handle_t *handle, nvs_open_mode_t mode)
{
    esp_err_t err = nvs_open(NVS_NAMESPACE, mode, handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open failed: %s", esp_err_to_name(err));
    }
    return err;
}

static esp_err_t read_str(const char *key, char *buf, size_t buf_len)
{
    nvs_handle_t h;
    esp_err_t err = open_nvs(&h, NVS_READONLY);
    if (err != ESP_OK) return err;

    size_t required = 0;
    err = nvs_get_str(h, key, NULL, &required);
    if (err != ESP_OK || required > buf_len) {
        nvs_close(h);
        return (err != ESP_OK) ? err : ESP_ERR_NVS_INVALID_LENGTH;
    }

    err = nvs_get_str(h, key, buf, &required);
    nvs_close(h);
    return err;
}

static esp_err_t write_str(const char *key, const char *value)
{
    nvs_handle_t h;
    esp_err_t err = open_nvs(&h, NVS_READWRITE);
    if (err != ESP_OK) return err;

    err = nvs_set_str(h, key, value);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_set_str(%s) failed: %s", key, esp_err_to_name(err));
        nvs_close(h);
        return err;
    }

    err = commit_with_integrity(h);
    nvs_close(h);
    return err;
}

static bool key_has_string(const char *key, bool allow_empty)
{
    nvs_handle_t h;
    if (open_nvs(&h, NVS_READONLY) != ESP_OK) return false;

    size_t len = 0;
    esp_err_t err = nvs_get_str(h, key, NULL, &len);
    nvs_close(h);
    /* NVS reports string length including the trailing NUL. An empty but
     * present string therefore has len==1; this is valid for an open Wi-Fi
     * network's password, but not for tokens, SSIDs, or key material. */
    return err == ESP_OK && (allow_empty ? len >= 1 : len > 1);
}

/* ---- public API -------------------------------------------------------- */

esp_err_t nvs_manager_init(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        /* Never turn a storage/version error into an implicit factory reset.
         * The caller keeps networking disabled and asks for a physical reset,
         * preserving the enrollment boundary even after partition changes. */
        ESP_LOGE(TAG, "NVS requires physical recovery: %s", esp_err_to_name(err));
        return err;
    }
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "NVS initialized");
        err = integrity_initialize();
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "NVS configuration integrity verification failed");
            return err;
        }
        /* Persist the independent enrollment lock before networking can rotate
         * or temporarily clear a legacy token after a 401 response. */
        if (nvs_manager_is_provisioning_locked()) {
            ESP_LOGI(TAG, "Provisioning writes locked for enrolled device");
        }
        /* A reboot or power loss while testing new credentials is ambiguous.
         * Fail safe before networking: restore the known-good profile and keep
         * a durable outcome that is reported once connectivity returns. */
        nvs_handle_t h;
        if (open_nvs(&h, NVS_READONLY) == ESP_OK) {
            size_t pending_len = 0;
            bool interrupted = nvs_get_str(h, KEY_WIFI_PENDING, NULL, &pending_len) == ESP_OK;
            nvs_close(h);
            if (interrupted) {
                ESP_LOGW(TAG, "Interrupted remote Wi-Fi change detected; rolling back");
                esp_err_t recovery = nvs_manager_rollback_remote_wifi("interrupted");
                if (recovery != ESP_OK) {
                    ESP_LOGE(TAG, "Remote Wi-Fi recovery failed: %s", esp_err_to_name(recovery));
                    return recovery;
                }
            }
        }
    }
    return err;
}

nvs_integrity_status_t nvs_manager_integrity_status(void)
{
    return s_integrity_status;
}

const char *nvs_manager_integrity_status_name(void)
{
    switch (s_integrity_status) {
    case NVS_INTEGRITY_VALID: return "valid";
    case NVS_INTEGRITY_INVALID: return "invalid";
    default: return "disabled";
    }
}

bool nvs_manager_has_wifi_credentials(void)
{
    return key_has_string(KEY_WIFI_SSID, false) &&
           key_has_string(KEY_WIFI_PASS, true);
}

bool nvs_manager_has_device_token(void)
{
    return key_has_string(KEY_TOKEN, false);
}

bool nvs_manager_is_provisioning_locked(void)
{
    nvs_handle_t h;
    if (open_nvs(&h, NVS_READWRITE) != ESP_OK) return true; /* fail closed */

    uint8_t locked = 0;
    esp_err_t err = nvs_get_u8(h, KEY_PROVISIONING_LOCK, &locked);
    if (err == ESP_OK) {
        nvs_close(h);
        return locked == 1;
    }

    /* One-time migration for already enrolled devices: a non-empty legacy
     * token proves enrollment, then the independent lock survives later token
     * rotation/revocation until a physical factory reset erases the namespace. */
    size_t token_len = 0;
    bool legacy_enrolled = nvs_get_str(h, KEY_TOKEN, NULL, &token_len) == ESP_OK && token_len > 1;
    if (legacy_enrolled) {
        if (nvs_set_u8(h, KEY_PROVISIONING_LOCK, 1) != ESP_OK ||
            commit_with_integrity(h) != ESP_OK) {
            ESP_LOGE(TAG, "Failed to persist provisioning lock");
        }
    }
    nvs_close(h);
    return legacy_enrolled;
}

esp_err_t nvs_manager_get_wifi_ssid(char *buf, size_t buf_len)
{
    return read_str(KEY_WIFI_SSID, buf, buf_len);
}

esp_err_t nvs_manager_get_wifi_pass(char *buf, size_t buf_len)
{
    return read_str(KEY_WIFI_PASS, buf, buf_len);
}

esp_err_t nvs_manager_get_token(char *buf, size_t buf_len)
{
    return read_str(KEY_TOKEN, buf, buf_len);
}

esp_err_t nvs_manager_get_server_url(char *buf, size_t buf_len)
{
    return read_str(KEY_SERVER_URL, buf, buf_len);
}

esp_err_t nvs_manager_get_ntp_server(char *buf, size_t buf_len)
{
    return read_str(KEY_NTP_SERVER, buf, buf_len);
}

esp_err_t nvs_manager_store_wifi(const char *ssid, const char *pass)
{
    if (!ssid || !pass || strlen(ssid) == 0) return ESP_ERR_INVALID_ARG;
    if (strlen(ssid) >= NVS_MAX_SSID_LEN)    return ESP_ERR_INVALID_ARG;
    if (strlen(pass) >= NVS_MAX_PASS_LEN)     return ESP_ERR_INVALID_ARG;

    nvs_handle_t h;
    esp_err_t err = open_nvs(&h, NVS_READWRITE);
    if (err != ESP_OK) return err;
    err = nvs_set_str(h, KEY_WIFI_SSID, ssid);
    if (err == ESP_OK) err = nvs_set_str(h, KEY_WIFI_PASS, pass);
    if (err == ESP_OK) err = commit_with_integrity(h);
    nvs_close(h);
    return err;
}

esp_err_t nvs_manager_store_token(const char *token)
{
    if (!token) return ESP_ERR_INVALID_ARG;
    if (strlen(token) >= NVS_MAX_TOKEN_LEN) return ESP_ERR_INVALID_ARG;
    nvs_handle_t h;
    esp_err_t err = open_nvs(&h, NVS_READWRITE);
    if (err != ESP_OK) return err;
    err = nvs_set_str(h, KEY_TOKEN, token);
    /* A non-empty token permanently marks this NVS lifecycle as enrolled. An
     * empty token is used during server-driven rotation and must not unlock USB. */
    if (err == ESP_OK && token[0] != '\0') {
        err = nvs_set_u8(h, KEY_PROVISIONING_LOCK, 1);
    }
    if (err == ESP_OK) err = commit_with_integrity(h);
    nvs_close(h);
    return err;
}

esp_err_t nvs_manager_store_server_url(const char *url)
{
    if (!url || strlen(url) == 0) return ESP_ERR_INVALID_ARG;
    if (strlen(url) >= NVS_MAX_URL_LEN) return ESP_ERR_INVALID_ARG;
    return write_str(KEY_SERVER_URL, url);
}

esp_err_t nvs_manager_get_remote_command_id(char *buf, size_t buf_len)
{
    return read_str(KEY_REMOTE_COMMAND_ID, buf, buf_len);
}

esp_err_t nvs_manager_apply_remote_server_url(const char *url, const char *command_id)
{
    if (!url || !command_id || strlen(url) == 0 || strlen(url) >= NVS_MAX_URL_LEN ||
        strlen(command_id) != NVS_REMOTE_COMMAND_ID_LEN - 1) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t h;
    esp_err_t err = open_nvs(&h, NVS_READWRITE);
    if (err != ESP_OK) return err;
    err = nvs_set_str(h, KEY_SERVER_URL, url);
    if (err == ESP_OK) err = nvs_set_str(h, KEY_REMOTE_COMMAND_ID, command_id);
    if (err == ESP_OK) err = commit_with_integrity(h);
    nvs_close(h);
    return err;
}

esp_err_t nvs_manager_stage_remote_wifi(const char *ssid, const char *pass,
                                        const char *command_id)
{
    if (!ssid || !pass || !command_id || strlen(ssid) == 0 ||
        strlen(ssid) >= NVS_MAX_SSID_LEN || strlen(pass) >= NVS_MAX_PASS_LEN ||
        strlen(command_id) != NVS_REMOTE_COMMAND_ID_LEN - 1) return ESP_ERR_INVALID_ARG;

    nvs_handle_t h;
    esp_err_t err = open_nvs(&h, NVS_READWRITE);
    if (err != ESP_OK) return err;
    char old_ssid[NVS_MAX_SSID_LEN] = {0};
    char old_pass[NVS_MAX_PASS_LEN] = {0};
    size_t ssid_len = sizeof(old_ssid), pass_len = sizeof(old_pass);
    err = nvs_get_str(h, KEY_WIFI_SSID, old_ssid, &ssid_len);
    if (err == ESP_OK) err = nvs_get_str(h, KEY_WIFI_PASS, old_pass, &pass_len);
    if (err == ESP_OK) err = nvs_set_str(h, KEY_WIFI_OLD_SSID, old_ssid);
    if (err == ESP_OK) err = nvs_set_str(h, KEY_WIFI_OLD_PASS, old_pass);
    if (err == ESP_OK) err = nvs_set_str(h, KEY_WIFI_PENDING, command_id);
    if (err == ESP_OK) err = nvs_set_str(h, KEY_WIFI_SSID, ssid);
    if (err == ESP_OK) err = nvs_set_str(h, KEY_WIFI_PASS, pass);
    if (err == ESP_OK) err = commit_with_integrity(h);
    nvs_close(h);
    return err;
}

esp_err_t nvs_manager_finalize_remote_wifi(const char *command_id)
{
    if (!command_id || strlen(command_id) != NVS_REMOTE_COMMAND_ID_LEN - 1) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t h;
    esp_err_t err = open_nvs(&h, NVS_READWRITE);
    if (err != ESP_OK) return err;
    char pending[NVS_REMOTE_COMMAND_ID_LEN] = {0};
    size_t pending_len = sizeof(pending);
    err = nvs_get_str(h, KEY_WIFI_PENDING, pending, &pending_len);
    if (err == ESP_OK && strcmp(pending, command_id) != 0) err = ESP_ERR_INVALID_STATE;
    if (err == ESP_OK) err = nvs_set_str(h, KEY_REMOTE_COMMAND_ID, command_id);
    if (err == ESP_OK) err = nvs_erase_key(h, KEY_WIFI_OLD_SSID);
    if (err == ESP_OK) err = nvs_erase_key(h, KEY_WIFI_OLD_PASS);
    if (err == ESP_OK) err = nvs_erase_key(h, KEY_WIFI_PENDING);
    if (err == ESP_OK) err = commit_with_integrity(h);
    nvs_close(h);
    return err;
}

esp_err_t nvs_manager_rollback_remote_wifi(const char *error_code)
{
    if (!error_code || !error_code[0]) return ESP_ERR_INVALID_ARG;
    nvs_handle_t h;
    esp_err_t err = open_nvs(&h, NVS_READWRITE);
    if (err != ESP_OK) return err;
    char old_ssid[NVS_MAX_SSID_LEN] = {0};
    char old_pass[NVS_MAX_PASS_LEN] = {0};
    char pending[NVS_REMOTE_COMMAND_ID_LEN] = {0};
    size_t ssid_len = sizeof(old_ssid), pass_len = sizeof(old_pass), pending_len = sizeof(pending);
    err = nvs_get_str(h, KEY_WIFI_OLD_SSID, old_ssid, &ssid_len);
    if (err == ESP_OK) err = nvs_get_str(h, KEY_WIFI_OLD_PASS, old_pass, &pass_len);
    if (err == ESP_OK) err = nvs_get_str(h, KEY_WIFI_PENDING, pending, &pending_len);
    if (err == ESP_OK) err = nvs_set_str(h, KEY_WIFI_SSID, old_ssid);
    if (err == ESP_OK) err = nvs_set_str(h, KEY_WIFI_PASS, old_pass);
    if (err == ESP_OK) err = nvs_set_str(h, KEY_CONFIG_REPORT_ID, pending);
    if (err == ESP_OK) err = nvs_set_str(h, KEY_CONFIG_REPORT_ERROR, error_code);
    if (err == ESP_OK) err = nvs_erase_key(h, KEY_WIFI_OLD_SSID);
    if (err == ESP_OK) err = nvs_erase_key(h, KEY_WIFI_OLD_PASS);
    if (err == ESP_OK) err = nvs_erase_key(h, KEY_WIFI_PENDING);
    if (err == ESP_OK) err = commit_with_integrity(h);
    nvs_close(h);
    return err;
}

esp_err_t nvs_manager_get_deferred_config_report(char *command_id, size_t command_id_len,
                                                 char *error_code, size_t error_code_len)
{
    esp_err_t err = read_str(KEY_CONFIG_REPORT_ID, command_id, command_id_len);
    if (err != ESP_OK) return err;
    return read_str(KEY_CONFIG_REPORT_ERROR, error_code, error_code_len);
}

esp_err_t nvs_manager_clear_deferred_config_report(void)
{
    nvs_handle_t h;
    esp_err_t err = open_nvs(&h, NVS_READWRITE);
    if (err != ESP_OK) return err;
    err = nvs_erase_key(h, KEY_CONFIG_REPORT_ID);
    if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    esp_err_t second = nvs_erase_key(h, KEY_CONFIG_REPORT_ERROR);
    if (second != ESP_OK && second != ESP_ERR_NVS_NOT_FOUND && err == ESP_OK) err = second;
    if (err == ESP_OK) err = commit_with_integrity(h);
    nvs_close(h);
    return err;
}

esp_err_t nvs_manager_store_ntp_server(const char *server)
{
    if (!server || strlen(server) >= NVS_MAX_NTP_SERVER_LEN) return ESP_ERR_INVALID_ARG;
    return write_str(KEY_NTP_SERVER, server);
}

esp_err_t nvs_manager_get_private_key(char *buf, size_t buf_len)
{
    return read_str(KEY_PRIV_KEY, buf, buf_len);
}

esp_err_t nvs_manager_get_public_key(char *buf, size_t buf_len)
{
    return read_str(KEY_PUB_KEY, buf, buf_len);
}

esp_err_t nvs_manager_store_keypair(const char *private_key, const char *public_key)
{
    if (!private_key || !public_key || strlen(private_key) >= NVS_MAX_KEY_LEN ||
        strlen(public_key) >= NVS_MAX_KEY_LEN) return ESP_ERR_INVALID_ARG;
    nvs_handle_t h;
    esp_err_t err = open_nvs(&h, NVS_READWRITE);
    if (err != ESP_OK) return err;
    err = nvs_set_str(h, KEY_PRIV_KEY, private_key);
    if (err == ESP_OK) err = nvs_set_str(h, KEY_PUB_KEY, public_key);
    if (err == ESP_OK) err = commit_with_integrity(h);
    nvs_close(h);
    return err;
}

bool nvs_manager_has_keypair(void)
{
    return key_has_string(KEY_PRIV_KEY, false) &&
           key_has_string(KEY_PUB_KEY, false);
}

esp_err_t nvs_manager_clear_all(void)
{
    nvs_handle_t h;
    esp_err_t err = open_nvs(&h, NVS_READWRITE);
    if (err != ESP_OK) return err;

    err = nvs_erase_all(h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_erase_all failed: %s", esp_err_to_name(err));
        nvs_close(h);
        return err;
    }

    err = nvs_commit(h);
    nvs_close(h);
    if (err == ESP_OK) s_integrity_status = NVS_INTEGRITY_DISABLED;
    ESP_LOGI(TAG, "All NVS keys erased");
    return err;
}

esp_err_t nvs_manager_set_str(const char *key, const char *value)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open("vellum", NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_str(h, key, value);
    if (err == ESP_OK) err = commit_with_integrity(h);
    nvs_close(h);
    return err;
}

esp_err_t nvs_manager_get_str(const char *key, char *buf, size_t buf_len)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open("vellum", NVS_READONLY, &h);
    if (err != ESP_OK) return err;
    err = nvs_get_str(h, key, buf, &buf_len);
    nvs_close(h);
    return err;
}
