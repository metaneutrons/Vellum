// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include <stdbool.h>

/** Whether a local screen can be skipped without losing visible pixels. */
bool display_cache_matches(bool retains_image,
                           const char *persisted_id,
                           const char *awake_id,
                           const char *requested_id);
