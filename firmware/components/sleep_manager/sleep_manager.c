/**
 * @file sleep_manager.c
 * @brief ESP-IDF deep sleep implementation for Vellum.
 */

#include "sleep_manager.h"

#include "esp_log.h"
#include "esp_sleep.h"
#include "sdkconfig.h"

static const char *TAG = "sleep_mgr";

static wake_reason_t s_wake_reason = WAKE_REASON_POWER_ON;

void sleep_manager_init(void)
{
    esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_causes();

    switch (cause) {
    case ESP_SLEEP_WAKEUP_TIMER:
        s_wake_reason = WAKE_REASON_TIMER;
        ESP_LOGI(TAG, "Wake reason: TIMER");
        break;

    case ESP_SLEEP_WAKEUP_EXT0:
    case ESP_SLEEP_WAKEUP_EXT1:
        s_wake_reason = WAKE_REASON_BUTTON;
        ESP_LOGI(TAG, "Wake reason: BUTTON (GPIO)");
        break;

    default:
        s_wake_reason = WAKE_REASON_POWER_ON;
        ESP_LOGI(TAG, "Wake reason: POWER_ON (cause=%d)", (int)cause);
        break;
    }
}

wake_reason_t sleep_manager_get_wake_reason(void)
{
    return s_wake_reason;
}

void sleep_manager_enter(uint32_t seconds, uint64_t button_wake_mask)
{
    if (seconds == 0) {
        seconds = CONFIG_VELLUM_FALLBACK_SLEEP_SEC;
    }

    ESP_LOGI(TAG, "Entering deep sleep for %lu seconds", (unsigned long)seconds);

    esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);

    if (button_wake_mask != 0) {
        esp_sleep_enable_ext1_wakeup(button_wake_mask, ESP_EXT1_WAKEUP_ANY_LOW);
    }

    esp_deep_sleep_start();
    /* does not return */
}

void sleep_manager_enter_permanent(uint64_t button_wake_mask)
{
    ESP_LOGI(TAG, "Entering permanent deep sleep (no timer)");

    if (button_wake_mask != 0) {
        esp_sleep_enable_ext1_wakeup(button_wake_mask, ESP_EXT1_WAKEUP_ANY_LOW);
    }

    esp_deep_sleep_start();
    /* does not return */
}
