// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file test_improv_stream.c
 * @brief Improv frames versus console text on one byte stream.
 *
 * The serial task used to buffer every byte that began with the word IMPROV until the
 * number of bytes its next byte announced as the length had arrived, and then threw
 * them all away. Typing the word swallowed the next lines of console input, and a real
 * frame behind the text stayed hidden. The golden frame is the one the browser client
 * writes for GET_STATE (src/lib/provisioning/improv-serial.ts).
 */
#include "unity_min.h"

#include "improv_stream.h"

#include <stdint.h>
#include <string.h>

typedef struct {
    /* Small on purpose: the string assertion of unity_min.h copies it into a 192-byte message. */
    char text[96];
    size_t text_len;
    int text_overflow;
    int frames;
    int bad_frames;
    uint8_t last_type;
    uint8_t last_payload[256];
    size_t last_payload_len;
} outcome_t;

static void feed(improv_stream_t *stream, const uint8_t *bytes, size_t n, outcome_t *out)
{
    for (size_t i = 0; i < n; i++) {
        improv_stream_result_t r = improv_stream_feed(stream, bytes[i]);
        switch (r.event) {
            case IMPROV_STREAM_NEED_MORE:
                break;
            case IMPROV_STREAM_TEXT:
                if (out->text_len + r.len < sizeof(out->text)) {
                    memcpy(out->text + out->text_len, r.data, r.len);
                    out->text_len += r.len;
                    out->text[out->text_len] = '\0';
                } else {
                    out->text_overflow = 1;
                }
                break;
            case IMPROV_STREAM_FRAME:
                out->frames++;
                out->last_type = r.data[7];
                out->last_payload_len = r.data[8];
                memcpy(out->last_payload, r.data + 9, r.data[8]);
                break;
            case IMPROV_STREAM_BAD_FRAME:
                out->bad_frames++;
                break;
        }
    }
}

static void feed_text(improv_stream_t *stream, const char *text, outcome_t *out)
{
    feed(stream, (const uint8_t *)text, strlen(text), out);
}

static size_t build_frame(uint8_t *out, uint8_t type, const uint8_t *payload, size_t len)
{
    memcpy(out, "IMPROV", 6);
    out[6] = 1;
    out[7] = type;
    out[8] = (uint8_t)len;
    if (len) memcpy(out + 9, payload, len);
    uint8_t sum = 0;
    for (size_t i = 0; i < 9 + len; i++) sum = (uint8_t)(sum + out[i]);
    out[9 + len] = sum;
    return 10 + len;
}

/* RPC_COMMAND GET_STATE exactly as the browser client writes it. */
static const uint8_t GET_STATE[] = {0x49, 0x4d, 0x50, 0x52, 0x4f, 0x56, 0x01, 0x03, 0x02, 0x02, 0x00, 0xe5};

static void test_the_golden_frame_is_a_frame(void)
{
    improv_stream_t s; outcome_t o = {0};
    improv_stream_init(&s);
    feed(&s, GET_STATE, sizeof(GET_STATE), &o);
    TEST_ASSERT_EQUAL_INT(1, o.frames);
    TEST_ASSERT_EQUAL_INT(0x03, o.last_type);
    TEST_ASSERT_EQUAL_INT(2, o.last_payload_len);
    TEST_ASSERT_EQUAL_INT(0, o.text_len);
}

static void test_plain_console_text_goes_straight_back(void)
{
    improv_stream_t s; outcome_t o = {0};
    improv_stream_init(&s);
    feed_text(&s, "wifi Home secret\r\n", &o);
    TEST_ASSERT_EQUAL_INT(0, o.text_overflow);
    TEST_ASSERT_EQUAL_STRING("wifi Home secret\r\n", o.text);
    TEST_ASSERT_EQUAL_INT(0, o.frames);
}

/* The bug: "IMPROV is a word" reads as magic + version ' ' + a length of 115. */
static void test_text_that_contains_the_word_is_not_swallowed(void)
{
    improv_stream_t s; outcome_t o = {0};
    improv_stream_init(&s);
    feed_text(&s, "IMPROV is a word the console may print\r\n", &o);
    TEST_ASSERT_EQUAL_INT(0, o.text_overflow);
    TEST_ASSERT_EQUAL_STRING("IMPROV is a word the console may print\r\n", o.text);
    TEST_ASSERT_EQUAL_INT(0, o.frames);
    TEST_ASSERT_EQUAL_INT(0, o.bad_frames);
}

static void test_a_frame_behind_text_with_the_word_is_found(void)
{
    improv_stream_t s; outcome_t o = {0};
    improv_stream_init(&s);
    feed_text(&s, "IMPROV is a word\r\n", &o);
    feed(&s, GET_STATE, sizeof(GET_STATE), &o);
    TEST_ASSERT_EQUAL_INT(1, o.frames);
    TEST_ASSERT_EQUAL_INT(0, o.text_overflow);
    TEST_ASSERT_EQUAL_STRING("IMPROV is a word\r\n", o.text);
}

