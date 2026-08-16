// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/** Regression coverage for render response metadata. The ESP-IDF request-header
 * getter was previously used for response headers, leaving devices on their
 * 900-second fallback even when the server instructed them to poll every minute. */
#include "unity_min.h"
#include "response_headers.h"

#include <string.h>

void test_response_headers_capture_render_contract(void)
{
    vellum_response_headers_t headers;
    vellum_response_headers_init(&headers);

    vellum_response_headers_capture(&headers, "X-Sleep-Duration", "67");
    vellum_response_headers_capture(&headers, "X-Error-Backoff", "60,300,900,3600");
    vellum_response_headers_capture(&headers, "ETag", "a1b2c3d4e5f60718");

    TEST_ASSERT_EQUAL_INT(67, headers.sleep_duration);
    TEST_ASSERT_TRUE(strcmp("60,300,900,3600", headers.error_backoff) == 0);
    TEST_ASSERT_TRUE(strcmp("a1b2c3d4e5f60718", headers.etag) == 0);
}

void test_response_headers_names_are_case_insensitive(void)
{
    vellum_response_headers_t headers;
    vellum_response_headers_init(&headers);

    vellum_response_headers_capture(&headers, "x-sleep-duration", " 60 ");
    vellum_response_headers_capture(&headers, "etag", "stable-hash");

    TEST_ASSERT_EQUAL_INT(60, headers.sleep_duration);
    TEST_ASSERT_TRUE(strcmp("stable-hash", headers.etag) == 0);
}

void test_response_headers_reject_invalid_sleep_durations(void)
{
    const char *invalid[] = { "", "0", "-1", "60 seconds", "999999999999", "86401" };
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
        vellum_response_headers_t headers;
        vellum_response_headers_init(&headers);
        vellum_response_headers_capture(&headers, "X-Sleep-Duration", invalid[i]);
        TEST_ASSERT_EQUAL_INT(0, headers.sleep_duration);
    }
}

void test_response_headers_reject_oversized_values_without_truncating(void)
{
    vellum_response_headers_t headers;
    vellum_response_headers_init(&headers);
    char oversized[VELLUM_ERROR_BACKOFF_HEADER_LEN + 1];
    memset(oversized, '1', sizeof(oversized) - 1);
    oversized[sizeof(oversized) - 1] = '\0';

    vellum_response_headers_capture(&headers, "X-Error-Backoff", oversized);
    vellum_response_headers_capture(&headers, "ETag", oversized);

    TEST_ASSERT_TRUE(headers.error_backoff[0] == '\0');
    TEST_ASSERT_TRUE(headers.etag[0] == '\0');
}

void test_response_headers_ignore_unknown_and_null_input(void)
{
    vellum_response_headers_t headers;
    vellum_response_headers_init(&headers);
    vellum_response_headers_capture(&headers, "Server", "proxy");
    vellum_response_headers_capture(&headers, NULL, "60");
    vellum_response_headers_capture(NULL, "X-Sleep-Duration", "60");

    TEST_ASSERT_EQUAL_INT(0, headers.sleep_duration);
    TEST_ASSERT_TRUE(headers.error_backoff[0] == '\0');
    TEST_ASSERT_TRUE(headers.etag[0] == '\0');
}

void run_response_headers_tests(void)
{
    RUN_TEST(test_response_headers_capture_render_contract);
    RUN_TEST(test_response_headers_names_are_case_insensitive);
    RUN_TEST(test_response_headers_reject_invalid_sleep_durations);
    RUN_TEST(test_response_headers_reject_oversized_values_without_truncating);
    RUN_TEST(test_response_headers_ignore_unknown_and_null_input);
}
