// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file version_compare.h
 * @brief Host-testable mirror of the firmware OTA version-compare contract.
 *
 * MIRROR OF firmware/components/ota_manager/ota_manager.c
 *   - vc_parse_mmp   ↔ ota_parse_mmp()
 *   - vc_is_downgrade ↔ ota_is_downgrade()
 *
 * The device's downgrade guard and the SERVER's OTA-offer logic
 * (src/lib/firmware.ts compareSemver) must agree on the major.minor.patch
 * ordering, or the fleet gets either reflash loops (server offers what the
 * device thinks it already runs) or bypassed downgrade protection. These
 * functions encode that shared contract; test_version_compare.c pins it with a
 * golden vector table that both stacks must satisfy. Keep this in lockstep with
 * ota_manager.c — the parity vectors are the source of truth.
 */
#pragma once

#include <stdbool.h>

/** Parse leading major.minor.patch (ignores a leading 'v' and any -pre/+build). */
void vc_parse_mmp(const char *v, int out[3]);

/** <0 if a<b, 0 if equal, >0 if a>b — comparing major.minor.patch only. */
int vc_compare_mmp(const char *a, const char *b);

/** True if `offered` is a strictly-older RELEASE than `running` (mmp only). */
bool vc_is_downgrade(const char *offered, const char *running);
