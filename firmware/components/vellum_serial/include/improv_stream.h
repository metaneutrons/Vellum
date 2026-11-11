// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

/**
 * @file improv_stream.h
 * @brief Tells Improv frames from console text on one byte stream.
 *
 * The serial port carries binary Improv frames and the interactive console. This
 * state machine takes one byte at a time and says what to do with it: keep
 * waiting, handle a complete frame, or give bytes back to the console. It has no
 * ESP-IDF dependency, so the host tests run it.
 *
 * A frame is `"IMPROV" | version(1)=1 | type(1) in 1..4 | len(1) | payload |
 * checksum(1)`. Bytes stay buffered only while they can still be the start of
 * such a frame. The version and the type come before the length, so text that
 * merely begins with the word is recognised at the first byte that does not fit,
 * not after the number of bytes its next byte happens to announce as a length.
 */

#include <stddef.h>
#include <stdint.h>

/** Largest frame: 6 magic + version + type + length + 255 payload + checksum. */
#define IMPROV_STREAM_FRAME_MAX 265

typedef enum {
    /** The bytes so far can still become a frame: keep feeding. */
    IMPROV_STREAM_NEED_MORE = 0,
    /** A complete, valid frame; `data` is the whole frame. */
    IMPROV_STREAM_FRAME,
    /** Bytes that are not a frame: give `data` back to the console. */
    IMPROV_STREAM_TEXT,
    /** A complete frame whose checksum is wrong: dropped, `data` is the frame. */
    IMPROV_STREAM_BAD_FRAME,
} improv_stream_event_t;

typedef struct {
    improv_stream_event_t event;
    /** Valid until the next `improv_stream_feed()`. */
    const uint8_t *data;
    size_t len;
} improv_stream_result_t;

typedef struct {
    uint8_t buf[IMPROV_STREAM_FRAME_MAX];
    size_t len;
    /** Bytes of `buf` that the last result handed out; removed on the next feed. */
    size_t consumed;
} improv_stream_t;

void improv_stream_init(improv_stream_t *stream);

/**
 * Feeds one byte.
 *
 * After TEXT, bytes that may still begin a frame can stay buffered: "IMPROIMPROV…"
 * hands "IMPRO" back and keeps the "I" that starts the real frame.
 */
improv_stream_result_t improv_stream_feed(improv_stream_t *stream, uint8_t byte);
