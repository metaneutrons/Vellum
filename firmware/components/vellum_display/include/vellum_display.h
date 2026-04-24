/**
 * @file vellum_display.h
 * @brief E-Ink display driver for Vellum (800x480).
 */

#pragma once

#include "esp_err.h"
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define DISPLAY_WIDTH   800
#define DISPLAY_HEIGHT  480

/* Fallback icon IDs */
#define ICON_NO_SIGNAL        0
#define ICON_CLOUD_DISCONNECT 1
#define ICON_UNAUTHORIZED     2
#define ICON_CONNECT_POWER    3
#define ICON_ERROR            4
#define FALLBACK_ICON_COUNT   5

/** Initialize the E-Ink display hardware. */
void display_init(void);

/**
 * Write a raw pixel buffer to the E-Ink display.
 * @param buffer  Palette-indexed pixel data from the server.
 * @param length  Expected to be DISPLAY_WIDTH * DISPLAY_HEIGHT.
 * @return true if the buffer was valid and drawn.
 */
bool display_draw_pixel_buffer(const uint8_t *buffer, size_t length);

/** Draw a hardcoded fallback icon centered on the display. */
void display_draw_fallback_icon(uint8_t icon_id);

/** Render a QR code on the display for SoftAP provisioning. */
void display_draw_qr_code(const char *data);

/** Show a brief loading indicator. */
void display_show_loading(void);

/** Perform a full display refresh. */
void display_refresh(void);

/** Put the display into low-power mode before deep sleep. */
void display_sleep(void);

#ifdef __cplusplus
}
#endif
