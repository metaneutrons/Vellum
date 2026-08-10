// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file board.h
 * @brief reTerminal E-Series board peripherals: battery, status LED, buzzer.
 *
 * The D1001 (ESP32-P4) board has its own driver (d1001_board); this component
 * covers the E-Series (ESP32-S3) hardware used by the E-Paper panels.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <time.h>
#include "esp_err.h"

/** Initialize battery ADC, status LED, and buzzer. */
void board_init(void);

/** Battery voltage in volts (enables the divider, samples ADC1 channel 0). */
float board_battery_voltage(void);

/** Battery charge level, clamped to 0-100%. */
int board_battery_level(void);

/** True when external USB power is present on hardware that can detect it. */
bool board_is_usb_powered(void);

/** Set the UTC system clock and persist it in a hardware RTC when available. */
esp_err_t board_set_utc_time(time_t value);

/** Status LED (active-low). */
void board_led_on(void);
void board_led_off(void);

/** Drive the buzzer at @p freq Hz for @p ms milliseconds (blocking). */
void board_buzzer_beep(uint32_t freq, uint32_t ms);
