// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file buttons.c
 * @brief Button handler for reTerminal E-Series.
 *
 * KEY0 (Green, GPIO3): Wake from sleep + force refresh
 * KEY1 (White middle, GPIO4): Report issue
 * KEY2 (White left, GPIO5): Hold KEY2 + KEY0 for 5s = factory reset
 */

#include "buttons.h"

#include "esp_log.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "buttons";

#define DEBOUNCE_US     (50 * 1000)
#define FACTORY_RESET_HOLD_MS  5000

#define KEY0_GPIO  ((gpio_num_t)CONFIG_VELLUM_BUTTON_KEY0_GPIO)  /* Green */
#define KEY1_GPIO  ((gpio_num_t)CONFIG_VELLUM_BUTTON_KEY1_GPIO)  /* White middle */
#define KEY2_GPIO  ((gpio_num_t)CONFIG_VELLUM_BUTTON_KEY2_GPIO)  /* White left */

static volatile int64_t s_last_isr0 = 0;
static volatile int64_t s_last_isr1 = 0;
static volatile bool s_key0_pressed = false;
static volatile bool s_key1_pressed = false;

static void IRAM_ATTR isr_key0(void *arg)
{
    int64_t now = esp_timer_get_time();
    if (now - s_last_isr0 > DEBOUNCE_US) {
        s_key0_pressed = true;
        s_last_isr0 = now;
    }
}

static void IRAM_ATTR isr_key1(void *arg)
{
    int64_t now = esp_timer_get_time();
    if (now - s_last_isr1 > DEBOUNCE_US) {
        s_key1_pressed = true;
        s_last_isr1 = now;
    }
}

void buttons_init(void)
{
    const gpio_num_t pins[] = { KEY0_GPIO, KEY1_GPIO, KEY2_GPIO };

    for (int i = 0; i < 3; i++) {
        gpio_config_t io = {
            .pin_bit_mask = (1ULL << pins[i]),
            .mode = GPIO_MODE_INPUT,
            .pull_up_en = GPIO_PULLUP_ENABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_NEGEDGE,
        };
        gpio_config(&io);
    }

    gpio_install_isr_service(0);
    gpio_isr_handler_add(KEY0_GPIO, isr_key0, NULL);
    gpio_isr_handler_add(KEY1_GPIO, isr_key1, NULL);
    /* KEY2 has no ISR — polled for combo detection */

    ESP_LOGI(TAG, "Initialized — KEY0(green)=%d, KEY1=%d, KEY2=%d",
             KEY0_GPIO, KEY1_GPIO, KEY2_GPIO);
}

button_action_t buttons_poll(void)
{
    /* Check factory reset combo: KEY2 + KEY0 both held */
    if (gpio_get_level(KEY2_GPIO) == 0 && gpio_get_level(KEY0_GPIO) == 0) {
        ESP_LOGI(TAG, "KEY2+KEY0 held — checking for factory reset...");
        int64_t start = esp_timer_get_time() / 1000;
        while (gpio_get_level(KEY2_GPIO) == 0 && gpio_get_level(KEY0_GPIO) == 0) {
            int64_t elapsed = (esp_timer_get_time() / 1000) - start;
            if (elapsed >= FACTORY_RESET_HOLD_MS) {
                ESP_LOGW(TAG, "Factory reset triggered!");
                s_key0_pressed = false;
                return BUTTON_ACTION_FACTORY_RESET;
            }
            vTaskDelay(pdMS_TO_TICKS(50));
        }
        /* Released before timeout */
        s_key0_pressed = false;
    }

    if (s_key0_pressed) {
        s_key0_pressed = false;
        ESP_LOGI(TAG, "KEY0 (green) → REFRESH");
        return BUTTON_ACTION_REQUEST_RENDER;
    }

    if (s_key1_pressed) {
        s_key1_pressed = false;
        ESP_LOGI(TAG, "KEY1 → REPORT");
        return BUTTON_ACTION_SEND_REPORT;
    }

    return BUTTON_ACTION_NONE;
}

uint64_t buttons_get_wake_mask(void)
{
    /* Only green button wakes from deep sleep */
    return (1ULL << KEY0_GPIO);
}
