// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file vellum_panel.h
 * @brief Backend interface for the display abstraction.
 *
 * The shared screen layer (vellum_display.c) draws all local LVGL screens
 * (boot, Wi-Fi setup, error, OTA) against this vtable. Exactly one backend
 * implementation is compiled per target and provides vellum_panel():
 *   - panel_epaper.c  (ESP32-S3: UC8179 / IT8951 e-paper)
 *   - panel_lcd.c     (ESP32-P4: JD9365 MIPI-DSI LCD)
 *
 * This is what removes the per-panel #ifdefs from the screen code: geometry,
 * theme, fonts, logo and the hardware ops all arrive through one struct.
 */
#pragma once

#include "lvgl.h"
#include "esp_err.h"
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

typedef struct {
    /* ── Hardware lifecycle ───────────────────────────────────── */
    /** Initialize the panel + LVGL display. Returns the LVGL display handle,
     *  or NULL if local screens are unavailable (hardware may still work for
     *  draw_raw). Also populates the dynamic fields below (theme, logo). */
    lv_display_t *(*init)(void);
    /** Commit the active LVGL screen to the panel. */
    void          (*refresh)(void);
    /** Render a server-provided buffer (raw pixels for e-paper, JPEG for LCD). */
    esp_err_t     (*draw_raw)(const uint8_t *buf, size_t len);
    /** Optional native fast path for an already-created OTA progress bar.
     *  Coordinates use the panel's logical orientation. */
    esp_err_t     (*update_ota_progress)(uint8_t percent, int x, int y,
                                         int width, int height);
    void          (*sleep)(void);   /**< may be NULL */
    void          (*wake)(void);    /**< may be NULL */
    void          (*off)(void);     /**< may be NULL */

    /* ── Geometry / capabilities (static per panel) ───────────── */
    /* width/height are the DRAWABLE surface, after any scanout rotation the
     * backend applies. They are what the server must render, and the only
     * geometry any other component may report: a second copy of these numbers
     * elsewhere is how the D1001 came to tell the server "portrait 800x1280"
     * while its actual surface was landscape 1280x800, which cut 480px off the
     * bottom and left 480px blank on the right. */
    uint16_t        width, height;
    uint8_t         bpp;
    const char     *model;
    const char     *color_mode;
    /** Wire format the server should send: "raw" or "jpeg". */
    const char     *image_format;
    /** Colour mode as the SERVER names it, which is not always color_mode:
     *  the E1002 is "color" internally but must advertise "indexed". */
    const char     *wire_color_mode;
    /** Fixed palette, or NULL for a panel that needs none (fullcolor). */
    const uint8_t (*palette)[3];
    uint8_t         palette_count;
    /** Palette positions reserved by the panel and unusable for content. */
    const uint8_t  *reserved_palette_indices;
    uint8_t         reserved_count;
    /* Mountings this panel can actually deliver, preferred first, and the one
     * in effect now. Reported rather than assumed: the UI used to offer portrait
     * for every model regardless, including panels whose driver cannot rotate. */
    const char *const *orientations;
    uint8_t         orientation_count;
    const char     *orientation;
    bool            fast_refresh;     /**< false => slow e-paper hides transient screens */
    bool            retains_image;    /**< pixels survive MCU reset/deep sleep without redraw */
    bool            needs_tick_timer; /**< true => shared layer drives the LVGL tick */

    /* ── Theme (set by init(); lv_color_t is not a constant expr) ─ */
    lv_color_t      bg, fg, muted, dim;

    /* ── Fonts ────────────────────────────────────────────────── */
    const lv_font_t *font_lg, *font_md, *font_sm, *font_xs;

    /* ── Logo (set by init() when built at runtime, e.g. LCD) ──── */
    const lv_img_dsc_t *logo;
} vellum_panel_t;

/** Implemented by exactly one backend, selected per target by the CMakeLists. */
const vellum_panel_t *vellum_panel(void);
