// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "render_backoff.h"

uint32_t render_backoff_delay(uint32_t base_sec,
                              uint32_t consecutive_failures,
                              const uint32_t *ladder,
                              size_t ladder_len)
{
    if (consecutive_failures == 0) return base_sec;
    if (!ladder || ladder_len == 0) return base_sec;

    if (ladder_len > RENDER_BACKOFF_MAX_STEPS) ladder_len = RENDER_BACKOFF_MAX_STEPS;

    size_t idx = consecutive_failures - 1;
    if (idx >= ladder_len) idx = ladder_len - 1;

    /* A zero rung would busy-loop the radio; fall back to the cadence instead. */
    return ladder[idx] > 0 ? ladder[idx] : base_sec;
}

size_t render_backoff_parse(const char *value, uint32_t *out, size_t out_cap)
{
    if (!value || !out || out_cap == 0) return 0;
    if (out_cap > RENDER_BACKOFF_MAX_STEPS) out_cap = RENDER_BACKOFF_MAX_STEPS;

    size_t n = 0;
    const char *p = value;

    while (*p && n < out_cap) {
        while (*p == ' ' || *p == '\t' || *p == ',') p++;
        if (*p < '0' || *p > '9') break;          /* garbage — keep what we have */

        uint64_t v = 0;
        while (*p >= '0' && *p <= '9') {
            v = v * 10 + (uint64_t)(*p - '0');
            if (v > UINT32_MAX) return n;         /* absurd value — stop here */
            p++;
        }
        if (v == 0) return n;                    /* never accept a zero delay */
        out[n++] = (uint32_t)v;

        while (*p == ' ' || *p == '\t') p++;
        if (*p && *p != ',') break;              /* unexpected trailing token */
    }
    return n;
}
