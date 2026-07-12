// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "revocation.h"
#include <string.h>

/* MIRROR of csv_contains_token() in ota_manager.c — keep byte-for-byte
 * equivalent. Exact-length token match so "key1" never matches "key10". */
bool rev_csv_contains_token(const char *csv, const char *id)
{
    if (!csv || !*csv || !id || !*id) return false;
    const size_t idlen = strlen(id);
    const char *p = csv;
    while (*p) {
        while (*p == ',' || *p == ' ') p++;              /* skip separators + leading space */
        const char *start = p;
        while (*p && *p != ',') p++;                     /* to next comma / end */
        size_t len = (size_t)(p - start);
        while (len > 0 && start[len - 1] == ' ') len--;  /* trim trailing space */
        if (len == idlen && strncmp(start, id, idlen) == 0) return true;
    }
    return false;
}
