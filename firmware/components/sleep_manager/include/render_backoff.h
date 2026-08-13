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

#include <stddef.h>
#include <stdint.h>

/** Longest ladder a server may send (`X-Error-Backoff`). */
#define RENDER_BACKOFF_MAX_STEPS 8

/**
 * @brief Delay before the next attempt after `consecutive_failures` failures.
 *
 * A healthy cycle uses the cadence the server asked for. A failing one walks an
 * explicit ladder instead: the first failure waits `ladder[0]`, the second
 * `ladder[1]`, and so on, holding at the last rung.
 *
 * This used to double `base_sec` per failure, which made recovery worse the
 * slower the profile — on a 15-minute battery cadence a single dropped request
 * pushed the next attempt to 30 minutes, so the panel stayed stale for half an
 * hour over one lost packet. Errors want the opposite shape: retry sooner than
 * the normal cadence at first, and only then back off past it to protect the
 * battery when the server is genuinely gone.
 *
 * @param base_sec             Normal cadence (server `X-Sleep-Duration`, or the
 *                             configured fallback).
 * @param consecutive_failures Failures so far; 0 means the last cycle was fine.
 * @param ladder               Ascending delays in seconds, or NULL.
 * @param ladder_len           Entries in @p ladder; values past
 *                             RENDER_BACKOFF_MAX_STEPS are ignored.
 * @return Seconds to wait. With no usable ladder this is `base_sec` — retrying
 *         at the normal cadence is the safe direction to fail in, since the
 *         alternative silently strands a display.
 */
uint32_t render_backoff_delay(uint32_t base_sec,
                              uint32_t consecutive_failures,
                              const uint32_t *ladder,
                              size_t ladder_len);

/**
 * @brief Parse an `X-Error-Backoff` header value ("60,300,900,3600").
 *
 * Tolerant by design: whitespace is skipped, and a malformed or non-positive
 * entry ends parsing rather than poisoning the ladder with a zero that would
 * turn into a hot retry loop.
 *
 * @param value  Header value, may be NULL.
 * @param out    Receives up to RENDER_BACKOFF_MAX_STEPS ascending delays.
 * @param out_cap Capacity of @p out.
 * @return Number of entries written (0 when nothing usable was found).
 */
size_t render_backoff_parse(const char *value, uint32_t *out, size_t out_cap);
