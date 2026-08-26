// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file sleep_manager.c
 * @brief ESP-IDF deep sleep implementation for Vellum.
 */

#include "sleep_manager.h"

#include <inttypes.h>

#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_system.h"
#include "driver/gpio.h"
#include "driver/rtc_io.h"
#include "soc/soc_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "board.h"
#include "buttons.h"

static const char *TAG = "sleep_mgr";

static wake_reason_t s_wake_reason = WAKE_REASON_POWER_ON;
static bool s_button_refresh_requested;

/* The wake mask is configured for active-low buttons.  When USB power keeps
 * the MCU awake there is no deep-sleep wake event, so poll that same mask to
 * preserve the physical refresh button's behaviour. */
static bool wake_button_pressed(uint64_t button_wake_mask)
{
#ifdef CONFIG_VELLUM_BUTTON_ACTIVE_HIGH
    const int pressed_level = 1;
#else
    const int pressed_level = 0;
#endif
    for (int gpio = 0; gpio < 64; ++gpio) {
        if ((button_wake_mask & (1ULL << gpio)) &&
            gpio_get_level((gpio_num_t)gpio) == pressed_level) {
            return true;
        }
    }
    return false;
}

/**
 * @brief Arm the EXT1 wake pins so a resting button reads as released.
 *
 * The buttons carry no external pull-up on any E-Series board. Seeed's own board
 * ports declare all three as `GPIO_PULL_UP`, i.e. the SoC's internal one, and
 * `buttons_init()` duly enables it — but only in the DIGITAL domain. That pull
 * does not apply once a pin is handed to the RTC domain for EXT1, and because
 * RTC_PERIPH is deliberately kept powered here, the HOLD feature that would
 * otherwise carry a pull into sleep does not act either. ESP-IDF requires
 * rtc_gpio_pullup_en() in exactly this configuration.
 *
 * Without it the wake pin floats through deep sleep while ANY_LOW is armed,
 * which is a wake condition already satisfied. The display woke early, reported
 * a button nobody had touched, and used to beep about it. It also never served
 * out its assigned interval, so the cost was battery as much as noise.
 *
 * rtc_gpio_init() has to come first: it selects the RTC function for the pad,
 * and the pull registers only reach the pin once it is under RTC control. That
 * also detaches the digital input, so the level is logged before the handover —
 * it describes what the digital domain saw, not what the RTC pad will hold.
 * Proof that the pull works is on the other side of the sleep, in the wake
 * reason and the EXT1 status mask that sleep_manager_init() reports.
 */
static void arm_button_wake(uint64_t button_wake_mask)
{
    if (button_wake_mask == 0) return;

    esp_err_t err = esp_sleep_enable_ext1_wakeup_io(button_wake_mask,
                                                    ESP_EXT1_WAKEUP_ANY_LOW);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "EXT1 wake could not be armed: %s", esp_err_to_name(err));
        return;
    }
    esp_sleep_pd_config(ESP_PD_DOMAIN_RTC_PERIPH, ESP_PD_OPTION_ON);

    for (int gpio = 0; gpio < SOC_GPIO_PIN_COUNT; ++gpio) {
        if (!(button_wake_mask & (1ULL << gpio))) continue;
        const gpio_num_t pin = (gpio_num_t)gpio;

        if (!rtc_gpio_is_valid_gpio(pin)) {
            /* Not an RTC IO, so nothing can hold it through sleep. Worth saying
             * out loud rather than silently accepting a wake that will misfire. */
            ESP_LOGW(TAG, "GPIO%d is no RTC IO; its idle level cannot be held", gpio);
            continue;
        }

        const int digital_level = gpio_get_level(pin);
        ESP_ERROR_CHECK_WITHOUT_ABORT(rtc_gpio_init(pin));
        /* Buttons are active low, so the idle level to hold is high. */
        ESP_ERROR_CHECK_WITHOUT_ABORT(rtc_gpio_pulldown_dis(pin));
        ESP_ERROR_CHECK_WITHOUT_ABORT(rtc_gpio_pullup_en(pin));
        ESP_LOGI(TAG, "EXT1 wake armed on GPIO%d (level before handover=%d, RTC pull-up on)",
                 gpio, digital_level);
    }
}

/**
 * @brief Classify the wake, reading ALL causes rather than one of them.
 *
 * `esp_sleep_get_wakeup_cause()` is deprecated in IDF 6.0, and its own
 * documentation says why it had to be: it "will only return one wakeup source.
 * If multiple wakeup sources wake up at the same time, the wakeup source
 * information may be lost." Every sleep here arms a timer AND a button, so two
 * simultaneous sources are the normal configuration, not a corner case.
 *
 * When both fired, the BUTTON wins. Somebody is standing at the display and
 * pressed it; that the interval happened to expire in the same second is a
 * coincidence, and letting it swallow the press would make the button feel
 * broken at random moments. The choice is load-bearing rather than cosmetic,
 * because WAKE_REASON_BUTTON is what sends main() into the factory-reset hold
 * check and into buttons_poll().
 */
