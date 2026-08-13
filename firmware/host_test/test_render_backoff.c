// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Retry pacing after failed render cycles. Compiles the real
 * components/sleep_manager/render_backoff.c — not a mirrored copy.
 *
 * These tests used to assert that each failure DOUBLED the server's cadence.
 * That shape was backwards: the slower the profile, the worse recovery got — a
 * single dropped request on a 15-minute cadence pushed the next attempt to 30
 * minutes, so one lost packet left the panel stale for half an hour. The delay
 * now comes from an explicit ladder that starts below the cadence.
 */
#include "unity_min.h"
#include "render_backoff.h"
#include <stdint.h>

/* The default ladder in src/lib/sleep (errorBackoffS) and in main.c. */
static const uint32_t LADDER[] = { 60, 300, 900, 3600 };
#define LADDER_LEN (sizeof(LADDER) / sizeof(LADDER[0]))

void test_render_backoff_healthy_cycle_keeps_server_cadence(void)
{
    TEST_ASSERT_EQUAL_INT(900, render_backoff_delay(900, 0, LADDER, LADDER_LEN));
    TEST_ASSERT_EQUAL_INT(60, render_backoff_delay(60, 0, LADDER, LADDER_LEN));
}

void test_render_backoff_walks_the_ladder_per_failure(void)
{
    TEST_ASSERT_EQUAL_INT(60, render_backoff_delay(900, 1, LADDER, LADDER_LEN));
    TEST_ASSERT_EQUAL_INT(300, render_backoff_delay(900, 2, LADDER, LADDER_LEN));
    TEST_ASSERT_EQUAL_INT(900, render_backoff_delay(900, 3, LADDER, LADDER_LEN));
    TEST_ASSERT_EQUAL_INT(3600, render_backoff_delay(900, 4, LADDER, LADDER_LEN));
}

void test_render_backoff_first_failure_recovers_faster_than_the_cadence(void)
{
    /* The whole point, and the exact case the doubling version got wrong: one
     * failed cycle on a slow profile must retry SOONER, not later. */
    TEST_ASSERT_TRUE(render_backoff_delay(900, 1, LADDER, LADDER_LEN) < 900);
    TEST_ASSERT_TRUE(render_backoff_delay(3600, 1, LADDER, LADDER_LEN) < 3600);
}

void test_render_backoff_holds_at_the_last_rung(void)
{
    TEST_ASSERT_EQUAL_INT(3600, render_backoff_delay(900, 5, LADDER, LADDER_LEN));
    TEST_ASSERT_EQUAL_INT(3600, render_backoff_delay(900, 1000, LADDER, LADDER_LEN));
    TEST_ASSERT_EQUAL_INT(3600, render_backoff_delay(900, UINT32_MAX, LADDER, LADDER_LEN));
}

void test_render_backoff_without_a_ladder_keeps_the_cadence(void)
{
    /* Fail toward retrying too often, never toward stranding a display. */
    TEST_ASSERT_EQUAL_INT(900, render_backoff_delay(900, 1, NULL, 0));
    TEST_ASSERT_EQUAL_INT(900, render_backoff_delay(900, 9, NULL, 4));
    TEST_ASSERT_EQUAL_INT(900, render_backoff_delay(900, 3, LADDER, 0));
}

void test_render_backoff_rejects_a_zero_rung(void)
{
    /* A zero delay would busy-loop the radio. */
    const uint32_t bad[] = { 0, 300 };
    TEST_ASSERT_EQUAL_INT(600, render_backoff_delay(600, 1, bad, 2));
    TEST_ASSERT_EQUAL_INT(300, render_backoff_delay(600, 2, bad, 2));
}

void test_render_backoff_ignores_rungs_past_the_maximum(void)
{
    const uint32_t many[] = { 1, 2, 3, 4, 5, 6, 7, 8, 9999, 10000 };
    /* Entries past RENDER_BACKOFF_MAX_STEPS must not be reachable. */
    TEST_ASSERT_EQUAL_INT(8, render_backoff_delay(600, 9, many,
                                                 sizeof(many) / sizeof(many[0])));
    TEST_ASSERT_EQUAL_INT(8, render_backoff_delay(600, 50, many,
                                                 sizeof(many) / sizeof(many[0])));
}

void test_render_backoff_is_monotonic(void)
{
    uint32_t prev = render_backoff_delay(30, 1, LADDER, LADDER_LEN);
    for (uint32_t f = 2; f <= 20; f++) {
        uint32_t cur = render_backoff_delay(30, f, LADDER, LADDER_LEN);
        TEST_ASSERT_TRUE(cur >= prev);
        TEST_ASSERT_TRUE(cur <= 3600);
        prev = cur;
    }
}

void test_render_backoff_parses_a_header(void)
{
    uint32_t out[RENDER_BACKOFF_MAX_STEPS];
    TEST_ASSERT_EQUAL_INT(4, render_backoff_parse("60,300,900,3600", out,
                                                  RENDER_BACKOFF_MAX_STEPS));
    TEST_ASSERT_EQUAL_INT(60, out[0]);
    TEST_ASSERT_EQUAL_INT(3600, out[3]);

    /* Servers and proxies add spaces. */
    TEST_ASSERT_EQUAL_INT(3, render_backoff_parse(" 30, 60 , 120 ", out,
                                                  RENDER_BACKOFF_MAX_STEPS));
    TEST_ASSERT_EQUAL_INT(30, out[0]);
    TEST_ASSERT_EQUAL_INT(120, out[2]);
}

void test_render_backoff_parse_rejects_hostile_input(void)
{
    uint32_t out[RENDER_BACKOFF_MAX_STEPS];
    TEST_ASSERT_EQUAL_INT(0, render_backoff_parse(NULL, out, RENDER_BACKOFF_MAX_STEPS));
    TEST_ASSERT_EQUAL_INT(0, render_backoff_parse("", out, RENDER_BACKOFF_MAX_STEPS));
    TEST_ASSERT_EQUAL_INT(0, render_backoff_parse("abc", out, RENDER_BACKOFF_MAX_STEPS));
    /* A zero anywhere truncates rather than becoming a hot retry loop. */
    TEST_ASSERT_EQUAL_INT(0, render_backoff_parse("0,60", out, RENDER_BACKOFF_MAX_STEPS));
    TEST_ASSERT_EQUAL_INT(1, render_backoff_parse("60,0,900", out, RENDER_BACKOFF_MAX_STEPS));
    /* Overflow must not wrap into a tiny delay. */
    TEST_ASSERT_EQUAL_INT(1, render_backoff_parse("60,99999999999", out,
                                                 RENDER_BACKOFF_MAX_STEPS));
    /* Never writes past the caller's buffer. */
    TEST_ASSERT_EQUAL_INT(2, render_backoff_parse("1,2,3,4,5", out, 2));
}

void run_render_backoff_tests(void)
{
    RUN_TEST(test_render_backoff_healthy_cycle_keeps_server_cadence);
    RUN_TEST(test_render_backoff_walks_the_ladder_per_failure);
    RUN_TEST(test_render_backoff_first_failure_recovers_faster_than_the_cadence);
    RUN_TEST(test_render_backoff_holds_at_the_last_rung);
    RUN_TEST(test_render_backoff_without_a_ladder_keeps_the_cadence);
    RUN_TEST(test_render_backoff_rejects_a_zero_rung);
    RUN_TEST(test_render_backoff_ignores_rungs_past_the_maximum);
    RUN_TEST(test_render_backoff_is_monotonic);
    RUN_TEST(test_render_backoff_parses_a_header);
    RUN_TEST(test_render_backoff_parse_rejects_hostile_input);
}
