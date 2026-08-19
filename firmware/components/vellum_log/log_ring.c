// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "log_ring.h"

#include <stdio.h>

/* One ring per device: the state lives here rather than in a struct the caller
 * has to carry, so nothing outside can depend on its layout. */
static struct {
    char *buf;
    size_t size;
    size_t head;            /* next write position */
    size_t used;            /* bytes held */
    size_t unsent;          /* bytes not yet acknowledged, counted back from head */
    size_t context_bytes;   /* unsent history kept while nothing is wrong */
    uint32_t dropped;       /* lines discarded to make room */
    bool pending_serious;   /* a warning or error is waiting to be reported */
    bool ship_everything;   /* operator raised this device for debugging */
    bool trigger_suspended; /* an upload is in flight; its failures must not re-arm it */
    char last_body[LOG_RING_LINE_MAX];
    uint32_t repeat;        /* consecutive identical messages folded so far */
    uint32_t compressed;    /* repeats dropped while assembling a payload */
} r;

void log_ring_init(char *storage, size_t size, size_t context_bytes)
{
    r.buf = storage;
    r.size = size;
    r.head = 0;
    r.used = 0;
    r.unsent = 0;
    r.context_bytes = context_bytes;
    r.dropped = 0;
    r.pending_serious = false;
    r.ship_everything = false;
    r.trigger_suspended = false;
    r.last_body[0] = '\0';
    r.repeat = 0;
    r.compressed = 0;
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
             * The copy only ever moves left and shrinks the line, and the length is
             * carried rather than re-measured, so the bound stays local. */
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
static void make_room(size_t need)
{
    while (r.size - r.used < need && r.used > 0) {
        size_t tail = (r.head + r.size - r.used) % r.size;
        size_t scanned = 0;
        while (scanned < r.used && r.buf[tail] != '\n') {
            tail = (tail + 1) % r.size;
            scanned++;
        }
        scanned++; /* the newline itself */
        if (scanned > r.used) scanned = r.used;
        r.used -= scanned;
        r.dropped++;
        if (r.unsent > r.used) r.unsent = r.used;
    }
}

static void raw_append(const char *text, size_t len)
{
    if (len > r.size) len = r.size;
    make_room(len);
    for (size_t i = 0; i < len; i++) {
        r.buf[r.head] = text[i];
        r.head = (r.head + 1) % r.size;
    }
    r.used += len;
    if (r.used > r.size) r.used = r.size;
    r.unsent += len;
    if (r.unsent > r.used) r.unsent = r.used;

    /* Nothing is wrong, so keep only a context window: without this the unsent
     * span would grow until the next warning and carry minutes of routine polling
     * with it. */
    if (!r.pending_serious && !r.ship_everything && r.unsent > r.context_bytes) {
        size_t tail = (r.head + r.size - r.unsent) % r.size;
        while (r.unsent > r.context_bytes) {
            const bool newline = r.buf[tail] == '\n';
            tail = (tail + 1) % r.size;
            r.unsent--;
            if (newline) break;
        }
    }
}

void log_ring_append(const char *line, size_t len, bool serious, char *folded,
                     size_t folded_len, size_t *folded_out)
{
    if (folded_out) *folded_out = 0;
    if (len == 0) return;

    const char *body = log_ring_message_of(line);
    bool same = true;
    for (size_t i = 0; i < sizeof(r.last_body); i++) {
        if (r.last_body[i] != body[i]) {
            same = false;
            break;
        }
        if (body[i] == '\0') break;
    }
    if (same && r.last_body[0] != '\0') {
        r.repeat++;
        if (serious && !r.trigger_suspended) r.pending_serious = true;
        return;
    }

    if (r.repeat > 0) {
        char text[48];
        const int n = snprintf(text, sizeof(text), "    (repeated %ux)\n", (unsigned)r.repeat);
        if (n > 0) {
            raw_append(text, (size_t)n);
            if (folded && folded_len > (size_t)n) {
                for (int k = 0; k < n; k++) folded[k] = text[k];
                folded[n] = '\0';
                if (folded_out) *folded_out = (size_t)n;
            }
        }
        r.repeat = 0;
    }

    size_t b = 0;
    while (b < sizeof(r.last_body) - 1 && body[b] != '\0') {
        r.last_body[b] = body[b];
        b++;
    }
    r.last_body[b] = '\0';

    raw_append(line, len);
    if (line[len - 1] != '\n') raw_append("\n", 1);
    if (serious && !r.trigger_suspended) r.pending_serious = true;
}

/* Tags whose INFO output repeats every cycle and carries no diagnostic value.
 * Kept deliberately short: the cycle heartbeat (render, config, OTA check) stays,
 * because "GET /render -> 200, 88817 bytes" is exactly what tells a reader that
 * the server answered while the panel still showed nothing. */
static const char *const NOISE_TAGS[] = {
    "esp-x509-crt-bundle:",
    "Battery voltage:",
};

bool log_ring_is_noise(const char *line)
{
    const char *body = log_ring_message_of(line);
    for (size_t i = 0; i < sizeof(NOISE_TAGS) / sizeof(NOISE_TAGS[0]); i++) {
        const char *needle = NOISE_TAGS[i];
        for (const char *p = body; *p != '\0'; p++) {
            size_t k = 0;
            while (needle[k] != '\0' && p[k] == needle[k]) k++;
            if (needle[k] == '\0') return true;
        }
    }
    return false;
}

/* Compare two lines by message, ignoring the timestamp and the trailing newline. */
static bool same_message(const char *a, size_t alen, const char *b, size_t blen)
{
    const char *ma = log_ring_message_of(a);
    const char *mb = log_ring_message_of(b);
    size_t la = alen - (size_t)(ma - a);
    size_t lb = blen - (size_t)(mb - b);
    while (la > 0 && (ma[la - 1] == '\n' || ma[la - 1] == '\r')) la--;
    while (lb > 0 && (mb[lb - 1] == '\n' || mb[lb - 1] == '\r')) lb--;
    if (la != lb || la == 0) return false;
    for (size_t i = 0; i < la; i++) {
        if (ma[i] != mb[i]) return false;
    }
    return true;
}

size_t log_ring_compress(char *text, size_t len)
{
    if (!text || len == 0) return 0;

    /* Two passes over the buffer, in place. Pass one counts how often each
     * message occurs; pass two copies the first occurrence of each and drops the
     * rest. Bounded by the payload, so no allocation and no second buffer. */
    size_t out = 0;
    size_t start = 0;
    while (start < len) {
        size_t end = start;
        while (end < len && text[end] != '\n') end++;
        const size_t line_len = end < len ? end - start + 1 : end - start;

        /* Already emitted? Then this is a repeat: count it and skip. */
        bool seen = false;
        size_t scan = 0;
        while (scan < out) {
            size_t scan_end = scan;
            while (scan_end < out && text[scan_end] != '\n') scan_end++;
            const size_t prev_len = scan_end < out ? scan_end - scan + 1 : scan_end - scan;
            if (same_message(text + scan, prev_len, text + start, line_len)) {
                seen = true;
                break;
            }
            scan = scan_end + 1;
        }

        if (!seen) {
            if (out != start) {
                for (size_t i = 0; i < line_len; i++) text[out + i] = text[start + i];
            }
            out += line_len;
        } else {
            /* Count the repeat against the line already emitted. The counter is
             * appended after the whole pass, so the loop stays a single sweep. */
            r.compressed++;
        }
        start = end + 1;
    }

    if (r.compressed > 0) {
        char note[56];
        const int n = snprintf(note, sizeof(note), "    (%u repeated line(s) collapsed)\n",
                               (unsigned)r.compressed);
        if (n > 0 && out + (size_t)n < len) {
            for (int i = 0; i < n; i++) text[out + i] = note[i];
            out += (size_t)n;
        }
        r.compressed = 0;
    }
    text[out] = '\0';
    return out;
}

bool log_ring_should_upload(void)
{
    if (r.unsent == 0) return false;
    return r.pending_serious || r.ship_everything;
}

static size_t copy_span(size_t span, char *out, size_t out_len)
{
    if (!out || out_len == 0) return 0;
    const size_t start = (r.head + r.size - span) % r.size;
    size_t copied = 0;
    while (copied < span && copied < out_len - 1) {
        out[copied] = r.buf[(start + copied) % r.size];
        copied++;
    }
    out[copied] = '\0';
    return copied;
}

size_t log_ring_snapshot(char *out, size_t out_len)
{
    return copy_span(r.used, out, out_len);
}

size_t log_ring_peek_unsent(char *out, size_t out_len)
{
    return copy_span(r.unsent, out, out_len);
}

void log_ring_confirm(size_t len)
{
    r.unsent = r.unsent > len ? r.unsent - len : 0;
    if (r.unsent == 0) r.pending_serious = false;
}

void log_ring_set_ship_everything(bool enabled)
{
    r.ship_everything = enabled;
}

void log_ring_set_trigger_suspended(bool suspended)
{
    r.trigger_suspended = suspended;
}

size_t log_ring_unsent_bytes(void)
{
    return r.unsent;
}

uint32_t log_ring_dropped_lines(void)
{
    return r.dropped;
}
