// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "d1001_board.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_timer.h"
#include "driver/ledc.h"
#include "driver/gpio.h"
#include "soc/pmu_reg.h"
#include "esp_io_expander_pca9535.h"
#include <time.h>

static const char *TAG = "d1001_board";

static i2c_master_bus_handle_t s_i2c0 = NULL;
static i2c_master_bus_handle_t s_i2c1 = NULL;
static esp_io_expander_handle_t s_io_exp = NULL;
static adc_oneshot_unit_handle_t s_adc = NULL;
static adc_cali_handle_t s_battery_cali = NULL;
static adc_cali_handle_t s_usb_cali = NULL;
static i2c_master_dev_handle_t s_rtc = NULL;
static bool s_bl_init = false;
static bool s_charge_enabled = true;
#define ADC_SAMPLE_COUNT 16
#define ADC_CACHE_US     250000
#define BAT_CHARGE_DISABLE_MV 4150
#define BAT_CHARGE_ENABLE_MV  3800
static int s_battery_mv = 0;
static int s_usb_mv = 0;
static int64_t s_battery_sample_us = 0;
static int64_t s_usb_sample_us = 0;
#define PCF8563_ADDR       0x51
#define PCF8563_TIME_REG   0x02
#define PCF8563_VL_BIT     0x80
#define RTC_MIN_VALID_TIME 1704067200LL

static uint8_t from_bcd(uint8_t value) { return (value >> 4) * 10 + (value & 0x0f); }
static uint8_t to_bcd(uint8_t value) { return ((value / 10) << 4) | (value % 10); }

/* Gregorian calendar to Unix days, independent of process TZ. */
static int64_t days_from_civil(int year, unsigned month, unsigned day)
{
    year -= month <= 2;
    const int era = (year >= 0 ? year : year - 399) / 400;
    const unsigned year_of_era = (unsigned)(year - era * 400);
    const unsigned day_of_year = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
    const unsigned day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    return era * 146097LL + (int64_t)day_of_era - 719468LL;
}

esp_err_t d1001_rtc_get_time(time_t *out)
{
    if (!out || !s_rtc) return ESP_ERR_INVALID_STATE;
    uint8_t reg = PCF8563_TIME_REG;
    uint8_t raw[7];
    ESP_RETURN_ON_ERROR(i2c_master_transmit_receive(s_rtc, &reg, 1, raw, sizeof(raw), 100),
                        TAG, "RTC read failed");
    if (raw[0] & PCF8563_VL_BIT) return ESP_ERR_INVALID_STATE;

    const int second = from_bcd(raw[0] & 0x7f);
    const int minute = from_bcd(raw[1] & 0x7f);
    const int hour = from_bcd(raw[2] & 0x3f);
    const int day = from_bcd(raw[3] & 0x3f);
    const int month = from_bcd(raw[5] & 0x1f);
    const int year = 2000 + from_bcd(raw[6]);
    static const uint8_t month_days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    const bool leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    if (second > 59 || minute > 59 || hour > 23 || month < 1 || month > 12 ||
        day < 1 || day > month_days[month - 1] + (month == 2 && leap ? 1 : 0)) {
        return ESP_ERR_INVALID_STATE;
    }
    *out = (time_t)(days_from_civil(year, (unsigned)month, (unsigned)day) * 86400LL +
                   hour * 3600LL + minute * 60LL + second);
    return (int64_t)*out >= RTC_MIN_VALID_TIME ? ESP_OK : ESP_ERR_INVALID_STATE;
}

esp_err_t d1001_rtc_set_time(time_t value)
{
    if (!s_rtc || (int64_t)value < RTC_MIN_VALID_TIME) return ESP_ERR_INVALID_ARG;
    struct tm utc;
    gmtime_r(&value, &utc);
    if (utc.tm_year < 100 || utc.tm_year > 199) return ESP_ERR_INVALID_ARG;
    uint8_t data[] = {
        PCF8563_TIME_REG, to_bcd(utc.tm_sec), to_bcd(utc.tm_min), to_bcd(utc.tm_hour),
        to_bcd(utc.tm_mday), to_bcd(utc.tm_wday), to_bcd(utc.tm_mon + 1),
        to_bcd(utc.tm_year - 100),
    };
    return i2c_master_transmit(s_rtc, data, sizeof(data), 100);
}

