/**
 * @file display_driver.h
 * @brief Display driver interface — abstracts hardware-specific display operations.
 *
 * Each display model implements this interface. The active driver is selected
 * at compile time via Kconfig (VELLUM_DRIVER_*).
 */

#pragma once

#include "esp_err.h"
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

typedef struct {
    const char *model;          /**< Model identifier sent to server (e.g. "e1002") */
    uint16_t    width;
    uint16_t    height;
    uint8_t     palette_size;   /**< Number of colors in palette */
    const char *quantize;       /**< "color", "grayscale", "mono" */

    /** Initialize display hardware (SPI, GPIOs, panel init sequence) */
    esp_err_t (*init)(void);

    /**
     * Draw a raw pixel buffer to the display.
     * Buffer format depends on the driver (palette indices, packed bits, etc.)
     * @param buffer  Pixel data from server
     * @param len     Buffer length in bytes
     * @return ESP_OK on success
     */
    esp_err_t (*draw)(const uint8_t *buffer, size_t len);

    /** Draw a 1-bit bitmap centered on the display (for icons/logos) */
    esp_err_t (*draw_bitmap)(const uint8_t *bitmap, uint16_t bw, uint16_t bh, int16_t x, int16_t y);

    /** Put display into low-power sleep mode */
    esp_err_t (*sleep)(void);

    /** Full display refresh */
    esp_err_t (*refresh)(void);
} display_driver_t;

/**
 * Get the active display driver (selected via Kconfig).
 * Returns a pointer to a static driver struct.
 */
const display_driver_t *display_get_driver(void);

#ifdef __cplusplus
extern "C" {
#endif
#ifdef __cplusplus
}
#endif
