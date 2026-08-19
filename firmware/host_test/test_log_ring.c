// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "unity_min.h"
#include "log_ring.h"

#include <stdio.h>
#include <string.h>

#define STORAGE 256

static log_ring_t ring;
static char storage[STORAGE];

static void reset_ring(size_t context)
{
    memset(storage, 0, sizeof(storage));
    log_ring_init(&ring, storage, sizeof(storage), context);
}

static void put(const char *line, bool serious)
{
    log_ring_append(&ring, line, strlen(line), serious, NULL, 0, NULL);
}

/* A healthy display must send nothing at all: that is what keeps diagnostics
 * from becoming a fleet-wide firehose. */
static void test_routine_lines_do_not_arm_an_upload(void)
{
    reset_ring(128);
    put("I (10) main: Requesting render\n", false);
    put("I (20) http: GET /render 200\n", false);
    TEST_ASSERT_FALSE(log_ring_should_upload(&ring));
}

static void test_a_warning_arms_an_upload_with_its_context(void)
{
    reset_ring(128);
    put("I (10) main: Requesting render\n", false);
    put("W (20) panel: No memory for the decode buffer\n", true);
    TEST_ASSERT_TRUE(log_ring_should_upload(&ring));

    char out[STORAGE];
    const size_t len = log_ring_peek_unsent(&ring, out, sizeof(out));
    TEST_ASSERT_TRUE(len > 0);
    /* The preceding routine line travels with the warning: a failure without its
     * surroundings often cannot be read at all. */
    TEST_ASSERT_TRUE(strstr(out, "Requesting render") != NULL);
    TEST_ASSERT_TRUE(strstr(out, "No memory") != NULL);
}

static void test_context_window_is_trimmed_while_nothing_is_wrong(void)
{
    reset_ring(64);
    for (int i = 0; i < 20; i++) put("I (10) main: a routine line of some length\n", false);
    /* Without trimming the unsent span would grow until the next warning and
     * carry minutes of routine polling with it. */
    TEST_ASSERT_TRUE(ring.unsent <= 64 + 44);
}

static void test_repeats_are_folded(void)
{
    reset_ring(256);
    for (int i = 0; i < 5; i++) put("W (10) panel: same failure\n", true);
    put("I (60) main: something else\n", false);

    char out[STORAGE];
    log_ring_snapshot(&ring, out, sizeof(out));
    /* Five identical warnings become one line plus a count, which is what turns a
     * wedged display from thousands of lines into a handful. */
    TEST_ASSERT_TRUE(strstr(out, "(repeated 4x)") != NULL);
}

static void test_differing_timestamps_still_count_as_repeats(void)
{
    reset_ring(256);
    put("W (10) panel: same failure\n", true);
    put("W (70) panel: same failure\n", true);
    put("I (99) main: other\n", false);

    char out[STORAGE];
    log_ring_snapshot(&ring, out, sizeof(out));
    TEST_ASSERT_TRUE(strstr(out, "(repeated 1x)") != NULL);
}

/* The upload's own failure is a warning, and a warning is what arms an upload, so
 * without suspension a device would report forever about being unable to report. */
static void test_a_suspended_trigger_records_without_arming(void)
{
    reset_ring(128);
    ring.trigger_suspended = true;
    put("W (10) http: POST /logs 404\n", true);
    TEST_ASSERT_FALSE(log_ring_should_upload(&ring));

    char out[STORAGE];
    log_ring_snapshot(&ring, out, sizeof(out));
    TEST_ASSERT_TRUE(strstr(out, "POST /logs 404") != NULL);
}

static void test_confirming_clears_the_pending_state(void)
{
    reset_ring(128);
    put("W (10) panel: failure\n", true);
    char out[STORAGE];
    const size_t len = log_ring_peek_unsent(&ring, out, sizeof(out));
    log_ring_confirm(&ring, len);
    TEST_ASSERT_FALSE(log_ring_should_upload(&ring));
    TEST_ASSERT_EQUAL_INT(0, (int)ring.unsent);
}

/* A lost response must cost a discarded duplicate, never a gap: an unconfirmed
 * span stays on offer unchanged. */
static void test_an_unconfirmed_span_is_offered_again(void)
{
    reset_ring(128);
    put("W (10) panel: failure\n", true);
    char first[STORAGE], second[STORAGE];
    const size_t a = log_ring_peek_unsent(&ring, first, sizeof(first));
    const size_t b = log_ring_peek_unsent(&ring, second, sizeof(second));
    TEST_ASSERT_EQUAL_INT((int)a, (int)b);
    TEST_ASSERT_EQUAL_STRING(first, second);
}