esp_err_t d1001_board_init(void)
{
    /* Voltage regulator tuning */
    SET_PERI_REG_BITS(PMU_HP_ACTIVE_BIAS_REG, PMU_HP_ACTIVE_DCM_VSET, 26, PMU_HP_ACTIVE_DCM_VSET_S);
    vTaskDelay(pdMS_TO_TICKS(1000));

    /* I2C Bus 0 */
    i2c_master_bus_config_t i2c0_cfg = {
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .sda_io_num = D1001_I2C0_SDA,
        .scl_io_num = D1001_I2C0_SCL,
        .i2c_port = 0,
    };
    ESP_RETURN_ON_ERROR(i2c_new_master_bus(&i2c0_cfg, &s_i2c0), TAG, "I2C0 init failed");

    /* I2C Bus 1 */
    i2c_master_bus_config_t i2c1_cfg = {
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .sda_io_num = D1001_I2C1_SDA,
        .scl_io_num = D1001_I2C1_SCL,
        .i2c_port = 1,
    };
    ESP_RETURN_ON_ERROR(i2c_new_master_bus(&i2c1_cfg, &s_i2c1), TAG, "I2C1 init failed");

    i2c_device_config_t rtc_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = PCF8563_ADDR,
        .scl_speed_hz = 100000,
    };
    esp_err_t rtc_err = i2c_master_bus_add_device(s_i2c1, &rtc_cfg, &s_rtc);
    if (rtc_err != ESP_OK) {
        ESP_LOGW(TAG, "PCF8563T unavailable: %s", esp_err_to_name(rtc_err));
        s_rtc = NULL;
    }

    /* ADC for battery */
    adc_oneshot_unit_init_cfg_t adc_cfg = { .unit_id = ADC_UNIT_1 };
    ESP_RETURN_ON_ERROR(adc_oneshot_new_unit(&adc_cfg, &s_adc), TAG, "ADC init failed");
    adc_oneshot_chan_cfg_t chan_cfg = { .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12 };
    ESP_RETURN_ON_ERROR(adc_oneshot_config_channel(s_adc, ADC_CHANNEL_2, &chan_cfg),
                        TAG, "Battery ADC channel init failed"); /* GPIO18 = ADC1_CH2 */
    ESP_RETURN_ON_ERROR(adc_oneshot_config_channel(s_adc, ADC_CHANNEL_1, &chan_cfg),
                        TAG, "USB ADC channel init failed"); /* GPIO17 = ADC1_CH1 (USB) */

    adc_cali_curve_fitting_config_t battery_cali_cfg = {
        .unit_id = ADC_UNIT_1,
        .chan = ADC_CHANNEL_2,
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_12,
    };
    if (adc_cali_create_scheme_curve_fitting(&battery_cali_cfg, &s_battery_cali) != ESP_OK) {
        s_battery_cali = NULL;
        ESP_LOGW(TAG, "Battery ADC calibration unavailable; using fallback conversion");
    }
    adc_cali_curve_fitting_config_t usb_cali_cfg = {
        .unit_id = ADC_UNIT_1,
        .chan = ADC_CHANNEL_1,
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_12,
    };
    if (adc_cali_create_scheme_curve_fitting(&usb_cali_cfg, &s_usb_cali) != ESP_OK) {
        s_usb_cali = NULL;
        ESP_LOGW(TAG, "USB ADC calibration unavailable; using fallback conversion");
    }

    /* IO Expander (PCA9535 on I2C1) */
    ESP_RETURN_ON_ERROR(
        esp_io_expander_new_i2c_pca9535(s_i2c1, ESP_IO_EXPANDER_I2C_PCA9535_ADDRESS_000, &s_io_exp),
        TAG, "IO expander init failed");
    esp_io_expander_set_dir(s_io_exp, 0xffff, IO_EXPANDER_OUTPUT);
    /* PCA9535 output latches power up high. Mute the class-D amplifier before
     * codec/I2S initialization so an unclocked input cannot reach the speaker. */
    esp_io_expander_set_level(s_io_exp, D1001_EXP_AMP_EN, 0);

    /* Power rails */
    esp_io_expander_set_level(s_io_exp, D1001_EXP_PWR_HOLD, 1);
    vTaskDelay(pdMS_TO_TICKS(50));
    esp_io_expander_set_level(s_io_exp, D1001_EXP_LCD_BL_EN, 1);
    esp_io_expander_set_level(s_io_exp, D1001_EXP_LCD_PWR_EN, 1);
    vTaskDelay(pdMS_TO_TICKS(50));
    esp_io_expander_set_level(s_io_exp, D1001_EXP_LCD_RST, 1);
    esp_io_expander_set_level(s_io_exp, D1001_EXP_BAT_READ_EN, 1);
    esp_io_expander_set_level(s_io_exp, D1001_EXP_BAT_CHARGE_EN, 0); /* 0 = charge enabled */

    const gpio_config_t power_input_cfg = {
        .pin_bit_mask = (1ULL << D1001_BAT_CHARGE_STATE) | (1ULL << D1001_BAT_VSYS_PG),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&power_input_cfg), TAG, "Power status GPIO init failed");

    ESP_LOGI(TAG, "Board initialized");
    return ESP_OK;
}

