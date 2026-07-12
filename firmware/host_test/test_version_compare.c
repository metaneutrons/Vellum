// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file test_version_compare.c
 * @brief Parity tests for the firmware OTA version-compare contract.
 *
 * The golden vector table below is the SHARED contract between the firmware
 * downgrade guard (ota_manager.c) and the server OTA-offer logic
 * (src/lib/firmware.ts compareSemver, mirrored in src/lib/__tests__/
 * firmware.test.ts). Every row must produce the same ordering on both stacks.
 */
#include "unity_min.h"
#include "version_compare.h"

void test_parse_mmp_basic(void)
{
    int o[3];
    vc_parse_mmp("1.2.3", o);
    TEST_ASSERT_EQUAL_INT(1, o[0]);
    TEST_ASSERT_EQUAL_INT(2, o[1]);
    TEST_ASSERT_EQUAL_INT(3, o[2]);
}

void test_parse_mmp_v_prefix_and_suffixes(void)
{
    int o[3];
    vc_parse_mmp("v2.0.1", o);
    TEST_ASSERT_EQUAL_INT(2, o[0]);
    TEST_ASSERT_EQUAL_INT(0, o[1]);
    TEST_ASSERT_EQUAL_INT(1, o[2]);

    /* Pre-release / build metadata is ignored — parses to the release mmp. */
    vc_parse_mmp("1.4.2-beta.7+abc123", o);
    TEST_ASSERT_EQUAL_INT(1, o[0]);
    TEST_ASSERT_EQUAL_INT(4, o[1]);
    TEST_ASSERT_EQUAL_INT(2, o[2]);
}

void test_parse_mmp_partial_and_garbage(void)
{
    int o[3];
    vc_parse_mmp("1", o);
    TEST_ASSERT_EQUAL_INT(1, o[0]);
    TEST_ASSERT_EQUAL_INT(0, o[1]);
    TEST_ASSERT_EQUAL_INT(0, o[2]);

    vc_parse_mmp("1.2", o);
    TEST_ASSERT_EQUAL_INT(1, o[0]);
    TEST_ASSERT_EQUAL_INT(2, o[1]);
    TEST_ASSERT_EQUAL_INT(0, o[2]);

    vc_parse_mmp("garbage", o);
    TEST_ASSERT_EQUAL_INT(0, o[0]);
    TEST_ASSERT_EQUAL_INT(0, o[1]);
    TEST_ASSERT_EQUAL_INT(0, o[2]);

    vc_parse_mmp("", o);
    TEST_ASSERT_EQUAL_INT(0, o[0]);

    vc_parse_mmp(NULL, o);
    TEST_ASSERT_EQUAL_INT(0, o[0]);
}

/* Golden vector table — identical to the server's compareSemver expectations. */
void test_compare_mmp_golden(void)
{
    struct { const char *a, *b; int sign; } v[] = {
        {"1.2.0", "1.1.0", +1},
        {"2.0.0", "1.9.9", +1},
        {"1.0.1", "1.0.0", +1},
        {"1.0.0", "1.0.0",  0},
        {"1.0.0", "1.1.0", -1},
        {"0.9.0", "1.0.0", -1},
        {"v1.2.0", "v1.1.0", +1},
        {"v1.0.0", "v1.0.0", 0},
        {"1.10.0", "1.9.0", +1},   /* numeric, not lexical, ordering */
        {"1.2.3-beta.1", "1.2.3", 0}, /* pre-release == release at mmp level */
        {"1.2.3", "1.2.3-beta.1", 0},
    };
    for (size_t i = 0; i < sizeof(v) / sizeof(v[0]); i++) {
        TEST_ASSERT_SIGN(v[i].sign, vc_compare_mmp(v[i].a, v[i].b));
    }
}

void test_is_downgrade(void)
{
    /* Strictly-older offered vs running → downgrade. */
    TEST_ASSERT_TRUE(vc_is_downgrade("1.0.0", "1.1.0"));
    TEST_ASSERT_TRUE(vc_is_downgrade("1.9.9", "2.0.0"));
    TEST_ASSERT_TRUE(vc_is_downgrade("1.2.2", "1.2.3"));

    /* Equal or newer → not a downgrade. */
    TEST_ASSERT_FALSE(vc_is_downgrade("1.1.0", "1.1.0"));
    TEST_ASSERT_FALSE(vc_is_downgrade("1.2.0", "1.1.0"));
    TEST_ASSERT_FALSE(vc_is_downgrade("2.0.0", "1.9.9"));

    /* Pre-release-only difference is NOT a downgrade (same mmp). */
    TEST_ASSERT_FALSE(vc_is_downgrade("1.2.3-beta.1", "1.2.3"));
    TEST_ASSERT_FALSE(vc_is_downgrade("1.2.3", "1.2.3-beta.9"));

    /* NULL inputs are safe. */
    TEST_ASSERT_FALSE(vc_is_downgrade(NULL, "1.0.0"));
    TEST_ASSERT_FALSE(vc_is_downgrade("1.0.0", NULL));
}

void run_version_compare_tests(void)
{
    RUN_TEST(test_parse_mmp_basic);
    RUN_TEST(test_parse_mmp_v_prefix_and_suffixes);
    RUN_TEST(test_parse_mmp_partial_and_garbage);
    RUN_TEST(test_compare_mmp_golden);
    RUN_TEST(test_is_downgrade);
}
