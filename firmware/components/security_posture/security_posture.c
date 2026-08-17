// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

#include "security_posture.h"

#include <stdio.h>
#include <string.h>
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_flash_encrypt.h"
#include "esp_partition.h"
#include "esp_secure_boot.h"
#include "sdkconfig.h"
#include "psa/crypto.h"

typedef struct {
    const char *label;
    esp_partition_type_t type;
    esp_partition_subtype_t subtype;
    uint32_t address;
    uint32_t size;
} expected_partition_t;

static const expected_partition_t E_SERIES_V1[] = {
    {"nvs", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS, 0x9000, 0x6000},
    {"nvs_key", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS_KEYS, 0xf000, 0x1000},
    {"otadata", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_OTA, 0x10000, 0x2000},
    {"phy_init", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_PHY, 0x12000, 0x1000},
    {"ota_0", ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_0, 0x20000, 0x300000},
    {"ota_1", ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_1, 0x320000, 0x300000},
    {"storage", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_FAT, 0x620000, 0x20000},
};

static const expected_partition_t E_SERIES_SECURE_V1[] = {
    {"nvs", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS, 0x11000, 0x6000},
    {"nvs_key", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS_KEYS, 0x17000, 0x1000},
    {"otadata", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_OTA, 0x18000, 0x2000},
    {"phy_init", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_PHY, 0x1a000, 0x1000},
    {"ota_0", ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_0, 0x20000, 0x300000},
    {"ota_1", ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_1, 0x320000, 0x300000},
    {"storage", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_FAT, 0x620000, 0x20000},
};

static const expected_partition_t D1001_V1[] = {
    {"nvs", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS, 0x9000, 0x6000},
    {"nvs_key", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS_KEYS, 0xf000, 0x1000},
    {"otadata", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_OTA, 0x10000, 0x2000},
    {"phy_init", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_PHY, 0x12000, 0x1000},
    {"ota_0", ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_0, 0x20000, 0x800000},
    {"ota_1", ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_1, 0x820000, 0x800000},
    {"storage", ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_FAT, 0x1020000, 0xfe0000},
};

static bool layout_matches(const expected_partition_t *expected, size_t count)
{
    size_t actual_count = 0;
    esp_partition_iterator_t cursor = esp_partition_find(
        ESP_PARTITION_TYPE_ANY, ESP_PARTITION_SUBTYPE_ANY, NULL);
    while (cursor != NULL) {
        actual_count++;
        cursor = esp_partition_next(cursor);
    }
    /* esp_partition_next() invalidates the previous iterator and returns NULL
     * after releasing the final node. release(NULL) is explicitly supported. */
    esp_partition_iterator_release(cursor);
    if (actual_count != count) return false;

    for (size_t i = 0; i < count; i++) {
        const expected_partition_t *want = &expected[i];
        const esp_partition_t *actual = esp_partition_find_first(
            want->type, want->subtype, want->label);
        if (actual == NULL || actual->address != want->address ||
            actual->size != want->size) return false;
    }
    return true;
}

