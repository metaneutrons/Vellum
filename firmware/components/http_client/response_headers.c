// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.

#include "response_headers.h"

#include <ctype.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>

/* No valid Vellum schedule needs to keep a device away for more than a day.
 * Bounding hostile input avoids integer overflow and accidentally stranding a
 * display for weeks if a proxy or server is misconfigured. */
#define MAX_SLEEP_DURATION_SEC (24 * 60 * 60)

static bool header_name_equal(const char *left, const char *right)
{
    if (!left || !right) return false;
    while (*left && *right) {
        if (tolower((unsigned char)*left) != tolower((unsigned char)*right)) return false;
        left++;
        right++;
    }
    return *left == '\0' && *right == '\0';
}

static bool copy_complete(char *destination, size_t capacity, const char *value)
{
    if (!destination || capacity == 0 || !value || value[0] == '\0') return false;
    const size_t length = strlen(value);
    if (length >= capacity) return false;
    memcpy(destination, value, length + 1);
    return true;
}

void vellum_response_headers_init(vellum_response_headers_t *headers)
{
    if (headers) memset(headers, 0, sizeof(*headers));
}

void vellum_response_headers_capture(vellum_response_headers_t *headers,
                                     const char *name,
                                     const char *value)
{
    if (!headers || !name || !value) return;

    if (header_name_equal(name, "X-Sleep-Duration")) {
        errno = 0;
        char *end = NULL;
        const long parsed = strtol(value, &end, 10);
        while (end && isspace((unsigned char)*end)) end++;
        if (errno == 0 && end && end != value && *end == '\0' && parsed > 0 &&
            parsed <= MAX_SLEEP_DURATION_SEC) {
            headers->sleep_duration = (int)parsed;
        }
        return;
    }

    if (header_name_equal(name, "X-Sleep-Mode")) {
        if (strcmp(value, "poll") == 0 || strcmp(value, "sleep") == 0) {
            (void)copy_complete(headers->sleep_mode, sizeof(headers->sleep_mode), value);
        }
        return;
    }

    if (header_name_equal(name, "X-Display-State")) {
        if (strcmp(value, "on") == 0 || strcmp(value, "off") == 0) {
            (void)copy_complete(headers->display_state, sizeof(headers->display_state), value);
        }
        return;
    }

    if (header_name_equal(name, "X-Error-Backoff")) {
        (void)copy_complete(headers->error_backoff, sizeof(headers->error_backoff), value);
        return;
    }

    if (header_name_equal(name, "ETag")) {
        (void)copy_complete(headers->etag, sizeof(headers->etag), value);
    }
}
