// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "vellum_log.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "esp_attr.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"

#define RING_SIZE      8192   /* internal RAM, recent history */
#define RTC_SIZE       1536   /* survives reset, warnings and errors only */
#define LOG_LINE_MAX   220    /* one formatted log line, longer ones are cut */
#define RTC_MAGIC      0x564C4F47u /* "VLOG" */
#define CONTEXT_BYTES  2048   /* unsent history kept while nothing is wrong */

/*
 * A byte ring holding whole lines. Dropping from the front happens line-wise, so
 * a snapshot never begins mid-message; a half line is worse than a missing one
 * when the reader is trying to decide what failed.
 */
static char s_ring[RING_SIZE];
static size_t s_head;      /* next write */
static size_t s_used;      /* bytes held */
static uint32_t s_dropped; /* lines discarded to make room */

/* Bytes not yet acknowledged by the server, counted back from the head. */
static size_t s_unsent;
static bool s_pending_serious;  /* a warning or error is waiting to be reported */
static bool s_ship_everything;  /* operator raised this device for debugging */
/* Suppressed while the upload itself is running. Its own failure is a warning,
 * and a warning is what triggers an upload, so without this a server that does
 * not know the endpoint keeps the device reporting forever about being unable to
 * report. The lines are still recorded, they just do not arm the trigger. */
static bool s_trigger_suspended;

/* Consecutive identical messages are folded rather than repeated, so a display
 * stuck in a failing loop costs a handful of lines instead of one per minute. */
static char s_last_body[LOG_LINE_MAX];
static uint32_t s_repeat;
static uint32_t s_seq;
static uint32_t s_seq_in_flight;
static size_t s_in_flight_len;

static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static vprintf_like_t s_next_writer;

/*
 * RTC region. NOINIT rather than DATA: the content has to outlive a reset, and
 * the magic plus length is what tells a first-ever boot's garbage apart from a
 * genuine tail. Not encrypted and not secret-bearing by design, see redact().
 */
RTC_NOINIT_ATTR static struct {
    uint32_t magic;
    uint32_t len;
    uint32_t boot_count;
    char buf[RTC_SIZE];
} s_rtc;

/* Copied at init, before the current boot starts overwriting the region. */
static char s_prev[RTC_SIZE];
static size_t s_prev_len;
static esp_reset_reason_t s_prev_reason;

/*
 * Redact anything that authenticates before it can be persisted or uploaded.
 *
 * Device tokens, signatures and partition fingerprints are long hex runs, so a
 * run of 32 or more hex characters is replaced wholesale. SSIDs and the server
 * URL are deliberately kept: they are needed to read a Wi-Fi or transport
 * failure at all, and neither is a credential. Passwords are never logged.
 */
static void redact(char *line)
{
    size_t run = 0;
    for (size_t i = 0;; i++) {
        const char c = line[i];
        const bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        if (hex) {
            run++;
            continue;
        }
        if (run >= 32) {
            memset(line + i - run, '*', 8);
            memmove(line + i - run + 8, line + i, strlen(line + i) + 1);
            i = i - run + 8;
        }
        run = 0;
        if (c == '\0') break;
    }
}

/* Caller holds the lock. Drops whole lines until `need` bytes are free. */
static void make_room(size_t need)
{
    while (RING_SIZE - s_used < need) {
        size_t tail = (s_head + RING_SIZE - s_used) % RING_SIZE;
        size_t scanned = 0;
        while (scanned < s_used && s_ring[tail] != '\n') {
            tail = (tail + 1) % RING_SIZE;
            scanned++;
        }
        scanned++; /* the newline itself */
        if (scanned > s_used) scanned = s_used;
        s_used -= scanned;
        s_dropped++;
        if (s_unsent > s_used) s_unsent = s_used;
        if (s_used == 0) break;
    }
}

