// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "unity_min.h"
#include "ota_model_guard.h"

static void test_matching_model_is_accepted(void)
{
    TEST_ASSERT_TRUE(ota_model_matches("vellum-d1001", "d1001"));
    TEST_ASSERT_TRUE(ota_model_matches("vellum-e1003", "e1003"));
}

static void test_wrong_or_generic_model_is_rejected(void)
{
    TEST_ASSERT_FALSE(ota_model_matches("vellum-e1003", "d1001"));
    TEST_ASSERT_FALSE(ota_model_matches("vellum-firmware", "d1001"));
    TEST_ASSERT_FALSE(ota_model_matches("", "d1001"));
    TEST_ASSERT_FALSE(ota_model_matches(NULL, "d1001"));
    TEST_ASSERT_FALSE(ota_model_matches("vellum-d1001", NULL));
}

static void test_overlong_model_is_rejected(void)
{
    TEST_ASSERT_FALSE(ota_model_matches(
        "vellum-model-name-that-does-not-fit", "model-name-that-does-not-fit"));
}

void run_ota_model_guard_tests(void)
{
    RUN_TEST(test_matching_model_is_accepted);
    RUN_TEST(test_wrong_or_generic_model_is_rejected);
    RUN_TEST(test_overlong_model_is_rejected);
}
