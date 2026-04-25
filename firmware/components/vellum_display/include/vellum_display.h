/**
 * @file vellum_display.h
 * @brief Display abstraction — two modes: local (LVGL) and server (raw buffer).
 */
#pragma once

#include "esp_err.h"
#include <stdint.h>
#include <stddef.h>

typedef struct {
    const char *model;      /* "e1001" or "e1002" */
    uint16_t width;
    uint16_t height;
    uint8_t bpp;            /* 1 (BW) or 4 (6-color) */
    const char *color_mode; /* "bw" or "color" */
} display_info_t;

/* Initialize display hardware + LVGL */
esp_err_t display_init(void);

/* Get display info (for /hello capability report) */
esp_err_t display_get_info(display_info_t *info);

/* --- Local mode (LVGL screens) --- */
void display_show_boot(const char *version);
void display_show_wifi_setup(const char *ssid, const char *url);
void display_show_connecting(const char *ssid);
void display_show_ota_progress(uint8_t percent);
void display_show_error(const char *message);
void display_show_low_battery(void);

/* --- Server mode (raw pixel buffer) --- */
esp_err_t display_update_raw(const uint8_t *buffer, size_t len);

/* --- Power management --- */
esp_err_t display_sleep(void);
esp_err_t display_wake(void);
