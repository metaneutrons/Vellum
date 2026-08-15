// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "unity_min.h"
#include "lcd_rotation.h"

#define PHYSICAL_WIDTH 800
#define LOGICAL_WIDTH 1280

static void test_landscape_corners_map_to_portrait_scanout(void)
{
    TEST_ASSERT_EQUAL_INT(1279 * 800, lcd_rotation_90_cw_index(0, 0, PHYSICAL_WIDTH, LOGICAL_WIDTH));
    TEST_ASSERT_EQUAL_INT(1279 * 800 + 799, lcd_rotation_90_cw_index(0, 799, PHYSICAL_WIDTH, LOGICAL_WIDTH));
    TEST_ASSERT_EQUAL_INT(0, lcd_rotation_90_cw_index(1279, 0, PHYSICAL_WIDTH, LOGICAL_WIDTH));
    TEST_ASSERT_EQUAL_INT(799, lcd_rotation_90_cw_index(1279, 799, PHYSICAL_WIDTH, LOGICAL_WIDTH));
}

static void test_partial_rows_remain_contiguous_after_rotation(void)
{
    size_t first = lcd_rotation_90_cw_index(400, 300, PHYSICAL_WIDTH, LOGICAL_WIDTH);
    TEST_ASSERT_EQUAL_INT(first + 1,
                          lcd_rotation_90_cw_index(400, 301, PHYSICAL_WIDTH, LOGICAL_WIDTH));
    TEST_ASSERT_EQUAL_INT(first - PHYSICAL_WIDTH,
                          lcd_rotation_90_cw_index(401, 300, PHYSICAL_WIDTH, LOGICAL_WIDTH));
}

void run_lcd_rotation_tests(void)
{
    RUN_TEST(test_landscape_corners_map_to_portrait_scanout);
    RUN_TEST(test_partial_rows_remain_contiguous_after_rotation);
}
