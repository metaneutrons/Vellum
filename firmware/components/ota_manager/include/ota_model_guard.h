// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <string.h>

/** Validate a staged app against the board model compiled into the firmware. */
static inline bool ota_model_matches(const char *staged_project_name,
                                     const char *display_model)
{
    if (!staged_project_name || !*staged_project_name ||
        !display_model || !*display_model) {
        return false;
    }

    static const char prefix[] = "vellum-";
    char expected[32]; /* esp_app_desc_t::project_name is 32 bytes. */
    const size_t model_len = strlen(display_model);
    if (model_len > sizeof(expected) - sizeof(prefix)) return false;
    memcpy(expected, prefix, sizeof(prefix) - 1);
    memcpy(expected + sizeof(prefix) - 1, display_model, model_len + 1);
    return strncmp(staged_project_name, expected, sizeof(expected)) == 0;
}
