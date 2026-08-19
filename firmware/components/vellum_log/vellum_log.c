// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "vellum_log.h"
#include "log_ring.h"

#include <stdarg.h>
#include <stdio.h>

#include "esp_attr.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"

#define RING_SIZE      8192   /* internal RAM, recent history */
#define RTC_SIZE       1536   /* survives reset, warnings and errors only */
#define CONTEXT_BYTES  2048   /* unsent history kept while nothing is wrong */
#define RTC_MAGIC      0x564C4F47u /* "VLOG" */

/*
 * The ESP-specific half: the log hook, the lock, and the region that outlives a
 * reset. Everything that can be reasoned about without hardware lives in
 * log_ring.c and is covered by host tests.
 *
 * The ring is in INTERNAL RAM on purpose, not PSRAM: the panic handler runs with
 * the cache disabled and could not read PSRAM, and a log that is unreadable
 * exactly when the device crashed would defeat the point.
 */
static char s_storage[RING_SIZE];
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
static vprintf_like_t s_next_writer;
static uint32_t s_seq;
static uint32_t s_seq_in_flight;
/* Two lengths, and conflating them is a bug: `raw` is what was consumed from the
 * ring and therefore what must be acknowledged, while the payload is shorter
 * because repeats were collapsed. Confirming the payload length would leave the
 * collapsed bytes unsent and re-upload them forever. */
static size_t s_in_flight_raw;

/*
 * NOINIT rather than DATA: the content has to outlive a reset, and the magic plus
 * length is what tells a first-ever boot's garbage apart from a genuine tail. Not
 * secret-bearing by design, see log_ring_redact().
 */
RTC_NOINIT_ATTR static struct {
    uint32_t magic;
    uint32_t len;
    uint32_t boot_count;
    char buf[RTC_SIZE];
} s_rtc;

static char s_prev[RTC_SIZE];
static size_t s_prev_len;
static esp_reset_reason_t s_prev_reason;

static void rtc_append(const char *text, size_t len)
{
    /* The region is NOINIT, so a corrupted length is a real possibility rather
     * than a theoretical one: treat anything out of range as empty instead of
     * trusting it into a write offset. */
    if (s_rtc.len > RTC_SIZE) s_rtc.len = 0;
    if (len >= RTC_SIZE) {
        text += len - (RTC_SIZE - 1);
        len = RTC_SIZE - 1;
    }
    if (s_rtc.len + len > RTC_SIZE) {
        /* Keep the newest: shift the oldest out rather than stopping to record.
         * A tail that ends at the failure is what explains a reset. */
        const size_t drop = s_rtc.len + len - RTC_SIZE;
        for (size_t i = 0; i + drop < s_rtc.len; i++) s_rtc.buf[i] = s_rtc.buf[i + drop];
        s_rtc.len -= drop;
    }
    const size_t room = RTC_SIZE - s_rtc.len;
    const size_t take = len < room ? len : room;
    for (size_t i = 0; i < take; i++) s_rtc.buf[s_rtc.len + i] = text[i];
    s_rtc.len += take;
}

static int log_writer(const char *format, va_list args)
{
    char line[LOG_RING_LINE_MAX];
    /* vsnprintf consumes the va_list, and handing a consumed one to the next
     * writer is undefined, so each consumer gets its own copy. */
    va_list mine;
    va_copy(mine, args);
    const int written = vsnprintf(line, sizeof(line), format, mine);
    va_end(mine);

    if (written > 0) {
        const size_t raw =
            (size_t)written < sizeof(line) - 1 ? (size_t)written : sizeof(line) - 1;
        const size_t len = log_ring_redact(line, raw);
        if (len > 0) {
            const char level = log_ring_level_of(line);
            const bool serious = level == 'E' || level == 'W';
            /* Routine chatter never enters the ring, so the history that does fit
             * is history worth reading. Warnings and errors are always kept, even
             * from a noisy tag. */
            if (!serious && log_ring_is_noise(line)) goto chain;
            char folded[48];
            size_t folded_len = 0;

            portENTER_CRITICAL(&s_lock);
            log_ring_append(line, len, serious, folded, sizeof(folded), &folded_len);
            if (folded_len > 0) rtc_append(folded, folded_len);
            if (serious) {
                rtc_append(line, len);
                if (line[len - 1] != '\n') rtc_append("\n", 1);
            }
            portEXIT_CRITICAL(&s_lock);
        }
    }

chain:;
    /* Chain last, so the console keeps its output even if we bail out above. */
    return s_next_writer ? s_next_writer(format, args) : written;
}

void vellum_log_init(void)
{
    log_ring_init(s_storage, sizeof(s_storage), CONTEXT_BYTES);

    if (s_rtc.magic == RTC_MAGIC && s_rtc.len > 0 && s_rtc.len <= sizeof(s_prev)) {
        s_prev_len = s_rtc.len;
        for (size_t i = 0; i < s_prev_len; i++) s_prev[i] = s_rtc.buf[i];
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
    portENTER_CRITICAL(&s_lock);
    const size_t copied = log_ring_snapshot(out, out_len);
    portEXIT_CRITICAL(&s_lock);
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
    for (size_t i = 0; i < take; i++) out[copied + i] = s_prev[i];
    copied += take;
    out[copied] = '\0';
    return copied;
}

size_t vellum_log_take_upload(char *out, size_t out_len, uint32_t *seq)
{
    if (!out || out_len < 2 || !seq) return 0;
    portENTER_CRITICAL(&s_lock);
    if (!log_ring_should_upload()) {
        portEXIT_CRITICAL(&s_lock);
        return 0;
    }
    /* Re-offer the same sequence number until it is confirmed, so a lost
     * response costs a duplicate the server discards, never a gap. */
    if (s_seq_in_flight == 0) s_seq_in_flight = ++s_seq;
    const size_t raw = log_ring_peek_unsent(out, out_len);
    /* Dense payload, raw ring: the console still shows every line in order, while
     * a batch collapses a failure that repeats every cycle into one line plus a
     * count. Measured need, not a guess: a real 4 KB batch was mostly repeats. */
    const size_t copied = log_ring_compress(out, raw);
    s_in_flight_raw = raw;
    *seq = s_seq_in_flight;
    portEXIT_CRITICAL(&s_lock);
    return copied;
}

void vellum_log_upload_confirmed(uint32_t seq)
{
    portENTER_CRITICAL(&s_lock);
    if (seq == s_seq_in_flight && s_seq_in_flight != 0) {
        log_ring_confirm(s_in_flight_raw);
        s_seq_in_flight = 0;
        s_in_flight_raw = 0;
    }
    portEXIT_CRITICAL(&s_lock);
}

void vellum_log_set_ship_everything(bool enabled)
{
    portENTER_CRITICAL(&s_lock);
    log_ring_set_ship_everything(enabled);
    portEXIT_CRITICAL(&s_lock);
}

void vellum_log_suspend_trigger(bool suspended)
{
    portENTER_CRITICAL(&s_lock);
    log_ring_set_trigger_suspended(suspended);
    portEXIT_CRITICAL(&s_lock);
}