static void ring_append(const char *text, size_t len)
{
    if (len > RING_SIZE) len = RING_SIZE;
    make_room(len);
    for (size_t i = 0; i < len; i++) {
        s_ring[s_head] = text[i];
        s_head = (s_head + 1) % RING_SIZE;
    }
    s_used += len;
    if (s_used > RING_SIZE) s_used = RING_SIZE;
    s_unsent += len;
    if (s_unsent > s_used) s_unsent = s_used;

    /* Nothing is wrong, so keep only a context window: without this the unsent
     * span would grow until the next warning and ship minutes of routine polling
     * with it. */
    if (!s_pending_serious && !s_ship_everything && s_unsent > CONTEXT_BYTES) {
        size_t tail = (s_head + RING_SIZE - s_unsent) % RING_SIZE;
        while (s_unsent > CONTEXT_BYTES) {
            const bool newline = s_ring[tail] == '\n';
            tail = (tail + 1) % RING_SIZE;
            s_unsent--;
            if (newline) break;
        }
    }
}

/* The message without its timestamp, for comparing one line against the last. */
static const char *message_of(const char *line)
{
    const char *paren = strchr(line, ')');
    return paren ? paren + 1 : line;
}

static void rtc_append(const char *text, size_t len)
{
    if (len >= RTC_SIZE) {
        text += len - (RTC_SIZE - 1);
        len = RTC_SIZE - 1;
    }
    if (s_rtc.len + len > RTC_SIZE) {
        /* Keep the newest: shift the oldest out rather than stopping to record.
         * A tail that ends at the failure is what explains a reset. */
        const size_t drop = s_rtc.len + len - RTC_SIZE;
        memmove(s_rtc.buf, s_rtc.buf + drop, s_rtc.len - drop);
        s_rtc.len -= drop;
    }
    memcpy(s_rtc.buf + s_rtc.len, text, len);
    s_rtc.len += len;
}

/* The level letter sits behind the colour escape when colours are enabled. */
static char level_of(const char *line)
{
    if (line[0] == '\033') {
        const char *m = strchr(line, 'm');
        if (m) return m[1];
        return '\0';
    }
    return line[0];
}

static int log_writer(const char *format, va_list args)
{
    char line[LOG_LINE_MAX];
    /* vsnprintf consumes the va_list, and handing a consumed one to the next
     * writer is undefined, so each consumer gets its own copy. */
    va_list mine;
    va_copy(mine, args);
    const int written = vsnprintf(line, sizeof(line), format, mine);
    va_end(mine);

    if (written > 0) {
        redact(line);
        const size_t len = strlen(line);
        if (len > 0) {
            const char level = level_of(line);
            const bool serious = level == 'E' || level == 'W';
            const bool ends_line = line[len - 1] == '\n';
            const char *body = message_of(line);

            portENTER_CRITICAL(&s_lock);
            if (strncmp(body, s_last_body, sizeof(s_last_body) - 1) == 0) {
                s_repeat++;
                if (serious && !s_trigger_suspended) s_pending_serious = true;
                portEXIT_CRITICAL(&s_lock);
                goto chain;
            }
            if (s_repeat > 0) {
                char folded[48];
                const int n = snprintf(folded, sizeof(folded), "    (repeated %lux)\n",
                                       (unsigned long)s_repeat);
                if (n > 0) {
                    ring_append(folded, (size_t)n);
                    rtc_append(folded, (size_t)n);
                }
                s_repeat = 0;
            }
            strncpy(s_last_body, body, sizeof(s_last_body) - 1);
            s_last_body[sizeof(s_last_body) - 1] = '\0';

            ring_append(line, len);
            if (!ends_line) ring_append("\n", 1);
            if (serious) {
                if (!s_trigger_suspended) s_pending_serious = true;
                rtc_append(line, len);
                if (!ends_line) rtc_append("\n", 1);
            }
            portEXIT_CRITICAL(&s_lock);
        }
chain:;
    }

    /* Chain last, so the console keeps its output even if we bail out above. */
    return s_next_writer ? s_next_writer(format, args) : written;
}

