// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file test_key_revocation.c
 * @brief Contract tests for OTA signing-key revocation (CSV membership).
 *
 * key_is_revoked() drives whether a trusted OTA signing key is still accepted.
 * The dangerous failure is a substring false-positive/negative around
 * exact-length matching, so those cases are exercised explicitly.
 */
#include "unity_min.h"
#include "revocation.h"

void test_rev_empty_inputs(void)
{
    TEST_ASSERT_FALSE(rev_csv_contains_token(NULL, "k1"));
    TEST_ASSERT_FALSE(rev_csv_contains_token("", "k1"));
    TEST_ASSERT_FALSE(rev_csv_contains_token("k1,k2", NULL));
    TEST_ASSERT_FALSE(rev_csv_contains_token("k1,k2", ""));
}

void test_rev_single_and_middle(void)
{
    TEST_ASSERT_TRUE(rev_csv_contains_token("key-2024", "key-2024"));
    TEST_ASSERT_TRUE(rev_csv_contains_token("k1,k2,k3", "k1"));
    TEST_ASSERT_TRUE(rev_csv_contains_token("k1,k2,k3", "k2")); /* middle */
    TEST_ASSERT_TRUE(rev_csv_contains_token("k1,k2,k3", "k3")); /* last */
}

void test_rev_not_present(void)
{
    TEST_ASSERT_FALSE(rev_csv_contains_token("k1,k2,k3", "k4"));
    TEST_ASSERT_FALSE(rev_csv_contains_token("alpha,beta", "gamma"));
}

/* The security-critical case: a revoked-list entry must not match by prefix or
 * substring. If "key1" matched "key10", revoking key10 would wrongly revoke
 * key1 — and, worse, checking key1 against a list holding only key10 must fail. */
void test_rev_no_substring_falsematch(void)
{
    TEST_ASSERT_FALSE(rev_csv_contains_token("key10", "key1"));   /* prefix */
    TEST_ASSERT_FALSE(rev_csv_contains_token("key10,key100", "key1"));
    TEST_ASSERT_FALSE(rev_csv_contains_token("xkey1", "key1"));   /* suffix */
    TEST_ASSERT_FALSE(rev_csv_contains_token("key1", "key10"));   /* id longer than token */
    TEST_ASSERT_TRUE(rev_csv_contains_token("key1,key10", "key10")); /* but exact still matches */
    TEST_ASSERT_TRUE(rev_csv_contains_token("key1,key10", "key1"));
}

void test_rev_whitespace_tolerated(void)
{
    TEST_ASSERT_TRUE(rev_csv_contains_token("k1, k2, k3", "k2"));   /* leading space */
    TEST_ASSERT_TRUE(rev_csv_contains_token("k1 , k2 , k3", "k2")); /* surrounding spaces */
    TEST_ASSERT_TRUE(rev_csv_contains_token(" k1", "k1"));          /* leading space, single */
    TEST_ASSERT_TRUE(rev_csv_contains_token("k1 ", "k1"));          /* trailing space, single */
}

void test_rev_odd_separators(void)
{
    TEST_ASSERT_TRUE(rev_csv_contains_token(",,k1,,k2,,", "k2"));   /* repeated commas */
    TEST_ASSERT_FALSE(rev_csv_contains_token(",, ,,", "k1"));       /* only separators */
    TEST_ASSERT_TRUE(rev_csv_contains_token("k1,,", "k1"));         /* trailing commas */
}

void run_key_revocation_tests(void)
{
    RUN_TEST(test_rev_empty_inputs);
    RUN_TEST(test_rev_single_and_middle);
    RUN_TEST(test_rev_not_present);
    RUN_TEST(test_rev_no_substring_falsematch);
    RUN_TEST(test_rev_whitespace_tolerated);
    RUN_TEST(test_rev_odd_separators);
}
