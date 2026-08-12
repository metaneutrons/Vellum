// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * Retry pacing after failed render cycles. Compiles the real
 * components/sleep_manager/render_backoff.c — not a mirrored copy.
 */
#include "unity_min.h"
#include "render_backoff.h"
#include <stdint.h>

#define CAP 3600u

void test_render_backoff_healthy_cycle_keeps_server_cadence(void)
{
    TEST_ASSERT_EQUAL_INT(900, render_backoff_delay(900, 0, CAP));
    TEST_ASSERT_EQUAL_INT(60, render_backoff_delay(60, 0, CAP));
}

void test_render_backoff_doubles_per_failure(void)
{
    TEST_ASSERT_EQUAL_INT(120, render_backoff_delay(60, 1, CAP));
    TEST_ASSERT_EQUAL_INT(240, render_backoff_delay(60, 2, CAP));
    TEST_ASSERT_EQUAL_INT(480, render_backoff_delay(60, 3, CAP));
}

void test_render_backoff_honours_the_cap(void)
{
    TEST_ASSERT_EQUAL_INT(CAP, render_backoff_delay(60, 6, CAP));
    TEST_ASSERT_EQUAL_INT(CAP, render_backoff_delay(60, 1000, CAP));
    TEST_ASSERT_EQUAL_INT(CAP, render_backoff_delay(900, 3, CAP));
}

void test_render_backoff_never_shortens_a_deliberately_long_cadence(void)
{
    TEST_ASSERT_EQUAL_INT(7200, render_backoff_delay(7200, 5, CAP));
    TEST_ASSERT_EQUAL_INT(3600, render_backoff_delay(3600, 2, CAP));
}

void test_render_backoff_saturates_instead_of_wrapping(void)
{
    TEST_ASSERT_EQUAL_INT(960, render_backoff_delay(60, 4, 0));
    TEST_ASSERT_EQUAL_INT(UINT32_MAX, render_backoff_delay(0x40000000u, 4, 0));
    TEST_ASSERT_EQUAL_INT(0, render_backoff_delay(0, 5, CAP));
}

void test_render_backoff_is_monotonic(void)
{
    uint32_t prev = render_backoff_delay(30, 0, CAP);
    for (uint32_t f = 1; f <= 20; f++) {
        uint32_t cur = render_backoff_delay(30, f, CAP);
        TEST_ASSERT_TRUE(cur >= prev);
        TEST_ASSERT_TRUE(cur <= CAP);
        prev = cur;
    }
}

void run_render_backoff_tests(void)
{
    RUN_TEST(test_render_backoff_healthy_cycle_keeps_server_cadence);
    RUN_TEST(test_render_backoff_doubles_per_failure);
    RUN_TEST(test_render_backoff_honours_the_cap);
    RUN_TEST(test_render_backoff_never_shortens_a_deliberately_long_cadence);
    RUN_TEST(test_render_backoff_saturates_instead_of_wrapping);
    RUN_TEST(test_render_backoff_is_monotonic);
}