void sleep_manager_init(void)
{
    const uint32_t causes = esp_sleep_get_wakeup_causes();
    const uint32_t button_causes =
        BIT(ESP_SLEEP_WAKEUP_EXT0) | BIT(ESP_SLEEP_WAKEUP_EXT1);

    if (causes & button_causes) {
        s_wake_reason = WAKE_REASON_BUTTON;
        /* Naming the pins turns "a button woke us" into a checkable claim. A
         * mask here for a button nobody pressed means the pin was not held at
         * its idle level through sleep; see arm_button_wake(). */
        ESP_LOGI(TAG, "Wake reason: BUTTON (GPIO), causes=0x%" PRIx32
                      ", ext1 status=0x%" PRIx64,
                 causes, esp_sleep_get_ext1_wakeup_status());
    } else if (causes & BIT(ESP_SLEEP_WAKEUP_TIMER)) {
        s_wake_reason = WAKE_REASON_TIMER;
        ESP_LOGI(TAG, "Wake reason: TIMER");
    } else {
        /* Includes BIT(ESP_SLEEP_WAKEUP_UNDEFINED), which the bitmap sets when
         * the reset was not an exit from deep sleep at all. */
        s_wake_reason = WAKE_REASON_POWER_ON;
        ESP_LOGI(TAG, "Wake reason: POWER_ON (causes=0x%" PRIx32 ")", causes);
    }
}

wake_reason_t sleep_manager_get_wake_reason(void)
{
    return s_wake_reason;
}

void sleep_manager_enter(uint32_t seconds, uint64_t button_wake_mask)
{
    s_button_refresh_requested = false;
    if (seconds == 0) {
        seconds = CONFIG_VELLUM_FALLBACK_SLEEP_SEC;
    }

#if !defined(CONFIG_VELLUM_PANEL_D1001)
    /* A cabled display is expected to remain responsive for provisioning and
     * diagnostics. Never enter ESP deep sleep while the board can positively
     * identify external USB power. Poll the power state while waiting so an
     * unplugged display falls back to normal battery-saving sleep promptly. */
    if (board_is_usb_powered()) {
        ESP_LOGI(TAG, "External USB power present; staying awake for %lu seconds",
                 (unsigned long)seconds);
        for (uint32_t elapsed = 0;
             elapsed < seconds && board_is_usb_powered();
             ++elapsed) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            /* The ISR catches a short press between polling ticks; the GPIO
             * level check also covers a button that remains held. */
            if (buttons_key0_pressed() || wake_button_pressed(button_wake_mask)) {
                ESP_LOGI(TAG, "Refresh button pressed while USB powered");
                s_button_refresh_requested = true;
                board_buzzer_beep(1000, 100);
                return;
            }
        }
        return;
    }
#endif

#if defined(CONFIG_VELLUM_PANEL_D1001)
    /* LCD: delay then return to caller (no restart, no deep sleep) */
    extern volatile bool s_button_pressed;
    uint32_t delay = (seconds > 30) ? 30 : seconds;
    ESP_LOGI(TAG, "LCD mode: retrying in %lu seconds", (unsigned long)delay);
    for (uint32_t i = 0; i < delay; i++) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (s_button_pressed) {
            s_button_pressed = false;
            ESP_LOGI(TAG, "Button pressed — retrying now");
            break;
        }
    }
    return;
#else
    ESP_LOGI(TAG, "Entering deep sleep for %lu seconds", (unsigned long)seconds);

    esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL);
    arm_button_wake(button_wake_mask);

    esp_deep_sleep_start();
    /* does not return */
#endif
}

bool sleep_manager_take_button_refresh_request(void)
{
    bool requested = s_button_refresh_requested;
    s_button_refresh_requested = false;
    return requested;
}

void sleep_manager_enter_deep(uint32_t seconds, uint64_t button_wake_mask)
{
    if (seconds == 0) seconds = CONFIG_VELLUM_FALLBACK_SLEEP_SEC;
    ESP_LOGI(TAG, "Entering requested deep sleep for %lu seconds",
             (unsigned long)seconds);
    ESP_ERROR_CHECK_WITHOUT_ABORT(
        esp_sleep_enable_timer_wakeup((uint64_t)seconds * 1000000ULL));
    arm_button_wake(button_wake_mask);
    esp_deep_sleep_start();
}

void sleep_manager_enter_permanent(uint64_t button_wake_mask)
{
#if defined(CONFIG_VELLUM_PANEL_D1001)
    ESP_LOGI(TAG, "LCD mode: waiting for button then restart");
    while (1) vTaskDelay(pdMS_TO_TICKS(1000));
#else
    ESP_LOGI(TAG, "Entering permanent deep sleep (no timer)");
    /* No timer here, so the wake pin is the ONLY way back. A floating pin was
     * bad enough with a timer; here it decides whether the display ever
     * returns. */
    arm_button_wake(button_wake_mask);

    esp_deep_sleep_start();
    /* does not return */
#endif
}
