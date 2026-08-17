// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define VELLUM_LAYOUT_FINGERPRINT_HEX_LEN 65

typedef struct {
    const char *chip_model;
    uint16_t chip_revision;
    uint32_t flash_size_bytes;
    const char *partition_layout;
    char partition_fingerprint[VELLUM_LAYOUT_FINGERPRINT_HEX_LEN];
    uint32_t partition_table_offset;
    bool layout_verified;
    bool secure_boot_enabled;
    bool flash_encryption_enabled;
    bool nvs_encryption_enabled;
} vellum_security_posture_t;

/** Collect hardware/runtime evidence from ESP-IDF, including the partition
 * entries actually parsed from flash. Unknown layouts fail closed. */
esp_err_t security_posture_collect(vellum_security_posture_t *out);

#ifdef __cplusplus
}
#endif
