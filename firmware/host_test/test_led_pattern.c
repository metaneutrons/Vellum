// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Indicator patterns: pure arithmetic on (pattern, phase), so it is worth
 * pinning even though the thing it drives is a single GPIO.
 *
 * The properties that matter are not "does a blink blink" but the two that a
 * board's table quietly depends on: that every pattern which lights at all is
 * lit at phase 0, so a state change is visible at once rather than up to two
 * seconds later; and that only the patterns which actually change over time ask
 * for the tick, because on a battery display an idle timer is a cost with
 * nothing to show for it.
 */

#include "unity_min.h"
#include "led_pattern.h"

void test_led_pattern_off_is_never_lit(void)
{
    for (uint32_t phase = 0; phase < 64; ++phase) {
        TEST_ASSERT_FALSE(board_led_pattern_is_lit(BOARD_LED_OFF, phase));
    }
}

void test_led_pattern_steady_is_always_lit(void)
{
    for (uint32_t phase = 0; phase < 64; ++phase) {
        TEST_ASSERT_TRUE(board_led_pattern_is_lit(BOARD_LED_STEADY, phase));
    }
}

/* The whole point of the pulse: one tick of light per period, the rest dark. At
 * a 100 ms tick and a period of 20 that is 100 ms every two seconds, which is
 * what makes it affordable to leave running while somebody provisions. */
void test_led_pattern_pulse_is_one_tick_per_period(void)
{
    int lit = 0;
    for (uint32_t phase = 0; phase < BOARD_LED_PULSE_PERIOD * 3; ++phase) {
        if (board_led_pattern_is_lit(BOARD_LED_PULSE, phase)) lit++;
    }
    TEST_ASSERT_EQUAL_INT(3, lit);

    TEST_ASSERT_TRUE(board_led_pattern_is_lit(BOARD_LED_PULSE, 0));
    TEST_ASSERT_FALSE(board_led_pattern_is_lit(BOARD_LED_PULSE, 1));
    TEST_ASSERT_TRUE(board_led_pattern_is_lit(BOARD_LED_PULSE, BOARD_LED_PULSE_PERIOD));
}

/* An even blink, so half of every period. */
void test_led_pattern_blink_is_half_on(void)
{
    int lit = 0;
    const uint32_t span = BOARD_LED_BLINK_PERIOD * 4;
    for (uint32_t phase = 0; phase < span; ++phase) {
        if (board_led_pattern_is_lit(BOARD_LED_BLINK, phase)) lit++;
    }
    TEST_ASSERT_EQUAL_INT((int)(span / 2), lit);
    TEST_ASSERT_TRUE(board_led_pattern_is_lit(BOARD_LED_BLINK, 0));
    TEST_ASSERT_FALSE(board_led_pattern_is_lit(BOARD_LED_BLINK,
                                               BOARD_LED_BLINK_PERIOD / 2));
}

/* One blip and then dark forever. The driver stops its timer on the first tick,
 * but the arithmetic must agree with that or a resumed timer would relight it. */
void test_led_pattern_flash_once_lights_only_the_first_phase(void)
{
    TEST_ASSERT_TRUE(board_led_pattern_is_lit(BOARD_LED_FLASH_ONCE, 0));
    for (uint32_t phase = 1; phase < 64; ++phase) {
        TEST_ASSERT_FALSE(board_led_pattern_is_lit(BOARD_LED_FLASH_ONCE, phase));
    }
}

/* A state change has to be visible immediately. If any lighting pattern were
 * dark at phase 0, requesting it would look like nothing happened -- for the
 * pulse, for a full two seconds. */
void test_led_pattern_every_lighting_pattern_is_lit_at_phase_zero(void)
{
    const board_led_pattern_t lighting[] = {
        BOARD_LED_STEADY, BOARD_LED_PULSE, BOARD_LED_BLINK, BOARD_LED_FLASH_ONCE,
    };
    for (size_t i = 0; i < sizeof(lighting) / sizeof(lighting[0]); ++i) {
        TEST_ASSERT_TRUE(board_led_pattern_is_lit(lighting[i], 0));
    }
}

/* Only patterns that change over time may ask for the tick. Steady and off
 * settle after one write, and an idle timer on a battery display costs current
 * for nothing. */
