// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include <stddef.h>

/** Map one pixel from Vellum's landscape coordinate system to the D1001's
 * portrait scanout buffer (90 degrees clockwise). Kept hardware-independent so
 * corner and partial-area behavior can be verified by host tests. */
static inline size_t lcd_rotation_90_cw_index(int logical_x, int logical_y,
                                               int physical_width, int logical_width)
{
    return (size_t)(logical_width - 1 - logical_x) * (size_t)physical_width
           + (size_t)logical_y;
}