/* Wrap-around is where a ring buffer hides its bugs: a snapshot must never begin
 * mid-message, and it must stay within the buffer. */
static void test_wrapping_drops_whole_lines_only(void)
{
    reset_ring(4096);
    /* Distinct messages on purpose: identical ones are folded, so an earlier
     * version of this test never made the ring wrap at all. */
    for (int i = 0; i < 40; i++) {
        char line[64];
        snprintf(line, sizeof(line), "I (10) main: line %d that is long enough to wrap\n", i);
        put(line, false);
    }
    char out[STORAGE * 2];
    const size_t len = log_ring_snapshot(&ring, out, sizeof(out));
    TEST_ASSERT_TRUE(len <= STORAGE);
    TEST_ASSERT_TRUE(ring.dropped > 0);
    /* Every retained line is whole, so the text starts at a level letter. */
    TEST_ASSERT_TRUE(out[0] == 'I' || out[0] == ' ');
    TEST_ASSERT_EQUAL_INT('\n', out[len - 1]);
}

static void test_a_line_longer_than_the_ring_cannot_overflow_it(void)
{
    reset_ring(4096);
    char huge[STORAGE * 3];
    memset(huge, 'x', sizeof(huge) - 1);
    huge[sizeof(huge) - 1] = '\0';
    log_ring_append(&ring, huge, strlen(huge), false, NULL, 0, NULL);
    TEST_ASSERT_TRUE(ring.used <= STORAGE);
}

/* Nothing that authenticates may reach flash or the server. */
static void test_long_hex_runs_are_redacted(void)
{
    char line[LOG_RING_LINE_MAX];
    snprintf(line, sizeof(line), "I (10) auth: token %s ok",
             "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const size_t len = log_ring_redact(line, strlen(line));
    TEST_ASSERT_EQUAL_INT((int)strlen(line), (int)len);
    TEST_ASSERT_TRUE(strstr(line, "0123456789abcdef") == NULL);
    TEST_ASSERT_TRUE(strstr(line, "********") != NULL);
    /* The surrounding text stays readable, or the line would be useless. */
    TEST_ASSERT_TRUE(strstr(line, "auth: token") != NULL);
    TEST_ASSERT_TRUE(strstr(line, "ok") != NULL);
}

/* SSIDs, URLs, MACs and command ids are needed to read a failure at all, and none
 * of them authenticates. */
static void test_diagnostic_values_survive_redaction(void)
{
    char line[LOG_RING_LINE_MAX];
    snprintf(line, sizeof(line),
             "I (10) http: server https://vellum.example.com mac 58E6C50F4054 id "
             "123e4567-e89b-12d3-a456-426614174000");
    log_ring_redact(line, strlen(line));
    TEST_ASSERT_TRUE(strstr(line, "https://vellum.example.com") != NULL);
    TEST_ASSERT_TRUE(strstr(line, "58E6C50F4054") != NULL);
    TEST_ASSERT_TRUE(strstr(line, "123e4567-e89b-12d3-a456-426614174000") != NULL);
}

static void test_level_is_found_behind_a_colour_escape(void)
{
    TEST_ASSERT_EQUAL_INT('W', log_ring_level_of("W (10) tag: msg"));
    TEST_ASSERT_EQUAL_INT('E', log_ring_level_of("\033[0;31mE (10) tag: msg\033[0m"));
    TEST_ASSERT_EQUAL_INT('I', log_ring_level_of("\033[0;32mI (10) tag: msg"));
}

void run_log_ring_tests(void)
{
    RUN_TEST(test_routine_lines_do_not_arm_an_upload);
    RUN_TEST(test_a_warning_arms_an_upload_with_its_context);
    RUN_TEST(test_context_window_is_trimmed_while_nothing_is_wrong);
    RUN_TEST(test_repeats_are_folded);
    RUN_TEST(test_differing_timestamps_still_count_as_repeats);
    RUN_TEST(test_a_suspended_trigger_records_without_arming);
    RUN_TEST(test_confirming_clears_the_pending_state);
    RUN_TEST(test_an_unconfirmed_span_is_offered_again);
    RUN_TEST(test_wrapping_drops_whole_lines_only);
    RUN_TEST(test_a_line_longer_than_the_ring_cannot_overflow_it);
    RUN_TEST(test_long_hex_runs_are_redacted);
    RUN_TEST(test_diagnostic_values_survive_redaction);
    RUN_TEST(test_level_is_found_behind_a_colour_escape);
}
