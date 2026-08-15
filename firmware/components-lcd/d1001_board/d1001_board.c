// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "d1001_board.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_adc/adc_oneshot.h"
#include "driver/ledc.h"
#include "soc/pmu_reg.h"
#include "esp_io_expander_pca9535.h"
#include <time.h>

static const char *TAG = "d1001_board";

static i2c_master_bus_handle_t s_i2c0 = NULL;
static i2c_master_bus_handle_t s_i2c1 = NULL;
static esp_io_expander_handle_t s_io_exp = NULL;
static adc_oneshot_unit_handle_t s_adc = NULL;
static i2c_master_dev_handle_t s_rtc = NULL;
static bool s_bl_init = false;
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
    adc_oneshot_config_channel(s_adc, ADC_CHANNEL_2, &chan_cfg); /* GPIO18 = ADC1_CH2 */
    adc_oneshot_config_channel(s_adc, ADC_CHANNEL_1, &chan_cfg); /* GPIO17 = ADC1_CH1 (USB) */

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

/* ── Battery ─────────────────────────────────────────────────── */

int d1001_battery_voltage(void)
{
    int raw = 0;
    if (s_adc) adc_oneshot_read(s_adc, ADC_CHANNEL_2, &raw);
    return (int)((raw / 4095.0f) * 3.3f * 2.0f * 1000.0f); /* mV, voltage divider 2:1 */
}

int d1001_battery_percent(void)
{
    int mv = d1001_battery_voltage();
    int pct = (mv - 3000) * 100 / (4200 - 3000);
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    return pct;
}

int d1001_usb_voltage(void)
{
    int raw = 0;
    if (s_adc) adc_oneshot_read(s_adc, ADC_CHANNEL_1, &raw);
    return (int)((raw / 4095.0f) * 3.3f * 2.0f * 1000.0f);
}

void d1001_power_off(void)
{
    if (s_io_exp) {
        esp_io_expander_set_level(s_io_exp, D1001_EXP_PWR_HOLD, 0);
    }
}
