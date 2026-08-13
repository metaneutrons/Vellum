// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "status_layout.h"

int status_layout_logo_top(int height)
{
    return height * STATUS_TOP_PCT / 100;
}

int status_layout_identity_gap(int height)
{
    /* Proportional, but never so tight that the version collides with the mark
     * on the smallest panel. */
    int gap = height * 15 / 1000;
    return gap < 10 ? 10 : gap;
}

int status_layout_identity_top(int height, int logo_h)
{
    return status_layout_logo_top(height) + logo_h + status_layout_identity_gap(height);
}

int status_layout_content_top(int height, int logo_h, int xs_line_h)
{
    return status_layout_identity_top(height, logo_h) + xs_line_h
           + height * STATUS_GAP_PCT / 100;
}

int status_layout_budget(int height, int logo_h, int xs_line_h)
{
    int budget = height - status_layout_content_top(height, logo_h, xs_line_h)
                 - height * STATUS_BOTTOM_PCT / 100;
    return budget < 0 ? 0 : budget;
}

bool status_layout_fits(int height, int logo_h, int xs_line_h,
                        int title_lines, int title_line_h,
                        int detail_lines, int detail_line_h,
                        int gap_h)
{
    int needed = title_lines * title_line_h + detail_lines * detail_line_h;
    if (title_lines > 0 && detail_lines > 0) needed += gap_h;
    return needed <= status_layout_budget(height, logo_h, xs_line_h);
}
