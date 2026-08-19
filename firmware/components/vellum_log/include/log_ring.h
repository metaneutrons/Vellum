// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/**
 * The pure logic behind diagnostic log retention: a line ring, redaction,
 * folding of repeats, and the rule that decides when a batch is worth sending.
 *
 * Deliberately free of ESP-IDF: the wrap-around arithmetic, the fold counter and
 * the context window are exactly the parts that are cheap to get wrong and
 * expensive in the field, so they are covered by host tests. vellum_log.c adds
 * the parts that cannot be tested on a host — the esp_log hook, the spinlock and
 * the RTC region.
 */

#define LOG_RING_LINE_MAX 220

typedef struct {
    char *buf;
    size_t size;
    size_t head;             /* next write position */
    size_t used;             /* bytes held */
    size_t unsent;           /* bytes not yet acknowledged, counted back from head */
    size_t context_bytes;    /* unsent history kept while nothing is wrong */
    uint32_t dropped;        /* lines discarded to make room */
    bool pending_serious;    /* a warning or error is waiting to be reported */
    bool ship_everything;    /* operator raised this device for debugging */
    bool trigger_suspended;  /* an upload is in flight; its own failures must not re-arm it */
    char last_body[LOG_RING_LINE_MAX];
    uint32_t repeat;         /* consecutive identical messages folded so far */
} log_ring_t;

void log_ring_init(log_ring_t *ring, char *storage, size_t size, size_t context_bytes);

/** Replace anything that authenticates. Returns the new length.
 *  Long hex runs (32 or more) are tokens, signatures and fingerprints; SSIDs and
 *  URLs are kept, since a transport failure cannot be read without them. */
size_t log_ring_redact(char *line, size_t len);

/** Record one line. `folded` receives the text appended for a run of repeats, if
 *  any, so the caller can mirror it into a second sink. */
void log_ring_append(log_ring_t *ring, const char *line, size_t len, bool serious,
                     char *folded, size_t folded_len, size_t *folded_out);

/** True when there is something worth uploading: a warning or error is pending,
 *  or the operator asked for everything. */
bool log_ring_should_upload(const log_ring_t *ring);

size_t log_ring_snapshot(const log_ring_t *ring, char *out, size_t out_len);

/** Copy the unsent span, oldest first. Returns the bytes copied. */
size_t log_ring_peek_unsent(const log_ring_t *ring, char *out, size_t out_len);

/** Drop `len` acknowledged bytes from the front of the unsent span. */
void log_ring_confirm(log_ring_t *ring, size_t len);

/** The message without its timestamp, for comparing one line against the last. */
const char *log_ring_message_of(const char *line);

/** The level letter, which sits behind the colour escape when colours are on. */
char log_ring_level_of(const char *line);
