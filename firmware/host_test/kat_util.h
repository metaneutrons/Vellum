// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file kat_util.h
 * @brief Base64 decode helper for the crypto KAT tests.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

/**
 * Decode standard base64 (with '=' padding) into @p out.
 * @return number of bytes written, or -1 on malformed input / buffer overflow.
 */
static inline int b64_decode(const char *in, uint8_t *out, size_t out_cap)
{
    static const int8_t T_INIT = -1;
    int8_t tbl[256];
    for (int i = 0; i < 256; i++) tbl[i] = T_INIT;
    const char *A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (int i = 0; i < 64; i++) tbl[(uint8_t)A[i]] = (int8_t)i;

    uint32_t acc = 0;
    int bits = 0;
    size_t n = 0;
    for (const char *p = in; *p; p++) {
        if (*p == '=' || *p == '\n' || *p == '\r') continue;
        int8_t v = tbl[(uint8_t)*p];
        if (v < 0) return -1;
        acc = (acc << 6) | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (n >= out_cap) return -1;
            out[n++] = (uint8_t)((acc >> bits) & 0xFF);
        }
    }
    return (int)n;
}
