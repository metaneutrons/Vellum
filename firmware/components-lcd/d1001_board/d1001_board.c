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

static const char *TAG = "d1001_board";

static i2c_master_bus_handle_t s_i2c0 = NULL;
static i2c_master_bus_handle_t s_i2c1 = NULL;
static esp_io_expander_handle_t s_io_exp = NULL;
static adc_oneshot_unit_handle_t s_adc = NULL;
static bool s_bl_init = false;

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