void test_led_pattern_only_time_varying_patterns_need_the_tick(void)
{
    TEST_ASSERT_FALSE(board_led_pattern_needs_tick(BOARD_LED_OFF));
    TEST_ASSERT_FALSE(board_led_pattern_needs_tick(BOARD_LED_STEADY));
    TEST_ASSERT_TRUE(board_led_pattern_needs_tick(BOARD_LED_PULSE));
    TEST_ASSERT_TRUE(board_led_pattern_needs_tick(BOARD_LED_BLINK));
    TEST_ASSERT_TRUE(board_led_pattern_needs_tick(BOARD_LED_FLASH_ONCE));
}

/* ── Brightness ──────────────────────────────────────────────────
 *
 * The inversion is the part worth pinning: on active-low wiring more duty means
 * LESS light, so getting the sense backwards would light every indicator exactly
 * when it is supposed to be dark. Both directions, both ends.
 */

void test_led_duty_active_low_is_inverted(void)
{
    /* Dark is FULL duty when the pin sinks the current. */
    TEST_ASSERT_EQUAL_INT((int)BOARD_LED_DUTY_FULL,
                          (int)board_led_duty_for(0, 20, false));
    /* Lit at 20 % leaves 80 % of the scale. */
    TEST_ASSERT_EQUAL_INT((int)(BOARD_LED_DUTY_FULL -
                                (BOARD_LED_DUTY_FULL * 20u) / 100u),
                          (int)board_led_duty_for(0, 20, true));
}

void test_led_duty_active_high_is_direct(void)
{
    TEST_ASSERT_EQUAL_INT(0, (int)board_led_duty_for(1, 20, false));
    TEST_ASSERT_EQUAL_INT((int)((BOARD_LED_DUTY_FULL * 20u) / 100u),
                          (int)board_led_duty_for(1, 20, true));
}

/* The vendor's own calibration for the D1001, which is what the board table
 * carries: green 8 %, red 20 %, blue 50 %. Dimmer must mean nearer full duty on
 * this wiring, so the ordering is the readable invariant. */
void test_led_duty_dimmer_means_more_duty_when_active_low(void)
{
    const uint32_t green = board_led_duty_for(0, 8, true);
    const uint32_t red   = board_led_duty_for(0, 20, true);
    const uint32_t blue  = board_led_duty_for(0, 50, true);
    TEST_ASSERT_TRUE(green > red);
    TEST_ASSERT_TRUE(red > blue);
}

/* Full brightness on active-low wiring is duty zero, which is exactly what the
 * vendor BSP's (100 - percent) formula yields at 100. */
void test_led_duty_full_brightness_is_zero_duty_when_active_low(void)
{
    TEST_ASSERT_EQUAL_INT(0, (int)board_led_duty_for(0, 100, true));
    TEST_ASSERT_EQUAL_INT((int)BOARD_LED_DUTY_FULL,
                          (int)board_led_duty_for(0, 0, true));
}

/* A table with a nonsense percentage should clamp rather than wrap the duty into
 * something that reads as its opposite. */
void test_led_duty_clamps_an_out_of_range_percentage(void)
{
    TEST_ASSERT_EQUAL_INT((int)board_led_duty_for(0, 100, true),
                          (int)board_led_duty_for(0, 250, true));
    TEST_ASSERT_EQUAL_INT((int)board_led_duty_for(1, 100, true),
                          (int)board_led_duty_for(1, 250, true));
}

void run_led_pattern_tests(void)
{
    RUN_TEST(test_led_pattern_off_is_never_lit);
    RUN_TEST(test_led_pattern_steady_is_always_lit);
    RUN_TEST(test_led_pattern_pulse_is_one_tick_per_period);
    RUN_TEST(test_led_pattern_blink_is_half_on);
    RUN_TEST(test_led_pattern_flash_once_lights_only_the_first_phase);
    RUN_TEST(test_led_pattern_every_lighting_pattern_is_lit_at_phase_zero);
    RUN_TEST(test_led_pattern_only_time_varying_patterns_need_the_tick);
    RUN_TEST(test_led_duty_active_low_is_inverted);
    RUN_TEST(test_led_duty_active_high_is_direct);
    RUN_TEST(test_led_duty_dimmer_means_more_duty_when_active_low);
    RUN_TEST(test_led_duty_full_brightness_is_zero_duty_when_active_low);
    RUN_TEST(test_led_duty_clamps_an_out_of_range_percentage);
}
