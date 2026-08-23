// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file led_pattern.h
 * @brief The blink arithmetic, with no hardware attached to it.
 *
 * Split out of board_led.h so it can be exercised by host tests: the periods and
 * the first-tick semantics are the part of the indicator with any logic in it,
 * and the part a new board's table is most likely to lean on. Everything here is
 * a pure function of (pattern, phase), the same shape as lcd_rotation.h.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/** Tick period the phase counter advances on. */
#define BOARD_LED_TICK_MS 100

/** Blip on the first tick of every 2 s. */
#define BOARD_LED_PULSE_PERIOD 20
/** 200 ms on, 200 ms off. */
#define BOARD_LED_BLINK_PERIOD 4

typedef enum {
    BOARD_LED_OFF = 0,
    /** Held on. For a person who is waiting on something. */
    BOARD_LED_STEADY,
    /** Brief blip on a long period: "awake and waiting for you". */
    BOARD_LED_PULSE,
    /** Even on/off. Reads as "attention" rather than "working". */
    BOARD_LED_BLINK,
    /** One blip, then dark. The affordable shape on battery. */
    BOARD_LED_FLASH_ONCE,
} board_led_pattern_t;

/**
 * @brief Is the indicator lit at this phase?
 *
 * Phase 0 is the moment the state was requested, and every pattern that lights
 * at all lights AT phase 0. That is deliberate: a state change should be visible
 * immediately rather than after up to a full period, which for the pulse would
 * be two seconds of apparent nothing.
 */
static inline bool board_led_pattern_is_lit(board_led_pattern_t pattern, uint32_t phase)
{
    switch (pattern) {
    case BOARD_LED_STEADY:     return true;
    case BOARD_LED_PULSE:      return (phase % BOARD_LED_PULSE_PERIOD) == 0;
    case BOARD_LED_BLINK:      return (phase % BOARD_LED_BLINK_PERIOD) <
                                      (BOARD_LED_BLINK_PERIOD / 2);
    case BOARD_LED_FLASH_ONCE: return phase == 0;
    case BOARD_LED_OFF:
    default:                   return false;
    }
}

/**
 * @brief Does this pattern need the tick running, or is it one write and done?
 *
 * Steady and off settle after a single write. FLASH_ONCE needs exactly one tick
 * to put itself out again, and the driver stops the timer there rather than
 * leaving it armed for a pattern that has finished.
 */
static inline bool board_led_pattern_needs_tick(board_led_pattern_t pattern)
{
    return pattern == BOARD_LED_PULSE || pattern == BOARD_LED_BLINK ||
           pattern == BOARD_LED_FLASH_ONCE;
}
