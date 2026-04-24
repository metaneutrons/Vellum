/**
 * @file vellum_display.h
 * @brief Display abstraction layer for Vellum.
 *
 * All operations delegate to the active display driver
 * selected via Kconfig (VELLUM_DRIVER_*).
 */

#pragma once

#include "esp_err.h"
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Fallback icon IDs */
#define ICON_NO_SIGNAL        0
#define ICON_CLOUD_DISCONNECT 1
#define ICON_UNAUTHORIZED     2
#define ICON_CONNECT_POWER    3
#define ICON_ERROR            4
#define FALLBACK_ICON_COUNT   5

void display_init(void);
bool display_draw_pixel_buffer(const uint8_t *buffer, size_t length);
void display_draw_fallback_icon(uint8_t icon_id);
void display_draw_qr_code(const char *data);
void display_show_loading(void);
void display_show_boot_logo(void);
void display_refresh(void);
void display_sleep(void);

#ifdef __cplusplus
}
#endif
