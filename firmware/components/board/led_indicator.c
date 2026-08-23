// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file led_indicator.c
 * @brief Drives whatever the board's table asked for. Knows no colours.
 *
 * One periodic tick rather than a timer per pattern: patterns are then pure
 * arithmetic on a phase counter, restarting one cannot leak a timer, and a
 * pattern change takes effect on the next tick without stopping anything. The
 * tick only runs while a pattern actually needs it, so a steady or dark
 * indicator costs nothing.
 */

#include "board_led.h"

#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "board_led";

#define TICK_US (BOARD_LED_TICK_MS * 1000)

static const board_led_profile_t *s_profile;
static esp_timer_handle_t         s_tick;
static board_led_state_t          s_state = BOARD_LED_STATE_IDLE;
static board_led_expression_t     s_shown = { BOARD_LED_NO_CHANNEL, BOARD_LED_OFF };
static uint32_t                   s_phase;
static bool                       s_ready;

static void write_channel(int8_t channel, bool on)
{
    if (!s_profile || channel < 0 || channel >= s_profile->channel_count) return;
    const board_led_channel_t *c = &s_profile->channels[channel];
    gpio_set_level(c->gpio, on ? c->on_level : (uint8_t)!c->on_level);
}

static void all_dark(void)
{
    if (!s_profile) return;
    for (uint8_t i = 0; i < s_profile->channel_count; ++i) {
        write_channel((int8_t)i, false);
    }
}

static void tick(void *arg)
{
    (void)arg;
    s_phase++;

    if (s_shown.pattern == BOARD_LED_FLASH_ONCE) {
        /* The blip is over; stop rather than keep a timer alive for nothing. */
        write_channel(s_shown.channel, false);
        esp_timer_stop(s_tick);
        return;
    }
    write_channel(s_shown.channel, board_led_pattern_is_lit(s_shown.pattern, s_phase));
}

void board_led_init(void)
{
    if (s_ready) return;

    const board_led_profile_t *profile = board_led_profile();
    if (!profile || !profile->channels || !profile->states ||
        profile->channel_count == 0) {
        /* A board with no indicators is legitimate, and so is a board whose
         * tables are half-written. Both become a no-op by leaving s_profile NULL
         * rather than keeping an incomplete one: every path below then fails its
         * first guard instead of reaching through a missing table. Keeping the
         * profile while marking init done is how a missing `states` turned into a
         * dereference at the first board_led_indicate(). */
        ESP_LOGI(TAG, "No usable indicator LEDs on this board");
        s_profile = NULL;
        s_ready = true;
        return;
    }
    s_profile = profile;

    for (uint8_t i = 0; i < s_profile->channel_count; ++i) {
        const board_led_channel_t *c = &s_profile->channels[i];
        gpio_set_direction(c->gpio, GPIO_MODE_OUTPUT);
        gpio_set_level(c->gpio, (uint8_t)!c->on_level);
        ESP_LOGD(TAG, "indicator %u: GPIO%d (%s), on=%u",
                 i, (int)c->gpio, c->label ? c->label : "?", c->on_level);
    }

    /* Idempotent by design: the eager init at boot should be the only caller, but
     * if the lazy path in board_led_indicate() were ever entered twice, creating
     * a second timer would leak the first. Cheaper than a mutex, and enough. */
    if (s_tick) {
        s_ready = true;
        return;
    }

    const esp_timer_create_args_t args = {
        .callback = tick,
        .name     = "led_tick",
        /* The tick writes a GPIO. Doing that from the timer TASK rather than
         * the ISR keeps it away from the dispatch path. */
        .dispatch_method = ESP_TIMER_TASK,
    };
    esp_err_t err = esp_timer_create(&args, &s_tick);
    if (err != ESP_OK) {
        /* Patterns degrade to their lit-or-dark first frame. Worth a warning,
         * not worth failing a boot over: this is an indicator. */
        ESP_LOGW(TAG, "No timer for LED patterns: %s", esp_err_to_name(err));
        s_tick = NULL;
    }
    s_ready = true;
}

void board_led_indicate(board_led_state_t state)
{
    if (!s_ready) board_led_init();
    if (!s_profile || state >= BOARD_LED_STATE_COUNT) return;

    s_state = state;
    const board_led_expression_t next = s_profile->states[state];

    /* Repeating a request must not restart a pulse, or a caller in a loop would
     * hold the indicator at phase zero forever. */
    if (next.channel == s_shown.channel && next.pattern == s_shown.pattern) return;

    if (s_tick) esp_timer_stop(s_tick);
    all_dark();

    s_shown = next;
    s_phase = 0;

    if (next.channel == BOARD_LED_NO_CHANNEL || next.pattern == BOARD_LED_OFF) {
        return;
    }

    write_channel(next.channel, board_led_pattern_is_lit(next.pattern, 0));
    if (s_tick && board_led_pattern_needs_tick(next.pattern)) {
        esp_timer_start_periodic(s_tick, TICK_US);
    }
}

board_led_state_t board_led_current(void)
{
    return s_state;
}
