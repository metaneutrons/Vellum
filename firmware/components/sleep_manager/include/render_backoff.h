// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file render_backoff.h
 * @brief Retry pacing after failed render cycles.
 *
 * Pure arithmetic, no ESP-IDF dependencies, so the host tests compile this exact
 * file rather than a mirrored copy.
 */
#pragma once

#include <stdint.h>

/**
 * @brief Delay before the next attempt after `consecutive_failures` failures.
 *
 * A healthy cycle uses the cadence the server asked for. When the backend or
 * the network is down, retrying at that same cadence wastes wake-ups and radio
 * time on an e-paper device that may only be able to try a few hundred times
 * before the battery is gone — so each successive failure doubles the delay, up
 * to `cap_sec`.
 *
 * @param base_sec             Normal cadence (server `X-Sleep-Duration`, or the
 *                             configured fallback). Returned unchanged when
 *                             there is no failure streak.
 * @param consecutive_failures Failures so far; 0 means the last cycle was fine.
 * @param cap_sec              Upper bound. 0 disables the cap.
 * @return Seconds to wait. Never below `base_sec`, never above `cap_sec`
 *         (unless `base_sec` already exceeds it, which is then returned as-is
 *         so a deliberately long cadence is never shortened).
 */
uint32_t render_backoff_delay(uint32_t base_sec,
                              uint32_t consecutive_failures,
                              uint32_t cap_sec);
