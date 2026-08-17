// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "display_cache.h"

#include <string.h>

bool display_cache_matches(bool retains_image,
                           const char *persisted_id,
                           const char *awake_id,
                           const char *requested_id)
{
    if (!persisted_id || !awake_id || !requested_id || requested_id[0] == '\0') return false;
    if (strcmp(persisted_id, requested_id) != 0) return false;
    return retains_image || strcmp(awake_id, requested_id) == 0;
}
