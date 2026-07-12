// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file unity_min.h
 * @brief Minimal Unity-compatible assertion harness for host tests.
 *
 * A tiny, self-contained subset of the ThrowTheSwitch Unity API (the framework
 * ESP-IDF bundles for host tests). It provides just the macros these suites use
 * so the tests read identically to on-target Unity tests, while building with a
 * plain host compiler and no ESP-IDF dependency. See README.md for the rationale.
 */
#pragma once

#include <stdio.h>
#include <string.h>
#include <stdint.h>

/* Shared across every test translation unit — RUN_TEST (in the test_*.c files)
 * and UNITY_END (in test_main.c) MUST see the same counters, or a failure in one
 * suite would not affect the process exit code. Exactly one TU must invoke
 * UNITY_DEFINE_GLOBALS() at file scope to provide the definitions. */
extern int unity_tests_run;
extern int unity_tests_failed;
extern int unity_current_failed;
extern const char *unity_current_name;

#define UNITY_DEFINE_GLOBALS()                                                 \
  int unity_tests_run = 0;                                                     \
  int unity_tests_failed = 0;                                                  \
  int unity_current_failed = 0;                                                \
  const char *unity_current_name = ""

#define UNITY_BEGIN()                                                          \
  do {                                                                         \
    unity_tests_run = 0;                                                        \
    unity_tests_failed = 0;                                                     \
  } while (0)

#define UNITY_END()                                                            \
  (printf("\n-----------------------\n%d Tests %d Failures\n%s\n",             \
          unity_tests_run, unity_tests_failed,                                 \
          unity_tests_failed ? "FAIL" : "OK"),                                 \
   unity_tests_failed)

#define RUN_TEST(fn)                                                           \
  do {                                                                         \
    unity_current_failed = 0;                                                  \
    unity_current_name = #fn;                                                  \
    unity_tests_run++;                                                         \
    fn();                                                                      \
    if (unity_current_failed) {                                               \
      unity_tests_failed++;                                                    \
      printf("[FAIL] %s\n", #fn);                                             \
    } else {                                                                   \
      printf("[PASS] %s\n", #fn);                                             \
    }                                                                          \
  } while (0)

#define UNITY_FAIL_(msg)                                                       \
  do {                                                                         \
    unity_current_failed = 1;                                                  \
    printf("  %s:%d: %s (in %s)\n", __FILE__, __LINE__, (msg),                 \
           unity_current_name);                                               \
  } while (0)

#define TEST_ASSERT_TRUE(cond)                                                 \
  do {                                                                         \
    if (!(cond)) UNITY_FAIL_("expected TRUE: " #cond);                         \
  } while (0)

#define TEST_ASSERT_FALSE(cond)                                                \
  do {                                                                         \
    if (cond) UNITY_FAIL_("expected FALSE: " #cond);                           \
  } while (0)

#define TEST_ASSERT_EQUAL_INT(expected, actual)                               \
  do {                                                                         \
    long _e = (long)(expected), _a = (long)(actual);                          \
    if (_e != _a) {                                                            \
      char _b[128];                                                            \
      snprintf(_b, sizeof(_b), "expected %ld, got %ld", _e, _a);              \
      UNITY_FAIL_(_b);                                                         \
    }                                                                          \
  } while (0)

/** Sign-only comparison: asserts (actual <=> 0) matches (expected <=> 0). */
#define TEST_ASSERT_SIGN(expected, actual)                                    \
  do {                                                                         \
    long _e = (long)(expected), _a = (long)(actual);                          \
    int _es = (_e > 0) - (_e < 0), _as = (_a > 0) - (_a < 0);                 \
    if (_es != _as) {                                                          \
      char _b[128];                                                            \
      snprintf(_b, sizeof(_b), "expected sign %d, got %d (value %ld)",        \
               _es, _as, _a);                                                  \
      UNITY_FAIL_(_b);                                                         \
    }                                                                          \
  } while (0)

#define TEST_ASSERT_EQUAL_STRING(expected, actual)                            \
  do {                                                                         \
    if (strcmp((expected), (actual)) != 0) {                                   \
      char _b[192];                                                            \
      snprintf(_b, sizeof(_b), "expected \"%s\", got \"%s\"", (expected),     \
               (actual));                                                      \
      UNITY_FAIL_(_b);                                                         \
    }                                                                          \
  } while (0)

#define TEST_ASSERT_EQUAL_MEMORY(expected, actual, len)                       \
  do {                                                                         \
    if (memcmp((expected), (actual), (len)) != 0)                              \
      UNITY_FAIL_("memory mismatch: " #expected " != " #actual);              \
  } while (0)
