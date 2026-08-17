// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "unity_min.h"
#include "epaper_contrast.h"

void test_only_explicit_white_is_blank_paper(void)
{
    TEST_ASSERT_TRUE(epaper_rgb_is_intentionally_blank(255, 255, 255));
    TEST_ASSERT_FALSE(epaper_rgb_is_intentionally_blank(128, 128, 128));
    TEST_ASSERT_FALSE(epaper_rgb_is_intentionally_blank(254, 254, 254));
    TEST_ASSERT_FALSE(epaper_rgb_is_intentionally_blank(255, 0, 0));
    TEST_ASSERT_FALSE(epaper_rgb_is_intentionally_blank(0, 0, 0));
}

void run_epaper_contrast_tests(void)
{
    RUN_TEST(test_only_explicit_white_is_blank_paper);
}
