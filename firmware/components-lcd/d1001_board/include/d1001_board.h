// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "esp_io_expander.h"

/* ── Pin Definitions ─────────────────────────────────────────── */

/* I2C Bus 0 (Touch, Camera, Light sensor) */
#define D1001_I2C0_SCL          GPIO_NUM_38
#define D1001_I2C0_SDA          GPIO_NUM_37

/* I2C Bus 1 (ADC, Codec, IMU, RTC, IO-Expander) */
#define D1001_I2C1_SCL          GPIO_NUM_21
#define D1001_I2C1_SDA          GPIO_NUM_20

/* Display */
#define D1001_LCD_BACKLIGHT     GPIO_NUM_14
#define D1001_LCD_TOUCH_INT     GPIO_NUM_16

/* IO-Expander pin masks */
#define D1001_EXP_PWR_HOLD      (1ULL << 8)
#define D1001_EXP_LCD_PWR_EN    (1ULL << 0)
#define D1001_EXP_LCD_BL_EN     (1ULL << 7)
#define D1001_EXP_LCD_RST       (1ULL << 2)
#define D1001_EXP_BAT_READ_EN   (1ULL << 6)
#define D1001_EXP_BAT_CHARGE_EN (1ULL << 10)
#define D1001_EXP_AMP_EN        (1ULL << 11)

/* Battery */
#define D1001_BAT_ADC           GPIO_NUM_18
#define D1001_BAT_CHARGE_STATE  GPIO_NUM_15
#define D1001_USB_INSERT_DET    GPIO_NUM_17

/* Button */
#define D1001_BUTTON            GPIO_NUM_3

/* LED */
#define D1001_LED_R             GPIO_NUM_22
#define D1001_LED_G             GPIO_NUM_36
#define D1001_LED_B             GPIO_NUM_23

/* WiFi (ESP32-C6 SDIO) */
#define D1001_WIFI_RESET        GPIO_NUM_13
#define D1001_WIFI_SDIO_CLK     GPIO_NUM_11
#define D1001_WIFI_SDIO_CMD     GPIO_NUM_6
#define D1001_WIFI_SDIO_D0      GPIO_NUM_7
#define D1001_WIFI_SDIO_D1      GPIO_NUM_8
#define D1001_WIFI_SDIO_D2      GPIO_NUM_9
#define D1001_WIFI_SDIO_D3      GPIO_NUM_10

/* MIPI-DSI */
#define D1001_DSI_LANE_NUM      2
#define D1001_DSI_LANE_MBPS     1000
#define D1001_DSI_PHY_LDO_CHAN  3
#define D1001_DSI_PHY_LDO_MV   2500

/* LCD Timing (800x1280 @ 60Hz) */
#define D1001_LCD_H_RES         800
#define D1001_LCD_V_RES         1280
#define D1001_LCD_HSYNC         40
#define D1001_LCD_HBP           140
#define D1001_LCD_HFP           40
#define D1001_LCD_VSYNC         4
#define D1001_LCD_VBP           16
#define D1001_LCD_VFP           16

/* ── API ─────────────────────────────────────────────────────── */

/**
 * @brief Initialize board power (I2C, IO-Expander, power rails)
 * Must be called first before any other board function.
 */
esp_err_t d1001_board_init(void);

/** @brief Get I2C bus 0 handle (touch/camera) */
i2c_master_bus_handle_t d1001_i2c0_handle(void);

/** @brief Get I2C bus 1 handle (codec/IMU/IO-expander) */
i2c_master_bus_handle_t d1001_i2c1_handle(void);

/** @brief Get IO-expander handle */
esp_io_expander_handle_t d1001_io_expander(void);

/** @brief Set backlight brightness (0-100%) */
esp_err_t d1001_backlight_set(int percent);

/** @brief Backlight on (default brightness) */
esp_err_t d1001_backlight_on(void);

/** @brief Backlight off */
esp_err_t d1001_backlight_off(void);

/** @brief Read battery voltage in mV */
int d1001_battery_voltage(void);

/** @brief Read battery percent (0-100) */
int d1001_battery_percent(void);

/** @brief Read USB voltage in mV */
int d1001_usb_voltage(void);

/** @brief Power off the board */
void d1001_power_off(void);
