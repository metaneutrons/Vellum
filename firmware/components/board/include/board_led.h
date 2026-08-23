// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file board_led.h
 * @brief What the indicator LEDs SAY, kept apart from which LEDs a board HAS.
 *
 * Two tables and one engine. A board declares the indicators it physically
 * carries, then maps each state onto one of them with a pattern. Adding a board
 * means writing those two tables. Adding a state means one enum entry and a row
 * per board. Nothing in `main()` learns what colour anything is, which is the
 * point: the E-Series carry a single green LED while the D1001 carries an RGB
 * one, and the call sites should not have to care.
 *
 * The rule the mapping has to respect: **dark is normal.** A display on a wall
 * does not blink at the room. Light means somebody is working on the device, or
 * something wants attention. Same reasoning as the audio policy, and the same
 * consequence: widening what lights up is a product decision, not a detail to
 * settle while passing through.
 *
 * A state may map to NO channel at all, and that is a decision rather than an
 * omission. A battery e-paper display spends nearly all its life in deep sleep,
 * where no core runs to blink anything and a steady light would eat the standby
 * budget the product is built around (an indicator LED draws roughly 1-2 mA;
 * held continuously that alone empties a 2000 mAh cell in a couple of months).
 * It also does not need to: when a render fails the firmware draws a status
 * screen, and e-paper keeps showing it while the device sleeps. The panel is
 * that board's persistent indicator. The D1001 is the opposite case, being
 * mains-oriented and always awake, so there a held colour costs nothing.
 */
#pragma once

#include <stdint.h>
#include "driver/gpio.h"
#include "led_pattern.h"

/** One physical indicator: a pin and the level that lights it. */
typedef struct {
    gpio_num_t  gpio;
    /** Level that turns it ON. 0 for the usual active-low wiring. */
    uint8_t     on_level;
    /** Colour or role, for logs only. Never parsed. */
    const char *label;
} board_led_channel_t;

/* board_led_pattern_t and its arithmetic live in led_pattern.h. */

typedef enum {
    /** Nothing to say. Dark on every board. */
    BOARD_LED_STATE_IDLE = 0,
    /** Somebody is provisioning: SoftAP is up, or USB setup is in progress. */
    BOARD_LED_STATE_SETUP,
    /** Working on a request a person is waiting for. */
    BOARD_LED_STATE_BUSY,
    /** A problem that outlasts this cycle: server unreachable, frame rejected. */
    BOARD_LED_STATE_FAULT,
    /** Below the critical threshold and not externally powered. */
    BOARD_LED_STATE_BATTERY_CRITICAL,
    BOARD_LED_STATE_COUNT,
} board_led_state_t;

/** Channel index meaning "this board does not express that state with an LED". */
#define BOARD_LED_NO_CHANNEL ((int8_t)-1)

typedef struct {
    /** Index into the profile's channel list, or BOARD_LED_NO_CHANNEL. */
    int8_t              channel;
    board_led_pattern_t pattern;
} board_led_expression_t;

typedef struct {
    const board_led_channel_t    *channels;
    uint8_t                       channel_count;
    /** Exactly BOARD_LED_STATE_COUNT entries, indexed by board_led_state_t. */
    const board_led_expression_t *states;
} board_led_profile_t;

/**
 * @brief The calling board's indicators and what it maps onto them.
 *
 * Implemented per model in board.c. A new board supplies this and needs to touch
 * nothing else.
 */
const board_led_profile_t *board_led_profile(void);

/**
 * @brief Configure every channel in the profile and start dark.
 *
 * Called from board_init(). Safe to call twice.
 */
void board_led_init(void);

/**
 * @brief Show a state, or stop showing anything.
 *
 * Never fails in a way a caller must handle: a board whose table maps the state
 * to no channel simply goes dark. Safe before init, which then happens lazily.
 */
void board_led_indicate(board_led_state_t state);

/** @brief What was last requested. For logs and tests. */
board_led_state_t board_led_current(void);
