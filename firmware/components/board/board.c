// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file board.c
 * @brief reTerminal E-Series board peripherals (battery, LED, buzzer).
 */

#include "board.h"
#include "sy6974b_power.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "driver/ledc.h"
#include "driver/gpio.h"
#include "driver/usb_serial_jtag.h"
#include <sys/time.h>
#if CONFIG_VELLUM_PANEL_GDEY075T7 || CONFIG_VELLUM_PANEL_GDEP073E01 || CONFIG_VELLUM_PANEL_E1003
#include "driver/i2c_master.h"
#endif
#include "sdkconfig.h"
#if CONFIG_VELLUM_PANEL_D1001
/* D1001 (ESP32-P4) battery/USB sensing. board REQUIRES d1001_board (+ its
 * transitive esp_io_expander include) on esp32p4 — see CMakeLists.txt — so the
 * public header can be included directly for proper signature type-checking. */
#include "d1001_board.h"
/* board_buzzer_beep() plays a recorded chime on this model — the LEDC channel it
 * would otherwise use drives the LCD backlight. */
#include "vellum_audio.h"
#endif

static const char *TAG = "board";

static adc_oneshot_unit_handle_t s_adc_handle = NULL;
static adc_cali_handle_t s_adc_cali = NULL;
static adc_channel_t s_battery_adc_channel = ADC_CHANNEL_0;

#if CONFIG_VELLUM_PANEL_GDEY075T7 || CONFIG_VELLUM_PANEL_GDEP073E01 || CONFIG_VELLUM_PANEL_E1003
/* Current E-Series revisions route USB-C VBUS through an SY6974B charger, and
 * none wire the S3's native USB to the connector — E1001/E1002 use a CH340C and
 * E1003 a CH340K on UART0. REG08 exposes BUS_STAT and power-good over the
 * model-specific I2C pins. Early E1002 revision 1.0 instead uses a non-I2C
 * ETA6003; the failed probe is retained as an unknown source in telemetry. */
#define CHARGER_I2C_PORT       0
#define CHARGER_I2C_ADDRESS    0x6B
#define CHARGER_STATUS_REG     0x08
#define CHARGER_READ_RETRIES   3
#define CHARGER_TIMEOUT_MS     50

#if CONFIG_VELLUM_PANEL_GDEY075T7 || CONFIG_VELLUM_PANEL_GDEP073E01
/* E1001 and E1002 carry the charger on I2C1 (SDA39/SCL40). For E1001 this is
 * corroborated by Seeed's own Zephyr board port, whose devicetree places
 * `charger: sy6974b@6b` on i2c1 while i2c0 (SDA19/SCL20) holds only the SHT4x
 * and the PCF8563 RTC — and whose battery divider enable (GPIO21, ADC0 ch0)
 * matches this repo's VELLUM_BATTERY_EN_GPIO default. */
#define CHARGER_I2C_SDA_GPIO   39
#define CHARGER_I2C_SCL_GPIO   40
#else
#define CHARGER_I2C_SDA_GPIO   19
#define CHARGER_I2C_SCL_GPIO   20
#endif

static i2c_master_bus_handle_t s_charger_bus = NULL;
static i2c_master_dev_handle_t s_charger = NULL;
static bool s_charger_status_valid = false;
static uint8_t s_charger_status = 0;
static TickType_t s_charger_status_tick = 0;
#define CHARGER_STATUS_CACHE_MS 250

static void charger_init(void)
{
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = CHARGER_I2C_PORT,
        .sda_io_num = CHARGER_I2C_SDA_GPIO,
        .scl_io_num = CHARGER_I2C_SCL_GPIO,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    esp_err_t err = i2c_new_master_bus(&bus_cfg, &s_charger_bus);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "%s charger I2C init failed: %s",
                 CONFIG_VELLUM_DISPLAY_MODEL, esp_err_to_name(err));
        s_charger_bus = NULL;
        return;
    }

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = CHARGER_I2C_ADDRESS,
        .scl_speed_hz = 100000,
    };
    err = i2c_master_bus_add_device(s_charger_bus, &dev_cfg, &s_charger);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "%s charger device init failed: %s",
                 CONFIG_VELLUM_DISPLAY_MODEL, esp_err_to_name(err));
        i2c_del_master_bus(s_charger_bus);
        s_charger_bus = NULL;
        s_charger = NULL;
    }
}

