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

/**
 * @brief Icon shown above a status message.
 *
 * Every operational state used to reach the panel through display_show_error(),
 * which stamps a red warning triangle on all of them. A device patiently waiting
 * for an admin to approve it, or counting down a factory reset the operator just
 * asked for, is not a fault — but it looked exactly like one.
 *
 * On E1003 the glyphs come from the pre-generated large fonts, which carry only
 * these six symbols: adding a value here means adding its codepoint to
 * assets/render-fonts.sh and regenerating, or it renders as a missing glyph.
 */
typedef enum {
    VD_ICON_NONE = 0,   /**< No icon — plain informational text. */
    VD_ICON_WARNING,    /**< Genuine fault the operator must act on. */
    VD_ICON_BATTERY,    /**< Power/charge state. */
    VD_ICON_WIFI,       /**< Network reachability. */
    VD_ICON_SERVER,     /**< Server reachable but unhappy, or unreachable. */
    VD_ICON_PENDING,    /**< Correctly enrolled, waiting on someone else. */
    VD_ICON_REFRESH,    /**< Something is deliberately in progress. */
} vellum_display_icon_t;

/**
 * @brief Branded status screen: icon, title, optional detail line.
 *
 * Picks the largest font whose block fits the panel and wraps rather than
 * overflowing. @p detail may be NULL.
 */
void display_show_status_message(vellum_display_icon_t icon, const char *title,
                                 const char *detail);

/** Fault screen — display_show_status_message() with VD_ICON_WARNING. */
void display_show_error(const char *message);
void display_show_low_battery(void);
esp_err_t display_update_raw(const uint8_t *buffer, size_t len);
esp_err_t display_sleep(void);
esp_err_t display_wake(void);