static void test_a_header_with_a_wrong_version_or_type_is_text(void)
{
    improv_stream_t s; outcome_t o = {0};
    improv_stream_init(&s);
    const uint8_t wrong_version[] = {'I', 'M', 'P', 'R', 'O', 'V', 0x09, 0x01, 0xff};
    const uint8_t unknown_type[] = {'I', 'M', 'P', 'R', 'O', 'V', 0x01, 0x7f, 0xff};
    feed(&s, wrong_version, sizeof(wrong_version), &o);
    feed(&s, unknown_type, sizeof(unknown_type), &o);
    feed(&s, GET_STATE, sizeof(GET_STATE), &o);
    TEST_ASSERT_EQUAL_INT(1, o.frames);
    TEST_ASSERT_EQUAL_INT(sizeof(wrong_version) + sizeof(unknown_type), o.text_len);
}

static void test_a_frame_between_two_pieces_of_text_keeps_the_order(void)
{
    improv_stream_t s; outcome_t o = {0};
    improv_stream_init(&s);
    feed_text(&s, "abc", &o);
    feed(&s, GET_STATE, sizeof(GET_STATE), &o);
    feed_text(&s, "def", &o);
    TEST_ASSERT_EQUAL_STRING("abcdef", o.text);
    TEST_ASSERT_EQUAL_INT(1, o.frames);
}

/* "IMPRO" and then the real frame: the "I" that starts the frame must not be given back. */
static void test_a_frame_that_starts_inside_a_false_start_is_found(void)
{
    improv_stream_t s; outcome_t o = {0};
    improv_stream_init(&s);
    feed_text(&s, "IMPRO", &o);
    feed(&s, GET_STATE, sizeof(GET_STATE), &o);
    TEST_ASSERT_EQUAL_INT(1, o.frames);
    TEST_ASSERT_EQUAL_STRING("IMPRO", o.text);
}

/* A WIFI_SETTINGS profile can fill a frame to 265 bytes; the buffer used to hold 256. */
static void test_the_largest_frame_arrives(void)
{
    improv_stream_t s; outcome_t o = {0};
    uint8_t payload[255], frame[IMPROV_STREAM_FRAME_MAX];
    for (size_t i = 0; i < sizeof(payload); i++) payload[i] = (uint8_t)(i + 1);
    const size_t n = build_frame(frame, 0x03, payload, sizeof(payload));
    TEST_ASSERT_EQUAL_INT(IMPROV_STREAM_FRAME_MAX, n);
    improv_stream_init(&s);
    feed(&s, frame, n, &o);
    TEST_ASSERT_EQUAL_INT(1, o.frames);
    TEST_ASSERT_EQUAL_INT(255, o.last_payload_len);
    TEST_ASSERT_EQUAL_MEMORY(payload, o.last_payload, 255);
}

static void test_a_wrong_checksum_is_dropped_and_the_next_frame_still_arrives(void)
{
    improv_stream_t s; outcome_t o = {0};
    uint8_t bad[sizeof(GET_STATE)];
    memcpy(bad, GET_STATE, sizeof(bad));
    bad[sizeof(bad) - 1] ^= 0xff;
    improv_stream_init(&s);
    feed(&s, bad, sizeof(bad), &o);
    feed(&s, GET_STATE, sizeof(GET_STATE), &o);
    TEST_ASSERT_EQUAL_INT(1, o.bad_frames);
    TEST_ASSERT_EQUAL_INT(1, o.frames);
    TEST_ASSERT_EQUAL_INT(0, o.text_len);
}

static void test_two_frames_in_a_row_both_arrive(void)
{
    improv_stream_t s; outcome_t o = {0};
    improv_stream_init(&s);
    feed(&s, GET_STATE, sizeof(GET_STATE), &o);
    feed(&s, GET_STATE, sizeof(GET_STATE), &o);
    TEST_ASSERT_EQUAL_INT(2, o.frames);
}

static void test_typing_only_the_start_of_the_word_does_not_hide_the_next_line(void)
{
    improv_stream_t s; outcome_t o = {0};
    improv_stream_init(&s);
    feed_text(&s, "IMP\r\nhelp\r\n", &o);
    TEST_ASSERT_EQUAL_STRING("IMP\r\nhelp\r\n", o.text);
}

void run_improv_stream_tests(void)
{
    RUN_TEST(test_the_golden_frame_is_a_frame);
    RUN_TEST(test_plain_console_text_goes_straight_back);
    RUN_TEST(test_text_that_contains_the_word_is_not_swallowed);
    RUN_TEST(test_a_frame_behind_text_with_the_word_is_found);
    RUN_TEST(test_a_header_with_a_wrong_version_or_type_is_text);
    RUN_TEST(test_a_frame_between_two_pieces_of_text_keeps_the_order);
    RUN_TEST(test_a_frame_that_starts_inside_a_false_start_is_found);
    RUN_TEST(test_the_largest_frame_arrives);
    RUN_TEST(test_a_wrong_checksum_is_dropped_and_the_next_frame_still_arrives);
    RUN_TEST(test_two_frames_in_a_row_both_arrive);
    RUN_TEST(test_typing_only_the_start_of_the_word_does_not_hide_the_next_line);
}