static bool charger_read_status(uint8_t *status_out)
{
    if (!s_charger || !status_out) return false;

    const TickType_t now = xTaskGetTickCount();
    if (s_charger_status_valid &&
        now - s_charger_status_tick < pdMS_TO_TICKS(CHARGER_STATUS_CACHE_MS)) {
        *status_out = s_charger_status;
        return true;
    }

    const uint8_t reg = CHARGER_STATUS_REG;
    for (int attempt = 0; attempt < CHARGER_READ_RETRIES; ++attempt) {
        uint8_t status = 0;
        esp_err_t err = i2c_master_transmit_receive(
            s_charger, &reg, sizeof(reg), &status, sizeof(status),
            CHARGER_TIMEOUT_MS);
        if (err == ESP_OK) {
            uint8_t bus = (status >> 5) & 0x07;
            const sy6974b_charge_state_t charge = sy6974b_status_charge_state(status);
            s_charger_status = status;
            s_charger_status_tick = now;
            s_charger_status_valid = true;
            *status_out = status;
            ESP_LOGI(TAG, "%s charger REG08=0x%02x (bus=%u, charge=%u, USB=%s)",
                     CONFIG_VELLUM_DISPLAY_MODEL, status, bus, (unsigned)charge,
                     sy6974b_status_has_external_power(status) ? "yes" : "no");
            return true;
        } else if (attempt == CHARGER_READ_RETRIES - 1) {
            ESP_LOGW(TAG, "%s charger status read failed: %s",
                     CONFIG_VELLUM_DISPLAY_MODEL, esp_err_to_name(err));
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    return false;
}

static bool charger_reports_usb_power(void)
{
    uint8_t status = 0;
    return charger_read_status(&status) && sy6974b_status_has_external_power(status);
}
#endif

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
    adc_unit_t unit = ADC_UNIT_1;
    esp_err_t err = adc_oneshot_io_to_channel(
        CONFIG_VELLUM_BATTERY_ADC_GPIO, &unit, &s_battery_adc_channel);
    if (err != ESP_OK || unit != ADC_UNIT_1) {
        ESP_LOGE(TAG, "Battery ADC GPIO%d is not on ADC1: %s",
                 CONFIG_VELLUM_BATTERY_ADC_GPIO, esp_err_to_name(err));
        return;
    }

    adc_oneshot_unit_init_cfg_t cfg = { .unit_id = unit };
    err = adc_oneshot_new_unit(&cfg, &s_adc_handle);
    if (err != ESP_OK) {
        s_adc_handle = NULL;
        ESP_LOGE(TAG, "Battery ADC unit init failed: %s", esp_err_to_name(err));
        return;
    }
    adc_oneshot_chan_cfg_t chan = { .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12 };
    err = adc_oneshot_config_channel(s_adc_handle, s_battery_adc_channel, &chan);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Battery ADC channel init failed: %s", esp_err_to_name(err));
        adc_oneshot_del_unit(s_adc_handle);
        s_adc_handle = NULL;
        return;
    }

    /* Per-chip factory calibration → accurate mV (raw/4095*3.3 ignores the real
     * ~3.1V full-scale at 12dB and the per-chip offset). Falls back to the raw
     * approximation if the SoC has no calibration scheme. */
    adc_cali_curve_fitting_config_t cali = {
        .unit_id  = ADC_UNIT_1,
        .chan     = s_battery_adc_channel,
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

    /* Take eight readings like Seeed's reference implementation, sort them,
     * and discard both extremes so a single ADC spike cannot trigger a false
     * critical-battery shutdown. */
    int samples[8];
    int sample_count = 0;
    if (s_adc_handle) {
        for (int i = 0; i < 8; ++i) {
            int sample = 0;
            if (adc_oneshot_read(s_adc_handle, s_battery_adc_channel, &sample) == ESP_OK) {
                samples[sample_count++] = sample;
            }
        }
    }
    /* The enable pin is model-specific (E1001/E1002 GPIO21, E1003 GPIO40). */
    gpio_set_level(CONFIG_VELLUM_BATTERY_EN_GPIO, 0);

    if (sample_count == 0) {
        ESP_LOGE(TAG, "Battery ADC read failed");
        return -1.0f;
    }
    for (int i = 1; i < sample_count; ++i) {
        const int value = samples[i];
        int j = i - 1;
        while (j >= 0 && samples[j] > value) {
            samples[j + 1] = samples[j];
            --j;
        }
        samples[j + 1] = value;
    }
    const int first = sample_count >= 4 ? 1 : 0;
    const int last = sample_count >= 4 ? sample_count - 1 : sample_count;
    int sum = 0;
    for (int i = first; i < last; ++i) sum += samples[i];
    const int raw = sum / (last - first);

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
    const float voltage = board_battery_voltage();
    if (voltage < 0.0f) return -1;
    return e_series_battery_percent_from_mv((int)(voltage * 1000.0f + 0.5f));
}

board_battery_status_t board_battery_status(void)
{
#if CONFIG_VELLUM_PANEL_D1001
    switch (d1001_battery_status()) {
    case D1001_BATTERY_STATUS_DISCHARGING: return BOARD_BATTERY_STATUS_DISCHARGING;
    case D1001_BATTERY_STATUS_CHARGING: return BOARD_BATTERY_STATUS_CHARGING;
    case D1001_BATTERY_STATUS_FULL: return BOARD_BATTERY_STATUS_FULL;
    default: return BOARD_BATTERY_STATUS_UNKNOWN;
    }
#else
    uint8_t status = 0;
    if (!charger_read_status(&status)) return BOARD_BATTERY_STATUS_UNKNOWN;
    if (!sy6974b_status_has_external_power(status)) return BOARD_BATTERY_STATUS_DISCHARGING;
    switch (sy6974b_status_charge_state(status)) {
    case SY6974B_CHARGE_PRECHARGE:
    case SY6974B_CHARGE_FAST:
        return BOARD_BATTERY_STATUS_CHARGING;
    case SY6974B_CHARGE_DONE:
        return BOARD_BATTERY_STATUS_FULL;
    default:
        return BOARD_BATTERY_STATUS_UNKNOWN;
    }
#endif
}

const char *board_battery_status_name(board_battery_status_t status)
{
    switch (status) {
    case BOARD_BATTERY_STATUS_DISCHARGING: return "discharging";
    case BOARD_BATTERY_STATUS_CHARGING: return "charging";
    case BOARD_BATTERY_STATUS_FULL: return "full";
    default: return "unknown";
    }
}

bool board_is_usb_powered(void)
{
#if CONFIG_VELLUM_PANEL_D1001
    /* D1001 has a dedicated VBUS sense channel (mV); ~5V present on USB. Unlike
     * the reTerminal, USB detection is independent of the battery voltage. */
    return d1001_is_usb_powered();
#endif
#if CONFIG_VELLUM_PANEL_GDEY075T7 || CONFIG_VELLUM_PANEL_GDEP073E01 || CONFIG_VELLUM_PANEL_E1003
    /* Read the charger because the CH34x USB data path cannot expose VBUS to the
     * S3. An early E1002 with ETA6003 returns false here, while telemetry keeps
     * that failed probe distinct from a confirmed battery source. */
    return charger_reports_usb_power();
#else
    /* Native-USB models expose host presence directly through the
     * ESP32-S3 USB-Serial-JTAG controller. */
    return usb_serial_jtag_is_connected();
#endif
}

esp_err_t board_set_utc_time(time_t value)
{
    struct timeval tv = { .tv_sec = value, .tv_usec = 0 };
    if (settimeofday(&tv, NULL) != 0) return ESP_FAIL;
#if CONFIG_VELLUM_PANEL_D1001
    esp_err_t rtc_err = d1001_rtc_set_time(value);
    if (rtc_err != ESP_OK) {
        ESP_LOGW(TAG, "System time set, but D1001 RTC write failed: %s",
                 esp_err_to_name(rtc_err));
    }
#endif
    return ESP_OK;
}

/* ── Status LED (active-low) ──────────────────────────────────── */

static void led_init(void)
{
#if CONFIG_VELLUM_PANEL_D1001
    gpio_set_direction(D1001_LED_R, GPIO_MODE_OUTPUT);
    gpio_set_level(D1001_LED_R, 1);
#else
    gpio_set_direction(CONFIG_VELLUM_LED_GPIO, GPIO_MODE_OUTPUT);
    gpio_set_level(CONFIG_VELLUM_LED_GPIO, 1);
#endif
}

void board_led_on(void)
{
#if CONFIG_VELLUM_PANEL_D1001
    /* GPIO6 is the D1001 C6 SDIO command line, not a status LED. */
    gpio_set_direction(D1001_LED_R, GPIO_MODE_OUTPUT);
    gpio_set_level(D1001_LED_R, 0);
#else
    gpio_set_level(CONFIG_VELLUM_LED_GPIO, 0);
#endif
}

void board_led_off(void)
{
#if CONFIG_VELLUM_PANEL_D1001
    gpio_set_level(D1001_LED_R, 1);
#else
    gpio_set_level(CONFIG_VELLUM_LED_GPIO, 1);
#endif
}

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
#if CONFIG_VELLUM_PANEL_D1001
    /* D1001 has an ES8311-driven speaker, not the E-Series PWM buzzer, and the
     * generic LEDC channel used below is the one driving the LCD backlight — a
     * "beep" here used to leave the display dark at 0% duty, so this was a no-op
     * and the model was simply silent.
     *
     * It now plays a recorded chime. The tone arguments have no meaning on a
     * sample: every event sounds the same here, where the E-Series distinguishes
     * them by pitch. Mapping events to distinct sounds would need a second asset
     * and an event-shaped API, not a frequency. */
    (void)freq;
    (void)ms;
    vellum_audio_play_chime();
    return;
#else
    ledc_set_freq(LEDC_LOW_SPEED_MODE, LEDC_TIMER_0, freq);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 128);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
    vTaskDelay(pdMS_TO_TICKS(ms));
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
#endif
}

/* ── Init ─────────────────────────────────────────────────────── */

void board_init(void)
{
#if !CONFIG_VELLUM_PANEL_D1001
    battery_adc_init();
#endif
#if CONFIG_VELLUM_PANEL_GDEY075T7 || CONFIG_VELLUM_PANEL_GDEP073E01 || CONFIG_VELLUM_PANEL_E1003
    charger_init();
    /* Read once at boot even when the battery is healthy. Besides priming the
     * hardware path, the REG08 log makes field diagnostics distinguish a bad
     * cable/charger from an ADC or low-battery-gate problem. */
    (void)charger_reports_usb_power();
#endif
    led_init();
    buzzer_init();
    ESP_LOGI(TAG, "Board peripherals initialized (battery, LED, buzzer)");
}
