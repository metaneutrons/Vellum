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
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "driver/ledc.h"
#include "driver/gpio.h"
#include "driver/usb_serial_jtag.h"
#include "sdkconfig.h"
#if CONFIG_VELLUM_PANEL_D1001
/* D1001 (ESP32-P4) battery/USB sensing. board REQUIRES d1001_board (+ its
 * transitive esp_io_expander include) on esp32p4 — see CMakeLists.txt — so the
 * public header can be included directly for proper signature type-checking. */
#include "d1001_board.h"
#endif

static const char *TAG = "board";

static adc_oneshot_unit_handle_t s_adc_handle = NULL;
static adc_cali_handle_t s_adc_cali = NULL;

/* One physical battery measurement per wake: the divider takes ~200ms to settle
 * (Seeed reTerminal-E reference), so re-reading on every caller would waste that
 * much awake time each time. RAM statics reset on deep-sleep wake, so this is
 * naturally fresh every cycle. */
static bool  s_batt_valid = false;
static float s_batt_voltage = 0.0f;

/* Time for the battery divider to settle after driving the enable line. Seeed's
 * reTerminal-E reference recommends 200ms; the previous 10ms under-read on the
 * larger E1003 board, whose monitor network settles more slowly, reporting ~0%. */
#define BATTERY_SETTLE_MS 200

/* ── Battery ──────────────────────────────────────────────────── */

static void battery_adc_init(void)
{
    adc_oneshot_unit_init_cfg_t cfg = { .unit_id = ADC_UNIT_1 };
    adc_oneshot_new_unit(&cfg, &s_adc_handle);
    adc_oneshot_chan_cfg_t chan = { .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12 };
    adc_oneshot_config_channel(s_adc_handle, ADC_CHANNEL_0, &chan);

    /* Per-chip factory calibration → accurate mV (raw/4095*3.3 ignores the real
     * ~3.1V full-scale at 12dB and the per-chip offset). Falls back to the raw
     * approximation if the SoC has no calibration scheme. */
    adc_cali_curve_fitting_config_t cali = {
        .unit_id  = ADC_UNIT_1,
        .chan     = ADC_CHANNEL_0,
        .atten    = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_12,
    };
    if (adc_cali_create_scheme_curve_fitting(&cali, &s_adc_cali) != ESP_OK) {
        s_adc_cali = NULL;
    }
}

float board_battery_voltage(void)
{
#if CONFIG_VELLUM_PANEL_D1001
    /* D1001 (ESP32-P4) uses its own board ADC, initialised by d1001_board_init()
     * at boot. The reTerminal divider + enable-GPIO path below doesn't exist on
     * this board, and running it (with board.c's ADC uninitialised on P4) is what
     * made the boot battery-gate read 0V and halt the device. */
    return d1001_battery_voltage() / 1000.0f;   /* d1001 API returns millivolts */
#endif
    if (s_batt_valid) return s_batt_voltage;   /* one physical read per wake */

    gpio_set_direction(CONFIG_VELLUM_BATTERY_EN_GPIO, GPIO_MODE_OUTPUT);
    gpio_set_level(CONFIG_VELLUM_BATTERY_EN_GPIO, 1);
    vTaskDelay(pdMS_TO_TICKS(BATTERY_SETTLE_MS));

    /* GPIO1 is VBAT_ADC on E1003. Take a few samples after the enable
     * transition so one ADC outlier cannot put a healthy device into the
     * low-battery recovery path. */
    int raw = 0;
    if (s_adc_handle) {
        int sum = 0;
        int valid_samples = 0;
        int sample = 0;
        for (int i = 0; i < 3; ++i) {
            if (adc_oneshot_read(s_adc_handle, ADC_CHANNEL_0, &sample) == ESP_OK) {
                sum += sample;
                valid_samples++;
            }
            if (i < 2) vTaskDelay(pdMS_TO_TICKS(10));
        }
        if (valid_samples > 0) raw = sum / valid_samples;
    }
    /* The enable pin is a dedicated VBAT_EN on E1003 (GPIO40). */
    gpio_set_level(CONFIG_VELLUM_BATTERY_EN_GPIO, 0);

    float v;
    if (s_adc_cali) {
        int mv = 0;
        adc_cali_raw_to_voltage(s_adc_cali, raw, &mv);
        v = (mv / 1000.0f) * 2.0f;               /* ×2 for the onboard divider */
    } else {
        v = (raw / 4095.0f) * 3.3f * 2.0f;       /* uncalibrated fallback */
    }
    ESP_LOGI(TAG, "Battery ADC raw=%d -> %.2fV (settle %dms)", raw, v, BATTERY_SETTLE_MS);

    s_batt_voltage = v;
    s_batt_valid = true;
    return v;
}

int board_battery_level(void)
{
#if CONFIG_VELLUM_PANEL_D1001
    return d1001_battery_percent();
#endif
    float v = board_battery_voltage();
    int level = (int)((v - 3.0f) / (4.2f - 3.0f) * 100.0f);
    if (level < 0) level = 0;
    if (level > 100) level = 100;
    return level;
}

bool board_is_usb_powered(void)
{
#if CONFIG_VELLUM_PANEL_D1001
    /* D1001 has a dedicated VBUS sense channel (mV); ~5V present on USB. Unlike
     * the reTerminal, USB detection is independent of the battery voltage. */
    return d1001_usb_voltage() > 4000;
#endif
    /* E-Series hardware exposes VBAT_ADC but no MCU-readable VBUS sense, so USB
     * power cannot be inferred from the battery node (the charger holds the
     * Li-ion cell at <=4.2 V even while USB powers the system). Instead, use the
     * ESP32-S3 native USB-Serial-JTAG host-presence signal: it reports connected
     * whenever a USB *data* host (the provisioning/OTA browser, or any serial
     * monitor) is sending SOF packets — which is exactly when the device is
     * externally powered and must NOT deep-sleep at the low-battery gate. This
     * restores the "externally powered" bypass main.c's battery check relies on;
     * without it, a bench unit being provisioned over USB with a flat/absent
     * cell reads low, cannot tell it is on USB, and deep-sleeps mid-provision
     * (killing the serial task → the browser "connection times out"). A dumb
     * power bank sends no SOF and correctly reads as not-connected, so battery
     * brown-out protection is preserved for the on-battery case. */
    return usb_serial_jtag_is_connected();
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
