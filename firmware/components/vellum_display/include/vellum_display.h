// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file vellum_display.h
 * @brief Unified display abstraction for E-Paper and LCD targets.
 */
#pragma once

#include "esp_err.h"
#include <stdint.h>
#include <stddef.h>

typedef struct {
    const char *model;      /* "e1001", "e1002", "e1003", or "d1001" */
    uint16_t width;
    uint16_t height;
    uint8_t bpp;            /* 1 (BW), 4 (grayscale/color), or 16 (fullcolor) */
    const char *color_mode; /* "bw", "color", "grayscale", or "fullcolor" */
} display_info_t;

/** Initialize the display hardware (E-Paper or LCD based on Kconfig). */
esp_err_t vellum_display_init(void);

/** Show a JPEG or raw image on the display. */
esp_err_t vellum_display_show_image(const uint8_t *data, size_t len, const char *format);

/** Show status text with the Vellum logo. */
esp_err_t vellum_display_show_status(const char *text);

/** Turn off display / backlight. */
void vellum_display_off(void);

/** Get display width in pixels. */
int vellum_display_width(void);

/** Get display height in pixels. */
int vellum_display_height(void);

/* ── Extended API (kept for backward compatibility) ─────────── */

esp_err_t display_init(void);
esp_err_t display_get_info(display_info_t *info);
void display_show_boot(const char *version);
void display_show_wifi_setup(const char *ssid, const char *url);
void display_show_connecting(const char *ssid);
/** Show a public-safe Wi-Fi failure screen and automatic retry timing. */
void display_show_wifi_error(const char *detail, uint32_t retry_after_seconds);
void display_show_ota_progress(uint8_t percent);
/** Show the neutral state returned when no content is assigned to this display. */
void display_show_no_content(void);
void display_show_error(const char *message);
void display_show_low_battery(void);
esp_err_t display_update_raw(const uint8_t *buffer, size_t len);
esp_err_t display_sleep(void);
esp_err_t display_wake(void);
