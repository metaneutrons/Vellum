// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "version_compare.h"
#include <stdio.h>

/* MIRROR of ota_parse_mmp() in ota_manager.c — keep byte-for-byte equivalent. */
void vc_parse_mmp(const char *v, int out[3])
{
    out[0] = out[1] = out[2] = 0;
    if (!v) return;
    if (*v == 'v') v++;
    sscanf(v, "%d.%d.%d", &out[0], &out[1], &out[2]);
}

int vc_compare_mmp(const char *a, const char *b)
{
    int oa[3], ob[3];
    vc_parse_mmp(a, oa);
    vc_parse_mmp(b, ob);
    for (int i = 0; i < 3; i++) {
        if (oa[i] != ob[i]) return oa[i] < ob[i] ? -1 : 1;
    }
    return 0;
}

/* MIRROR of ota_is_downgrade() in ota_manager.c: strictly-older mmp is a
 * downgrade; an equal-or-newer mmp (including a pre-release-only difference,
 * which parses to the same mmp) is not. */
bool vc_is_downgrade(const char *offered, const char *running)
{
    if (!offered || !running) return false;
    int o[3], r[3];
    vc_parse_mmp(offered, o);
    vc_parse_mmp(running, r);
    for (int i = 0; i < 3; i++) if (o[i] != r[i]) return o[i] < r[i];
    return false;
}
