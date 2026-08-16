// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define VELLUM_ERROR_BACKOFF_HEADER_LEN 64
#define VELLUM_ETAG_HEADER_LEN 32

/** Response metadata used by the render loop. Kept independent of ESP-IDF so
 * the exact wire contract can be exercised by the host test suite. */
typedef struct {
    int sleep_duration;
    char error_backoff[VELLUM_ERROR_BACKOFF_HEADER_LEN];
    char etag[VELLUM_ETAG_HEADER_LEN];
} vellum_response_headers_t;

void vellum_response_headers_init(vellum_response_headers_t *headers);

/** Capture one HTTP response header. Names are matched case-insensitively as
 * required by HTTP. Invalid, empty, or oversized values are ignored. */
void vellum_response_headers_capture(vellum_response_headers_t *headers,
                                     const char *name,
                                     const char *value);

#ifdef __cplusplus
}
#endif
