// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
// Based on Seeed Studio Tcon.cpp (MIT License, Copyright Seeed Studio / Bodmer)
#pragma once

#include "esp_err.h"
#include <stdint.h>
#include <stdbool.h>

typedef struct {
    int pin_busy;
    int pin_rst;
    int pin_cs;
    int pin_sck;
    int pin_mosi;
    int pin_miso;
    int spi_host;
    int speed_hz;
} it8951_config_t;

typedef struct {
    uint16_t width;
    uint16_t height;
    uint32_t img_buf_addr;
    char fw_version[16];
    char lut_version[16];
} it8951_dev_info_t;

/**
 * Initialize IT8951 TCON controller.
 */
esp_err_t it8951_init(const it8951_config_t *config);

/**
 * Get device info (panel size, buffer address, versions).
 */
esp_err_t it8951_get_info(it8951_dev_info_t *info);

/**
 * Load 4bpp grayscale image to display buffer.
 * @param data  4bpp pixel data (2 pixels per byte)
 * @param x,y   Position
 * @param w,h   Dimensions
 */
esp_err_t it8951_load_image_4bpp(const uint8_t *data, uint16_t x, uint16_t y, uint16_t w, uint16_t h);

/**
 * Load 1bpp image to display buffer.
 */
esp_err_t it8951_load_image_1bpp(const uint8_t *data, uint16_t x, uint16_t y, uint16_t w, uint16_t h);

/**
 * Trigger display refresh.
 * @param mode  0=INIT, 1=DU (fast partial), 2=GC16 (full quality)
 */
esp_err_t it8951_display_area(uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint16_t mode);

/**
 * Enter sleep mode.
 */
esp_err_t it8951_sleep(void);

/**
 * Wake from sleep.
 */
esp_err_t it8951_wake(void);

/**
 * Set VCOM voltage.
 */
esp_err_t it8951_set_vcom(uint16_t vcom);

/**
 * Set temperature for waveform selection.
 */
esp_err_t it8951_set_temp(uint16_t temp);