i2c_master_bus_handle_t d1001_i2c0_handle(void) { return s_i2c0; }
i2c_master_bus_handle_t d1001_i2c1_handle(void) { return s_i2c1; }
esp_io_expander_handle_t d1001_io_expander(void) { return s_io_exp; }

/* ── Backlight (LEDC PWM on GPIO14) ─────────────────────────── */

esp_err_t d1001_backlight_set(int percent)
{
    if (!s_bl_init) {
        ledc_timer_config_t timer = {
            .speed_mode = LEDC_LOW_SPEED_MODE,
            .duty_resolution = LEDC_TIMER_10_BIT,
            .timer_num = LEDC_TIMER_0,
            .freq_hz = 5000,
            .clk_cfg = LEDC_AUTO_CLK,
        };
        ledc_timer_config(&timer);
        ledc_channel_config_t ch = {
            .gpio_num = D1001_LCD_BACKLIGHT,
            .speed_mode = LEDC_LOW_SPEED_MODE,
            .channel = LEDC_CHANNEL_0,
            .timer_sel = LEDC_TIMER_0,
            .duty = 0,
        };
        ledc_channel_config(&ch);
        s_bl_init = true;
    }
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    uint32_t duty = (1023 * percent) / 100;
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0);
    return ESP_OK;
}

esp_err_t d1001_backlight_on(void) { return d1001_backlight_set(80); }
esp_err_t d1001_backlight_off(void) { return d1001_backlight_set(0); }

esp_err_t d1001_lcd_power_off(void)
{
    if (!s_io_exp) return ESP_ERR_INVALID_STATE;
    ESP_RETURN_ON_ERROR(d1001_backlight_off(), TAG, "Backlight off failed");
    ESP_RETURN_ON_ERROR(
        esp_io_expander_set_level(s_io_exp, D1001_EXP_LCD_BL_EN, 0),
        TAG, "Backlight rail off failed");
    ESP_RETURN_ON_ERROR(
        esp_io_expander_set_level(s_io_exp, D1001_EXP_LCD_RST, 0),
        TAG, "LCD reset failed");
    vTaskDelay(pdMS_TO_TICKS(20));
    ESP_RETURN_ON_ERROR(
        esp_io_expander_set_level(s_io_exp, D1001_EXP_LCD_PWR_EN, 0),
        TAG, "LCD power rail off failed");
    ESP_LOGI(TAG, "LCD rails powered down");
    return ESP_OK;
}

/* ── Battery ─────────────────────────────────────────────────── */

