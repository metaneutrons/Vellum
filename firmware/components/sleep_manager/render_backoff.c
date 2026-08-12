// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "render_backoff.h"

/* Doubling past this is pointless and risks shifting a uint32_t into oblivion;
 * 2^12 * a 15-minute cadence is already far beyond any sane cap. */
#define BACKOFF_MAX_SHIFT 12

uint32_t render_backoff_delay(uint32_t base_sec,
                              uint32_t consecutive_failures,
                              uint32_t cap_sec)
{
    if (base_sec == 0) return 0;
    if (consecutive_failures == 0) return base_sec;

    /* A cadence that is already longer than the cap is deliberate — never
     * shorten it just because the cap is lower. */
    if (cap_sec != 0 && base_sec >= cap_sec) return base_sec;

    uint32_t shift = consecutive_failures;
    if (shift > BACKOFF_MAX_SHIFT) shift = BACKOFF_MAX_SHIFT;

    uint32_t delay = base_sec;
    for (uint32_t i = 0; i < shift; i++) {
        /* Saturate instead of wrapping. */
        if (delay > UINT32_MAX / 2) return cap_sec != 0 ? cap_sec : UINT32_MAX;
        delay *= 2;
        if (cap_sec != 0 && delay >= cap_sec) return cap_sec;
    }
    return delay;
}
