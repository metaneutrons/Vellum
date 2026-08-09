// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "unity_min.h"
#include "wifi_failure.h"

void test_wifi_failure_classifies_network_not_found(void)
{
    TEST_ASSERT_EQUAL_INT(WIFI_FAILURE_NETWORK_NOT_FOUND,
                          wifi_failure_from_disconnect_reason(201));
    TEST_ASSERT_EQUAL_INT(WIFI_FAILURE_NETWORK_NOT_FOUND,
                          wifi_failure_from_disconnect_reason(212));
}

void test_wifi_failure_classifies_authentication_without_leaking_secrets(void)
{
    TEST_ASSERT_EQUAL_INT(WIFI_FAILURE_PASSWORD_REJECTED,
                          wifi_failure_from_disconnect_reason(202));
    TEST_ASSERT_EQUAL_STRING("Wi-Fi password was rejected",
                             wifi_failure_message(WIFI_FAILURE_PASSWORD_REJECTED));
}

void test_wifi_failure_classifies_signal_security_and_timeout(void)
{
    TEST_ASSERT_EQUAL_INT(WIFI_FAILURE_SIGNAL_LOST,
                          wifi_failure_from_disconnect_reason(200));
    TEST_ASSERT_EQUAL_INT(WIFI_FAILURE_SECURITY_MISMATCH,
                          wifi_failure_from_disconnect_reason(210));
    TEST_ASSERT_EQUAL_INT(WIFI_FAILURE_TIMED_OUT,
                          wifi_failure_from_disconnect_reason(39));
}

void test_wifi_failure_uses_safe_generic_copy_for_unknown_reason(void)
{
    TEST_ASSERT_EQUAL_INT(WIFI_FAILURE_UNKNOWN,
                          wifi_failure_from_disconnect_reason(255));
    TEST_ASSERT_EQUAL_STRING("Could not join saved Wi-Fi",
                             wifi_failure_message(WIFI_FAILURE_UNKNOWN));
}

void run_wifi_failure_tests(void)
{
    RUN_TEST(test_wifi_failure_classifies_network_not_found);
    RUN_TEST(test_wifi_failure_classifies_authentication_without_leaking_secrets);
    RUN_TEST(test_wifi_failure_classifies_signal_security_and_timeout);
    RUN_TEST(test_wifi_failure_uses_safe_generic_copy_for_unknown_reason);
}
