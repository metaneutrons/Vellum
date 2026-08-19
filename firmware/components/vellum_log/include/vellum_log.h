// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

/**
 * Diagnostic log retention.
 *
 * Vellum's logs used to exist only on a live UART. A display that stopped
 * polling, and one that refused every frame it was sent, both had to be
 * diagnosed by attaching a cable at the moment it happened, and in both cases
 * the evidence was gone before that was possible.
 *
 * Two tiers, because they answer different questions:
 *
 *  - a ring in INTERNAL RAM holds the recent lines and answers "what is
 *    happening"; it is internal rather than PSRAM on purpose, since the panic
 *    handler runs with the cache disabled and could not read PSRAM,
 *  - a small RTC region holds the warnings and errors and answers "why did I
 *    restart": it survives a soft reset, a watchdog, a panic and deep sleep,
 *    though not a power cut.
 *
 * Both are readable over the serial console and are uploaded to the server on
 * the next successful poll, so a wall-mounted display can be diagnosed without
 * a laptop in front of it.
 */

/** Install the log hook. Call as early as possible; it chains to the previous
 *  writer, so console output is unaffected. */
void vellum_log_init(void);

/** Copy the recent lines out, oldest first. Returns the bytes written. */
size_t vellum_log_snapshot(char *out, size_t out_len);

/** Copy the warnings and errors that survived the previous boot, plus its reset
 *  reason. Returns 0 when this was a cold start or the region is unusable. */
size_t vellum_log_previous_boot(char *out, size_t out_len);

/** Pending upload payload, oldest first, with the sequence number to report it
 *  under. Returns 0 when there is nothing new to send. */
size_t vellum_log_take_upload(char *out, size_t out_len, uint32_t *seq);

/** Raise this device to report everything, not only warnings and errors. The
 *  server sets it per device while an operator is actively debugging one. */
void vellum_log_set_ship_everything(bool enabled);

/** Stop new warnings from arming another upload while one is in flight. The
 *  upload's own failure is a warning, and without this a server that does not
 *  know the endpoint would keep the device reporting about being unable to
 *  report. Recording continues either way. */
void vellum_log_suspend_trigger(bool suspended);

/** Confirm that a sequence number reached the server, so its bytes are dropped.
 *  Anything not confirmed is offered again. */
void vellum_log_upload_confirmed(uint32_t seq);
