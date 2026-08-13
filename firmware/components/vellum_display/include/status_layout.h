// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file status_layout.h
 * @brief Vertical grid for the branded status/error screens.
 *
 * Pure integer arithmetic, no LVGL and no ESP-IDF, so the host tests compile
 * this exact file instead of a mirrored copy.
 *
 * It exists because the previous layout used absolute per-tier constants that
 * assumed more vertical room than a 480px panel has: a 318px logo (66% of the
 * height) plus fixed offsets placed the error message at y=504 on a 480px
 * display, so it was never visible at all. Every offset here is a share of the
 * panel height, and `status_layout_fits()` is what keeps it that way.
 */
#pragma once

#include <stdbool.h>

/** Margin above the logo, as a percentage of panel height. */
#define STATUS_TOP_PCT 6
/** Gap between the branded mark and the content below it. */
#define STATUS_GAP_PCT 6
/** Space kept free at the bottom edge. */
#define STATUS_BOTTOM_PCT 5

/** Y of the logo's top edge. */
int status_layout_logo_top(int height);

/** Gap between the logo and the firmware identity line beneath it. */
int status_layout_identity_gap(int height);

/** Y of the firmware identity line (version | model). */
int status_layout_identity_top(int height, int logo_h);

/** Y where content below the branded mark may start. */
int status_layout_content_top(int height, int logo_h, int xs_line_h);

/** Vertical room the content may occupy before it would run off the panel. */
int status_layout_budget(int height, int logo_h, int xs_line_h);

/**
 * @brief Does a title + detail block fit inside the budget?
 *
 * The question the old layout got wrong. Callers use it to step down to a
 * smaller font rather than drawing off-screen.
 *
 * @param gap_h Vertical gap between the title and the detail line.
 */
bool status_layout_fits(int height, int logo_h, int xs_line_h,
                        int title_lines, int title_line_h,
                        int detail_lines, int detail_line_h,
                        int gap_h);