void vellum_log_init(void)
{
    if (s_rtc.magic == RTC_MAGIC && s_rtc.len > 0 && s_rtc.len <= RTC_SIZE) {
        s_prev_len = s_rtc.len;
        memcpy(s_prev, s_rtc.buf, s_prev_len);
    } else {
        s_rtc.boot_count = 0; /* first boot after power-on: the region is garbage */
    }
    s_prev_reason = esp_reset_reason();
    s_rtc.magic = RTC_MAGIC;
    s_rtc.len = 0;
    s_rtc.boot_count++;

    s_next_writer = esp_log_set_vprintf(log_writer);

    /* Recorded through the hook, so the previous boot's tail travels to the
     * server with everything else rather than needing its own channel. */
    ESP_LOGI("vellum_log", "Log retention armed (boot %lu, reset reason %d, %u bytes carried over)",
             (unsigned long)s_rtc.boot_count, (int)s_prev_reason, (unsigned)s_prev_len);
}

size_t vellum_log_snapshot(char *out, size_t out_len)
{
    if (!out || out_len == 0) return 0;
    portENTER_CRITICAL(&s_lock);
    const size_t used = s_used;
    const size_t start = (s_head + RING_SIZE - used) % RING_SIZE;
    size_t copied = 0;
    while (copied < used && copied < out_len - 1) {
        out[copied] = s_ring[(start + copied) % RING_SIZE];
        copied++;
    }
    portEXIT_CRITICAL(&s_lock);
    out[copied] = '\0';
    return copied;
}

size_t vellum_log_previous_boot(char *out, size_t out_len)
{
    if (!out || out_len == 0 || s_prev_len == 0) return 0;
    const int header = snprintf(out, out_len, "-- previous boot ended, reset reason %d --\n",
                                (int)s_prev_reason);
    if (header < 0 || (size_t)header >= out_len) return 0;
    size_t copied = (size_t)header;
    const size_t room = out_len - copied - 1;
    const size_t take = s_prev_len < room ? s_prev_len : room;
    memcpy(out + copied, s_prev, take);
    copied += take;
    out[copied] = '\0';
    return copied;
}

size_t vellum_log_take_upload(char *out, size_t out_len, uint32_t *seq)
{
    if (!out || out_len < 2 || !seq) return 0;
    portENTER_CRITICAL(&s_lock);
    /* No warning, no error, and nobody asked for everything: a healthy display
     * reports nothing at all, which is the whole point of the design. */
    if (s_unsent == 0 || (!s_pending_serious && !s_ship_everything)) {
        portEXIT_CRITICAL(&s_lock);
        return 0;
    }
    /* Re-offer the same sequence number until it is confirmed, so a lost
     * response costs a duplicate the server can discard, never a gap. */
    if (s_seq_in_flight == 0) {
        s_seq_in_flight = ++s_seq;
        s_in_flight_len = s_unsent;
    }
    size_t take = s_in_flight_len < out_len - 1 ? s_in_flight_len : out_len - 1;
    const size_t start = (s_head + RING_SIZE - s_unsent) % RING_SIZE;
    for (size_t i = 0; i < take; i++) out[i] = s_ring[(start + i) % RING_SIZE];
    s_in_flight_len = take;
    *seq = s_seq_in_flight;
    portEXIT_CRITICAL(&s_lock);
    out[take] = '\0';
    return take;
}

void vellum_log_upload_confirmed(uint32_t seq)
{
    portENTER_CRITICAL(&s_lock);
    if (seq == s_seq_in_flight && s_seq_in_flight != 0) {
        s_unsent = s_unsent > s_in_flight_len ? s_unsent - s_in_flight_len : 0;
        s_seq_in_flight = 0;
        s_in_flight_len = 0;
        if (s_unsent == 0) s_pending_serious = false;
    }
    portEXIT_CRITICAL(&s_lock);
}

void vellum_log_set_ship_everything(bool enabled)
{
    portENTER_CRITICAL(&s_lock);
    s_ship_everything = enabled;
    portEXIT_CRITICAL(&s_lock);
}

void vellum_log_suspend_trigger(bool suspended)
{
    portENTER_CRITICAL(&s_lock);
    s_trigger_suspended = suspended;
    portEXIT_CRITICAL(&s_lock);
}
