// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#ifndef VELLUM_EPAPER_CONTRAST_H
#define VELLUM_EPAPER_CONTRAST_H

#include <stdbool.h>
#include <stdint.h>

/**
 * White is the paper/background state: converting visible source ink to white
 * erases it. LVGL produces exact 255 channels for an intentional white canvas,
 * so only that exact value may select the blank palette entry. Antialiased or
 * muted source pixels remain ink and therefore cannot make an entire glyph
 * disappear on a palette-limited panel.
 */
static inline bool epaper_rgb_is_intentionally_blank(uint8_t r, uint8_t g, uint8_t b)
{
    return r == 255 && g == 255 && b == 255;
}

#endif
