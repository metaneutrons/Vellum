// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "unity_min.h"
#include "d1001_power_logic.h"

static void test_voltage_curve_boundaries(void)
{
    TEST_ASSERT_EQUAL_INT(0, d1001_battery_percent_from_mv(3000));
    TEST_ASSERT_EQUAL_INT(0, d1001_battery_percent_from_mv(3262));
    TEST_ASSERT_EQUAL_INT(5, d1001_battery_percent_from_mv(3390));
    TEST_ASSERT_EQUAL_INT(50, d1001_battery_percent_from_mv(3774));
    TEST_ASSERT_EQUAL_INT(95, d1001_battery_percent_from_mv(3978));
    TEST_ASSERT_EQUAL_INT(100, d1001_battery_percent_from_mv(4047));
    TEST_ASSERT_EQUAL_INT(100, d1001_battery_percent_from_mv(4200));
}

static void test_voltage_curve_interpolates_between_knots(void)
{
    TEST_ASSERT_EQUAL_INT(2, d1001_battery_percent_from_mv(3326));
    TEST_ASSERT_EQUAL_INT(52, d1001_battery_percent_from_mv(3785));
}

static void test_charge_state_requires_usb_for_full(void)
{
    TEST_ASSERT_EQUAL_INT(D1001_BATTERY_STATUS_DISCHARGING,
                          d1001_battery_status_from_signals(false, true));
    TEST_ASSERT_EQUAL_INT(D1001_BATTERY_STATUS_DISCHARGING,
                          d1001_battery_status_from_signals(false, false));
    TEST_ASSERT_EQUAL_INT(D1001_BATTERY_STATUS_CHARGING,
                          d1001_battery_status_from_signals(true, false));
    TEST_ASSERT_EQUAL_INT(D1001_BATTERY_STATUS_FULL,
                          d1001_battery_status_from_signals(true, true));
}

void run_d1001_power_tests(void)
{
    RUN_TEST(test_voltage_curve_boundaries);
    RUN_TEST(test_voltage_curve_interpolates_between_knots);
    RUN_TEST(test_charge_state_requires_usb_for_full);
}
