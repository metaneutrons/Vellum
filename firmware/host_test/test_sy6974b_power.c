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

void run_sy6974b_power_tests(void)
{
    RUN_TEST(test_sy6974b_external_power_requires_power_good);
    RUN_TEST(test_sy6974b_external_power_accepts_usb_and_adapter);
    RUN_TEST(test_sy6974b_external_power_rejects_no_input_and_otg);
}
