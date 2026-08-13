// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file vellum_audio.h
 * @brief Audible feedback on models with a real speaker.
 *
 * Only D1001 has one: an ES8311 codec driving a 2 W mono speaker, with the power
 * amplifier gated behind the PCA9535 IO expander. The E-Series boards have a PWM
 * buzzer instead and never build this component — `board_buzzer_beep()` remains
 * their path.
 *
 * That asymmetry is why D1001 was silent: the generic LEDC beep reprogrammed the
 * timer driving the LCD backlight, so a "beep" left the display dark at 0% duty.
 * The buzzer call is routed here on this model instead.
 */
#pragma once

#include "esp_err.h"
#include <stdbool.h>

/**
 * @brief Bring up I2S and the codec.
 *
 * Optional: playback initialises on first use. Call it to move the ~10 ms of
 * codec setup off the first button press. Requires the D1001 board's I2C bus and
 * IO expander to exist already (`d1001_board_init()`).
 *
 * @return ESP_OK, or the first failure. A failure is not fatal — audio is
 *         feedback, and the display keeps working without it.
 */
esp_err_t vellum_audio_init(void);

/** @brief True once the codec is up and a chime can actually be heard. */
bool vellum_audio_available(void);

/**
 * @brief Play the confirmation chime, blocking for its ~272 ms.
 *
 * Safe to call before init (initialises lazily) and safe to call when the codec
 * is missing or broken (does nothing). Never fails in a way the caller must
 * handle: the worst outcome is silence.
 */
void vellum_audio_play_chime(void);
