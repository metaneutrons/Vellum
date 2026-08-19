// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "log_ring.h"

#include <stdio.h>

void log_ring_init(log_ring_t *ring, char *storage, size_t size, size_t context_bytes)
{
    ring->buf = storage;
    ring->size = size;
    ring->head = 0;
    ring->used = 0;
    ring->unsent = 0;
    ring->context_bytes = context_bytes;
    ring->dropped = 0;
    ring->pending_serious = false;
    ring->ship_everything = false;
    ring->trigger_suspended = false;
    ring->last_body[0] = '\0';
    ring->repeat = 0;
}

size_t log_ring_redact(char *line, size_t len)
{
    size_t run = 0;
    for (size_t i = 0; i <= len; i++) {
        const char c = line[i];
        const bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        if (hex && i < len) {
            run++;
            continue;
        }
        if (run >= 32) {
            /* Replace the run with a fixed marker and pull the remainder forward.
             * The copy only ever moves left and shrinks the line, and the length
             * is carried rather than re-measured, so the bound stays local. */
            const size_t start = i - run;
            const size_t rest = len - i;
            for (size_t k = 0; k < 8; k++) line[start + k] = '*';
            for (size_t k = 0; k <= rest; k++) line[start + 8 + k] = line[i + k];
            len = start + 8 + rest;
            i = start + 8;
        }
        run = 0;
        if (i >= len) break;
    }
    line[len] = '\0';
    return len;
}

const char *log_ring_message_of(const char *line)
{
    for (size_t i = 0; line[i] != '\0'; i++) {
        if (line[i] == ')') return line + i + 1;
    }
    return line;
}

char log_ring_level_of(const char *line)
{
    if (line[0] != '\033') return line[0];
    for (size_t i = 0; line[i] != '\0'; i++) {
        if (line[i] == 'm') return line[i + 1];
    }
    return '\0';
}

/* Drops whole lines until `need` bytes are free. A snapshot never begins
 * mid-message: half a line is worse than a missing one when the reader is trying
 * to decide what failed. */
static void make_room(log_ring_t *ring, size_t need)
{
    while (ring->size - ring->used < need && ring->used > 0) {
        size_t tail = (ring->head + ring->size - ring->used) % ring->size;
        size_t scanned = 0;
        while (scanned < ring->used && ring->buf[tail] != '\n') {
            tail = (tail + 1) % ring->size;
            scanned++;
        }
        scanned++; /* the newline itself */
        if (scanned > ring->used) scanned = ring->used;
        ring->used -= scanned;
        ring->dropped++;
        if (ring->unsent > ring->used) ring->unsent = ring->used;
    }
}

static void raw_append(log_ring_t *ring, const char *text, size_t len)
{
    if (len > ring->size) len = ring->size;
    make_room(ring, len);
    for (size_t i = 0; i < len; i++) {
        ring->buf[ring->head] = text[i];
        ring->head = (ring->head + 1) % ring->size;
    }
    ring->used += len;
    if (ring->used > ring->size) ring->used = ring->size;
    ring->unsent += len;
    if (ring->unsent > ring->used) ring->unsent = ring->used;

    /* Nothing is wrong, so keep only a context window: without this the unsent
     * span would grow until the next warning and carry minutes of routine
     * polling with it. */
    if (!ring->pending_serious && !ring->ship_everything && ring->unsent > ring->context_bytes) {
        size_t tail = (ring->head + ring->size - ring->unsent) % ring->size;
        while (ring->unsent > ring->context_bytes) {
            const bool newline = ring->buf[tail] == '\n';
            tail = (tail + 1) % ring->size;
            ring->unsent--;
            if (newline) break;
        }
    }
}

void log_ring_append(log_ring_t *ring, const char *line, size_t len, bool serious,
                     char *folded, size_t folded_len, size_t *folded_out)
{
    if (folded_out) *folded_out = 0;
    if (len == 0) return;

    const char *body = log_ring_message_of(line);
    bool same = true;
    for (size_t i = 0; i < sizeof(ring->last_body); i++) {
        if (ring->last_body[i] != body[i]) {
            same = false;
            break;
        }
        if (body[i] == '\0') break;
    }
    if (same && ring->last_body[0] != '\0') {
        ring->repeat++;
        if (serious && !ring->trigger_suspended) ring->pending_serious = true;
        return;
    }

    if (ring->repeat > 0) {
        char text[48];
        const int n = snprintf(text, sizeof(text), "    (repeated %ux)\n",
                               (unsigned)ring->repeat);
        if (n > 0) {
            raw_append(ring, text, (size_t)n);
            if (folded && folded_len > (size_t)n) {
                for (int k = 0; k < n; k++) folded[k] = text[k];
                folded[n] = '\0';
                if (folded_out) *folded_out = (size_t)n;
            }
        }
        ring->repeat = 0;
    }

    size_t b = 0;
    while (b < sizeof(ring->last_body) - 1 && body[b] != '\0') {
        ring->last_body[b] = body[b];
        b++;
    }
    ring->last_body[b] = '\0';

    raw_append(ring, line, len);
    if (line[len - 1] != '\n') raw_append(ring, "\n", 1);
    if (serious && !ring->trigger_suspended) ring->pending_serious = true;
}

bool log_ring_should_upload(const log_ring_t *ring)
{
    if (ring->unsent == 0) return false;
    return ring->pending_serious || ring->ship_everything;
}

static size_t copy_span(const log_ring_t *ring, size_t span, char *out, size_t out_len)
{
    if (!out || out_len == 0) return 0;
    const size_t start = (ring->head + ring->size - span) % ring->size;
    size_t copied = 0;
    while (copied < span && copied < out_len - 1) {
        out[copied] = ring->buf[(start + copied) % ring->size];
        copied++;
    }
    out[copied] = '\0';
    return copied;
}

size_t log_ring_snapshot(const log_ring_t *ring, char *out, size_t out_len)
{
    return copy_span(ring, ring->used, out, out_len);
}

size_t log_ring_peek_unsent(const log_ring_t *ring, char *out, size_t out_len)
{
    return copy_span(ring, ring->unsent, out, out_len);
}

void log_ring_confirm(log_ring_t *ring, size_t len)
{
    ring->unsent = ring->unsent > len ? ring->unsent - len : 0;
    if (ring->unsent == 0) ring->pending_serious = false;
}
