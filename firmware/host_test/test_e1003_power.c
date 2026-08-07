// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "unity_min.h"
#include "e1003_power.h"

void test_e1003_external_power_requires_power_good(void)
{
    TEST_ASSERT_FALSE(e1003_charger_status_has_external_power(0x20));
    TEST_ASSERT_TRUE(e1003_charger_status_has_external_power(0x24));
}

void test_e1003_external_power_accepts_usb_and_adapter(void)
{
    TEST_ASSERT_TRUE(e1003_charger_status_has_external_power(0x24));
    TEST_ASSERT_TRUE(e1003_charger_status_has_external_power(0x64));
}

void test_e1003_external_power_rejects_no_input_and_otg(void)
{
    TEST_ASSERT_FALSE(e1003_charger_status_has_external_power(0x04));
    TEST_ASSERT_FALSE(e1003_charger_status_has_external_power(0xE4));
}

void run_e1003_power_tests(void)
{
    RUN_TEST(test_e1003_external_power_requires_power_good);
    RUN_TEST(test_e1003_external_power_accepts_usb_and_adapter);
    RUN_TEST(test_e1003_external_power_rejects_no_input_and_otg);
}
