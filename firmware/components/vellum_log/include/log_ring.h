// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/**
 * The pure logic behind diagnostic log retention: a line ring, redaction, folding
 * of repeats, and the rule that decides when a batch is worth sending.
 *
 * Deliberately free of ESP-IDF. The wrap-around arithmetic, the fold counter and
 * the context window are exactly the parts that are cheap to get wrong and
 * expensive in the field, so they are covered by host tests. vellum_log.c adds
 * what cannot be tested on a host: the esp_log hook, the spinlock and the RTC
 * region.
 *
 * One ring per device, so this owns its state rather than handing a struct
 * around. Callers ask questions instead of reading fields, which keeps the tests
 * honest: they assert on behaviour, not on layout.
 */

#define LOG_RING_LINE_MAX 220

/** Point the ring at its storage and forget everything held so far. */
void log_ring_init(char *storage, size_t size, size_t context_bytes);

/** Replace anything that authenticates. Returns the new length.
 *  Long hex runs (32 or more) are tokens, signatures and fingerprints. SSIDs and
 *  URLs are kept: a transport failure cannot be read without them. */
size_t log_ring_redact(char *line, size_t len);

/** Record one line. `folded` receives the text appended for a run of repeats, if
 *  any, so the caller can mirror it into a second sink. */
void log_ring_append(const char *line, size_t len, bool serious, char *folded,
                     size_t folded_len, size_t *folded_out);

/** True when there is something worth uploading: a warning or error is pending,
 *  or the operator asked for everything. */
bool log_ring_should_upload(void);

size_t log_ring_snapshot(char *out, size_t out_len);

/** Copy the unsent span, oldest first. Returns the bytes copied. */
size_t log_ring_peek_unsent(char *out, size_t out_len);

/** Drop `len` acknowledged bytes from the front of the unsent span. */
void log_ring_confirm(size_t len);

/** Report every line, not only warnings and errors. */
void log_ring_set_ship_everything(bool enabled);

/** Stop warnings from arming another upload while one is in flight. Recording
 *  continues; only the trigger is held. */
void log_ring_set_trigger_suspended(bool suspended);

/** Bytes waiting to be reported, for tests and diagnostics. */
size_t log_ring_unsent_bytes(void);

/** Lines discarded to make room, for tests and diagnostics. */
uint32_t log_ring_dropped_lines(void);

/** The message without its timestamp, for comparing one line against the last. */
const char *log_ring_message_of(const char *line);

/** The level letter, which sits behind the colour escape when colours are on. */
char log_ring_level_of(const char *line);
