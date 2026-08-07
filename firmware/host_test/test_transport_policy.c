// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "unity_min.h"
#include "transport_policy.h"

void test_transport_policy_always_accepts_https(void)
{
    TEST_ASSERT_TRUE(vellum_transport_url_allowed("https://vellum.example.com", false));
}

void test_transport_policy_requires_explicit_development_opt_in(void)
{
    TEST_ASSERT_FALSE(vellum_transport_url_allowed("http://192.168.16.5:3000", false));
    TEST_ASSERT_TRUE(vellum_transport_url_allowed("http://192.168.16.5:3000", true));
}

void test_transport_policy_accepts_only_rfc1918_literals(void)
{
    TEST_ASSERT_TRUE(vellum_transport_url_allowed("http://10.1.2.3/path", true));
    TEST_ASSERT_TRUE(vellum_transport_url_allowed("http://172.31.255.254", true));
    TEST_ASSERT_FALSE(vellum_transport_url_allowed("http://172.32.0.1", true));
    TEST_ASSERT_FALSE(vellum_transport_url_allowed("http://8.8.8.8", true));
    TEST_ASSERT_FALSE(vellum_transport_url_allowed("http://localhost:3000", true));
    TEST_ASSERT_FALSE(vellum_transport_url_allowed("http://192.168.16.5:0", true));
    TEST_ASSERT_FALSE(vellum_transport_url_allowed("ftp://192.168.16.5", true));
}

void run_transport_policy_tests(void)
{
    RUN_TEST(test_transport_policy_always_accepts_https);
    RUN_TEST(test_transport_policy_requires_explicit_development_opt_in);
    RUN_TEST(test_transport_policy_accepts_only_rfc1918_literals);
}
