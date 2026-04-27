// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file sleep_manager.h
 * @brief Deep sleep management for Vellum.
 */

#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    WAKE_REASON_POWER_ON,  /**< First boot or reset */
    WAKE_REASON_TIMER,     /**< Deep sleep timer expired */
    WAKE_REASON_BUTTON,    /**< GPIO wake source (button press) */
} wake_reason_t;

/** Initialize sleep manager. Call once at boot to determine wake reason. */
void sleep_manager_init(void);

/** Get the reason the device woke up. Only valid after init. */
wake_reason_t sleep_manager_get_wake_reason(void);

/**
 * Enter deep sleep for the specified number of seconds.
 * Configures both timer and GPIO button wake sources.
 * Does not return — device resets on wake.
 */
void sleep_manager_enter(uint32_t seconds, uint64_t button_wake_mask);

/**
 * Enter permanent deep sleep (no timer).
 * Only GPIO button presses can wake the device.
 */
void sleep_manager_enter_permanent(uint64_t button_wake_mask);

#ifdef __cplusplus
}
#endif