static esp_err_t fingerprint_partitions(char out[VELLUM_LAYOUT_FINGERPRINT_HEX_LEN])
{
    static const uint8_t domain[] = "vellum-partition-layout-v1";
    psa_hash_operation_t operation = PSA_HASH_OPERATION_INIT;
    if (psa_crypto_init() != PSA_SUCCESS ||
        psa_hash_setup(&operation, PSA_ALG_SHA_256) != PSA_SUCCESS ||
        psa_hash_update(&operation, domain, sizeof(domain)) != PSA_SUCCESS) {
        psa_hash_abort(&operation);
        return ESP_FAIL;
    }

    esp_partition_iterator_t cursor = esp_partition_find(
        ESP_PARTITION_TYPE_ANY, ESP_PARTITION_SUBTYPE_ANY, NULL);
    while (cursor != NULL) {
        const esp_partition_t *part = esp_partition_get(cursor);
        /* Do not hash esp_partition_t.encrypted: ESP-IDF derives that field
         * from the live flash-encryption eFuse for app/OTA/key partitions, so
         * the same table would otherwise acquire a different identity after
         * enrollment. Runtime encryption is attested separately. */
        uint8_t numeric[10] = {
            (uint8_t)part->type, (uint8_t)part->subtype,
            (uint8_t)(part->address >> 24), (uint8_t)(part->address >> 16),
            (uint8_t)(part->address >> 8), (uint8_t)part->address,
            (uint8_t)(part->size >> 24), (uint8_t)(part->size >> 16),
            (uint8_t)(part->size >> 8), (uint8_t)part->size,
        };
        const size_t label_len = strnlen(part->label, sizeof(part->label));
        static const uint8_t separator = 0;
        if (psa_hash_update(&operation, (const uint8_t *)part->label, label_len) != PSA_SUCCESS ||
            psa_hash_update(&operation, &separator, sizeof(separator)) != PSA_SUCCESS ||
            psa_hash_update(&operation, numeric, sizeof(numeric)) != PSA_SUCCESS) {
            esp_partition_iterator_release(cursor);
            psa_hash_abort(&operation);
            return ESP_FAIL;
        }
        cursor = esp_partition_next(cursor);
    }
    esp_partition_iterator_release(cursor);

    uint8_t digest[32];
    size_t digest_len = 0;
    if (psa_hash_finish(&operation, digest, sizeof(digest), &digest_len) != PSA_SUCCESS ||
        digest_len != sizeof(digest)) return ESP_FAIL;
    for (size_t i = 0; i < sizeof(digest); i++) {
        snprintf(out + i * 2, 3, "%02x", digest[i]);
    }
    out[64] = '\0';
    memset(digest, 0, sizeof(digest));
    return ESP_OK;
}

static const char *chip_model_name(esp_chip_model_t model)
{
    switch (model) {
    case CHIP_ESP32S3: return "esp32s3";
    case CHIP_ESP32P4: return "esp32p4";
    default: return "unknown";
    }
}

esp_err_t security_posture_collect(vellum_security_posture_t *out)
{
    if (out == NULL) return ESP_ERR_INVALID_ARG;
    memset(out, 0, sizeof(*out));

    esp_chip_info_t chip = {0};
    esp_chip_info(&chip);
    out->chip_model = chip_model_name(chip.model);
    out->chip_revision = chip.revision;
    out->partition_table_offset = CONFIG_PARTITION_TABLE_OFFSET;
    out->secure_boot_enabled = esp_secure_boot_enabled();
    out->flash_encryption_enabled = esp_flash_encryption_enabled();
#ifdef CONFIG_NVS_ENCRYPTION
    /* nvs_flash_init() has already succeeded before telemetry is collected;
     * with this build option it performs secure initialization and refuses an
     * unusable key partition. This reports active encrypted-NVS operation, not
     * merely the existence of nvs_key. */
    out->nvs_encryption_enabled = true;
#else
    out->nvs_encryption_enabled = false;
#endif

    esp_err_t err = esp_flash_get_size(NULL, &out->flash_size_bytes);
    if (err != ESP_OK) return err;
    err = fingerprint_partitions(out->partition_fingerprint);
    if (err != ESP_OK) return err;

    if (layout_matches(E_SERIES_V1, sizeof(E_SERIES_V1) / sizeof(E_SERIES_V1[0]))) {
        out->partition_layout = "e-series-v1";
    } else if (layout_matches(E_SERIES_SECURE_V1,
                              sizeof(E_SERIES_SECURE_V1) / sizeof(E_SERIES_SECURE_V1[0]))) {
        out->partition_layout = "e-series-secure-v1";
    } else if (layout_matches(D1001_V1, sizeof(D1001_V1) / sizeof(D1001_V1[0]))) {
        out->partition_layout = "d1001-v1";
    } else {
        out->partition_layout = "unknown";
    }
    out->layout_verified = strcmp(out->partition_layout, "unknown") != 0;
    return ESP_OK;
}
