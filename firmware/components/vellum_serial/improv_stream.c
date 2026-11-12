// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "improv_stream.h"

#include <stdbool.h>
#include <string.h>

#define MAGIC "IMPROV"
#define MAGIC_LEN 6
#define VERSION 1
#define TYPE_MIN 0x01
#define TYPE_MAX 0x04
#define HEADER_LEN 9 /* magic + version + type + length */

/* Can `n` bytes still be the start of a frame? Only what is known is checked: the magic
 * as far as it has arrived, then the version, then the type. */
static bool viable(const uint8_t *bytes, size_t n)
{
    const size_t magic_bytes = n < MAGIC_LEN ? n : MAGIC_LEN;
    if (memcmp(bytes, MAGIC, magic_bytes) != 0) return false;
    if (n > MAGIC_LEN && bytes[MAGIC_LEN] != VERSION) return false;
    if (n > MAGIC_LEN + 1 && (bytes[MAGIC_LEN + 1] < TYPE_MIN || bytes[MAGIC_LEN + 1] > TYPE_MAX)) {
        return false;
    }
    return true;
}

void improv_stream_init(improv_stream_t *stream)
{
    stream->len = 0;
    stream->consumed = 0;
}

improv_stream_result_t improv_stream_feed(improv_stream_t *stream, uint8_t byte)
{
    improv_stream_result_t result = {IMPROV_STREAM_NEED_MORE, NULL, 0};

    /* Drop what the last result handed out. */
    if (stream->consumed > 0) {
        memmove(stream->buf, stream->buf + stream->consumed, stream->len - stream->consumed);
        stream->len -= stream->consumed;
        stream->consumed = 0;
    }
    stream->buf[stream->len++] = byte;

    if (!viable(stream->buf, stream->len)) {
        /* Give back the shortest start that leaves a suffix which may still be a frame. */
        size_t keep_from = 1;
        while (keep_from < stream->len && !viable(stream->buf + keep_from, stream->len - keep_from)) {
            keep_from++;
        }
        result.event = IMPROV_STREAM_TEXT;
        result.data = stream->buf;
        result.len = keep_from;
        stream->consumed = keep_from;
        return result;
    }

    if (stream->len > HEADER_LEN) {
        const size_t total = (size_t)HEADER_LEN + stream->buf[HEADER_LEN - 1] + 1;
        if (stream->len == total) {
            uint8_t sum = 0;
            for (size_t i = 0; i < total - 1; i++) sum = (uint8_t)(sum + stream->buf[i]);
            result.event = sum == stream->buf[total - 1] ? IMPROV_STREAM_FRAME : IMPROV_STREAM_BAD_FRAME;
            result.data = stream->buf;
            result.len = total;
            stream->consumed = total;
        }
    }
    return result;
}