static int read_adc_mv(adc_channel_t channel, adc_cali_handle_t cali)
{
    if (!s_adc) return -1;

    int samples[ADC_SAMPLE_COUNT];
    int count = 0;
    for (int i = 0; i < ADC_SAMPLE_COUNT; ++i) {
        int raw = 0;
        if (adc_oneshot_read(s_adc, channel, &raw) == ESP_OK) {
            samples[count++] = raw;
        }
    }
    if (count == 0) return -1;

    /* A small insertion sort keeps the driver dependency-free. Drop the single
     * highest and lowest reading, matching Seeed's outlier-resistant filter. */
    for (int i = 1; i < count; ++i) {
        int value = samples[i];
        int j = i - 1;
        while (j >= 0 && samples[j] > value) {
            samples[j + 1] = samples[j];
            --j;
        }
        samples[j + 1] = value;
    }
    const int first = count >= 4 ? 1 : 0;
    const int last = count >= 4 ? count - 1 : count;
    int64_t sum = 0;
    for (int i = first; i < last; ++i) sum += samples[i];
    const int raw = (int)(sum / (last - first));

    int millivolts = 0;
    if (cali && adc_cali_raw_to_voltage(cali, raw, &millivolts) == ESP_OK) {
        return millivolts;
    }
    return (raw * 3300) / 4095;
}

static void update_charge_control(int battery_mv)
{
    if (!s_io_exp || battery_mv <= 0) return;

    bool enable = s_charge_enabled;
    if (s_charge_enabled && battery_mv > BAT_CHARGE_DISABLE_MV) {
        enable = false;
    } else if (!s_charge_enabled && battery_mv < BAT_CHARGE_ENABLE_MV) {
        enable = true;
    }
    if (enable == s_charge_enabled) return;

    /* The charger enable input is active low. The wide hysteresis follows
     * Seeed's reference battery manager and prevents threshold oscillation. */
    esp_err_t err = esp_io_expander_set_level(
        s_io_exp, D1001_EXP_BAT_CHARGE_EN, enable ? 0 : 1);
    if (err == ESP_OK) {
        s_charge_enabled = enable;
        ESP_LOGI(TAG, "Battery charging %s at %d mV", enable ? "enabled" : "disabled",
                 battery_mv);
    } else {
        ESP_LOGE(TAG, "Failed to %s battery charging: %s",
                 enable ? "enable" : "disable", esp_err_to_name(err));
    }
}

int d1001_battery_voltage(void)
{
    const int64_t now = esp_timer_get_time();
    if (s_battery_sample_us && now - s_battery_sample_us < ADC_CACHE_US) return s_battery_mv;

    const int adc_mv = read_adc_mv(ADC_CHANNEL_2, s_battery_cali);
    if (adc_mv >= 0) {
        s_battery_mv = adc_mv * 2; /* onboard 1:1 divider */
        s_battery_sample_us = now;
        update_charge_control(s_battery_mv);
        ESP_LOGI(TAG, "Battery voltage: %d mV (calibrated, filtered)", s_battery_mv);
    } else {
        ESP_LOGE(TAG, "Battery ADC read failed");
    }
    return s_battery_sample_us ? s_battery_mv : -1;
}

int d1001_battery_percent(void)
{
    const int millivolts = d1001_battery_voltage();
    return millivolts >= 0 ? d1001_battery_percent_from_mv(millivolts) : -1;
}

int d1001_usb_voltage(void)
{
    const int64_t now = esp_timer_get_time();
    if (s_usb_sample_us && now - s_usb_sample_us < ADC_CACHE_US) return s_usb_mv;

    const int adc_mv = read_adc_mv(ADC_CHANNEL_1, s_usb_cali);
    if (adc_mv >= 0) {
        s_usb_mv = adc_mv * 2; /* onboard 1:1 divider */
        s_usb_sample_us = now;
    } else {
        ESP_LOGE(TAG, "USB ADC read failed");
    }
    return s_usb_sample_us ? s_usb_mv : -1;
}

bool d1001_is_usb_powered(void) { return d1001_usb_voltage() > 4000; }

d1001_battery_status_t d1001_battery_status(void)
{
    const bool usb_powered = d1001_is_usb_powered();
    if (usb_powered && !s_charge_enabled) return D1001_BATTERY_STATUS_FULL;
    return d1001_battery_status_from_signals(
        usb_powered, gpio_get_level(D1001_BAT_CHARGE_STATE) != 0);
}

void d1001_power_off(void)
{
    if (s_io_exp) {
        esp_io_expander_set_level(s_io_exp, D1001_EXP_PWR_HOLD, 0);
    }
}
