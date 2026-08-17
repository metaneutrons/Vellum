// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "unity_min.h"
#include "display_cache.h"

void test_retained_panel_skips_same_screen_after_deep_sleep(void)
{
    TEST_ASSERT_TRUE(display_cache_matches(true, "idle-v1", "", "idle-v1"));
}

void test_non_retained_panel_redraws_after_memory_reset(void)
{
    TEST_ASSERT_FALSE(display_cache_matches(false, "idle-v1", "", "idle-v1"));
    TEST_ASSERT_TRUE(display_cache_matches(false, "idle-v1", "idle-v1", "idle-v1"));
}

void test_changed_identity_always_redraws(void)
{
    TEST_ASSERT_FALSE(display_cache_matches(true, "idle-v1", "", "idle-v2"));
    TEST_ASSERT_FALSE(display_cache_matches(true, "", "", "idle-v1"));
}

void run_display_cache_tests(void)
{
    RUN_TEST(test_retained_panel_skips_same_screen_after_deep_sleep);
    RUN_TEST(test_non_retained_panel_redraws_after_memory_reset);
    RUN_TEST(test_changed_identity_always_redraws);
}
