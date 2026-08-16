// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "unity_min.h"
#include "sy6974b_power.h"

void test_sy6974b_external_power_requires_power_good(void)
{
    TEST_ASSERT_FALSE(sy6974b_status_has_external_power(0x20));
    TEST_ASSERT_TRUE(sy6974b_status_has_external_power(0x24));
}

void test_sy6974b_external_power_accepts_usb_and_adapter(void)
{
    TEST_ASSERT_TRUE(sy6974b_status_has_external_power(0x24));
    TEST_ASSERT_TRUE(sy6974b_status_has_external_power(0x64));
}

void test_sy6974b_external_power_rejects_no_input_and_otg(void)
{
    TEST_ASSERT_FALSE(sy6974b_status_has_external_power(0x04));
    TEST_ASSERT_FALSE(sy6974b_status_has_external_power(0xE4));
}

void test_sy6974b_decodes_all_charge_states(void)
{
    TEST_ASSERT_EQUAL_INT(SY6974B_CHARGE_NOT_CHARGING, sy6974b_status_charge_state(0x24));
    TEST_ASSERT_EQUAL_INT(SY6974B_CHARGE_PRECHARGE, sy6974b_status_charge_state(0x2C));
    TEST_ASSERT_EQUAL_INT(SY6974B_CHARGE_FAST, sy6974b_status_charge_state(0x34));
    TEST_ASSERT_EQUAL_INT(SY6974B_CHARGE_DONE, sy6974b_status_charge_state(0x3C));
}

void test_e_series_battery_curve_boundaries(void)
{
    TEST_ASSERT_EQUAL_INT(0, e_series_battery_percent_from_mv(3000));
    TEST_ASSERT_EQUAL_INT(5, e_series_battery_percent_from_mv(3300));
    TEST_ASSERT_EQUAL_INT(50, e_series_battery_percent_from_mv(3750));
    TEST_ASSERT_EQUAL_INT(90, e_series_battery_percent_from_mv(3960));
    TEST_ASSERT_EQUAL_INT(100, e_series_battery_percent_from_mv(4150));
    TEST_ASSERT_EQUAL_INT(100, e_series_battery_percent_from_mv(4300));
}

void test_e_series_battery_curve_interpolates(void)
{
    TEST_ASSERT_EQUAL_INT(15, e_series_battery_percent_from_mv(3450));
    TEST_ASSERT_EQUAL_INT(91, e_series_battery_percent_from_mv(3980));
}

void run_sy6974b_power_tests(void)
{
    RUN_TEST(test_sy6974b_external_power_requires_power_good);
    RUN_TEST(test_sy6974b_external_power_accepts_usb_and_adapter);
    RUN_TEST(test_sy6974b_external_power_rejects_no_input_and_otg);
    RUN_TEST(test_sy6974b_decodes_all_charge_states);
    RUN_TEST(test_e_series_battery_curve_boundaries);
    RUN_TEST(test_e_series_battery_curve_interpolates);
}
