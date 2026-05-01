// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include "esp_err.h"
#include <stdint.h>

/**
 * Initialize the 8" MIPI-DSI LCD (800x1280) on reTerminal D1001.
 */
esp_err_t vellum_lcd_init(void);

/**
 * Display a JPEG image on the LCD.
 * @param data JPEG data buffer
 * @param len  Length of JPEG data
 */
esp_err_t vellum_lcd_show_jpeg(const uint8_t *data, uint32_t len);

/**
 * Get display dimensions.
 */
void vellum_lcd_get_size(uint16_t *width, uint16_t *height);
