// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file board.c
 * @brief reTerminal E-Series board peripherals (battery, LED, buzzer).
 */

#include "board.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_adc/adc_oneshot.h"
#include "driver/ledc.h"
#include "driver/gpio.h"
#include "sdkconfig.h"

static const char *TAG = "board";

static adc_oneshot_unit_handle_t s_adc_handle = NULL;

/* ── Battery ──────────────────────────────────────────────────── */

static void battery_adc_init(void)
{
    adc_oneshot_unit_init_cfg_t cfg = { .unit_id = ADC_UNIT_1 };
    adc_oneshot_new_unit(&cfg, &s_adc_handle);
    adc_oneshot_chan_cfg_t chan = { .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12 };
    adc_oneshot_config_channel(s_adc_handle, ADC_CHANNEL_0, &chan);
}

float board_battery_voltage(void)
{
    gpio_set_direction(CONFIG_VELLUM_BATTERY_EN_GPIO, GPIO_MODE_OUTPUT);
    gpio_set_level(CONFIG_VELLUM_BATTERY_EN_GPIO, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
    int raw = 0;
    if (s_adc_handle) adc_oneshot_read(s_adc_handle, ADC_CHANNEL_0, &raw);
#if !defined(CONFIG_VELLUM_PANEL_E1003)
    /* Don't disable on E1003 — GPIO21 is shared with IT8951 ITE_ENABLE */
    gpio_set_level(CONFIG_VELLUM_BATTERY_EN_GPIO, 0);
#endif
    return (raw / 4095.0f) * 3.3f * 2.0f;
}

int board_battery_level(void)
{
    float v = board_battery_voltage();
    int level = (int)((v - 3.0f) / (4.2f - 3.0f) * 100.0f);
    if (level < 0) level = 0;
    if (level > 100) level = 100;
    return level;
}

bool board_is_usb_powered(void)
{
    return board_battery_voltage() > 4.5f;
}

/* ── Status LED (active-low) ──────────────────────────────────── */

static void led_init(void)
{
    gpio_set_direction(CONFIG_VELLUM_LED_GPIO, GPIO_MODE_OUTPUT);
    gpio_set_level(CONFIG_VELLUM_LED_GPIO, 1);
}

void board_led_on(void)  { gpio_set_level(CONFIG_VELLUM_LED_GPIO, 0); }
void board_led_off(void) { gpio_set_level(CONFIG_VELLUM_LED_GPIO, 1); }

/* ── Buzzer ───────────────────────────────────────────────────── */

static void buzzer_init(void)
{
    ledc_timer_config_t timer = { .speed_mode=LEDC_LOW_SPEED_MODE, .duty_resolution=LEDC_TIMER_8_BIT, .timer_num=LEDC_TIMER_0, .freq_hz=1000, .clk_cfg=LEDC_AUTO_CLK };
    ledc_timer_config(&timer);
    ledc_channel_config_t ch = { .gpio_num=CONFIG_VELLUM_BUZZER_GPIO, .speed_mode=LEDC_LOW_SPEED_MODE, .channel=LEDC_CHANNEL_0, .timer_sel=LEDC_TIMER_0, .duty=0 };
    ledc_channel_config(&ch);
}

void board_buzzer_beep(uint32_t freq, uint32_t ms)
{
    ledc_set_freq(LEDC_LOW_SPEED_MODE, LEDC_TIMER_0, freq);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 128);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
    vTaskDelay(pdMS_TO_TICKS(ms));
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
}

/* ── Init ─────────────────────────────────────────────────────── */

void board_init(void)
{
    battery_adc_init();
    led_init();
    buzzer_init();
    ESP_LOGI(TAG, "Board peripherals initialized (battery, LED, buzzer)");
}
