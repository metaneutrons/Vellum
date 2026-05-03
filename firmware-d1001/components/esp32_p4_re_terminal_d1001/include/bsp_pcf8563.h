
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include "esp_err.h"
#include "esp_check.h"
#include "esp_log.h"
#include "driver/i2c_master.h"

#ifdef __cplusplus
extern "C" {
#endif

#define PCF8563_I2C_ADDRESS     (0x51)

#define PCF8563_STAT1_REG       (0x00)
#define PCF8563_STAT2_REG       (0x01)
#define PCF8563_SEC_REG         (0x02)
#define PCF8563_MIN_REG         (0x03)
#define PCF8563_HR_REG          (0x04)
#define PCF8563_DAY_REG         (0x05)
#define PCF8563_WEEKDAY_REG     (0x06)
#define PCF8563_MONTH_REG       (0x07)
#define PCF8563_YEAR_REG        (0x08)
#define PCF8563_ALRM_MIN_REG    (0x09)
#define PCF8563_SQW_REG         (0x0D)
#define PCF8563_TIMER1_REG      (0x0E)
#define PCF8563_TIMER2_REG      (0x0F)

#define PCF8563_VOL_LOW_MASK    (0x80)
#define PCF8563_MINUTES_MASK    (0x7F)
#define PCF8563_HOUR_MASK       (0x3F)
#define PCF8563_WEEKDAY_MASK    (0x07)
#define PCF8563_CENTURY_MASK    (0x80)
#define PCF8563_DAY_MASK        (0x3F)
#define PCF8563_MONTH_MASK      (0x1F)
#define PCF8563_TIMER_CTL_MASK  (0x03)

#define PCF8563_ALARM_AF        (0x08)
#define PCF8563_TIMER_TF        (0x04)
#define PCF8563_ALARM_AIE       (0x02)
#define PCF8563_TIMER_TIE       (0x01)
#define PCF8563_TIMER_TE        (0x80)
#define PCF8563_TIMER_TD10      (0x03)

#define PCF8563_NO_ALARM        (0xFF)
#define PCF8563_ALARM_ENABLE    (0x80)
#define PCF8563_CLK_ENABLE      (0x80)

#define RTC_DAYS_IN_JANUARY     (31u)
#define RTC_DAYS_IN_FEBRUARY    (28u)
#define RTC_DAYS_IN_MARCH       (31u)
#define RTC_DAYS_IN_APRIL       (30u)
#define RTC_DAYS_IN_MAY         (31u)
#define RTC_DAYS_IN_JUNE        (30u)
#define RTC_DAYS_IN_JULY        (31u)
#define RTC_DAYS_IN_AUGUST      (31u)
#define RTC_DAYS_IN_SEPTEMBER   (30u)
#define RTC_DAYS_IN_OCTOBER     (31u)
#define RTC_DAYS_IN_NOVEMBER    (30u)
#define RTC_DAYS_IN_DECEMBER    (31u)

typedef struct {
    i2c_master_dev_handle_t i2c_handle;
} pcf8563_handle_t;

typedef struct {
    uint16_t year;
    uint8_t month;
    uint8_t day;
    uint8_t hour;
    uint8_t minute;
    uint8_t second;
    uint8_t week;
    bool available;
} rtc_datatime_t;

typedef struct {
    uint8_t day;
    uint8_t hour;
    uint8_t minute;
    uint8_t week;
} rtc_alarm_t;

/**
 * @brief Initialize the PCF8563 sensor with I2C interface
 * 
 * @param i2c_bus The I2C bus handle
 * @param dev_addr I2C device address
 * @param handle Pointer to store the sensor handle
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_new_i2c_pcf8563(i2c_master_bus_handle_t i2c_bus, uint8_t dev_addr, pcf8563_handle_t *handle);

/**
 * @brief Configure datetime to rtc
 * 
 * @param handle PCF8563 handle
 * @param datetime Pointer to store datetime
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_pcf8563_set_datatime(pcf8563_handle_t *handle, rtc_datatime_t *datetime);

/**
 * @brief Get datetime from rtc
 * 
 * @param handle PCF8563 handle
 * @param datetime Pointer to store datetime
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_pcf8563_get_datatime(pcf8563_handle_t *handle, rtc_datatime_t *datetime);

/**
 * @brief Configure alarm time to rtc
 * 
 * @param handle PCF8563 handle
 * @param alarm Pointer to store alarm
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_pcf8563_set_alarm(pcf8563_handle_t *handle, rtc_alarm_t *alarm);

/**
 * @brief Get alarm time from rtc
 * 
 * @param handle PCF8563 handle
 * @param alarm Pointer to store alarm
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_pcf8563_get_alarm(pcf8563_handle_t *handle, rtc_alarm_t *alarm);

/**
 * @brief Enable rtc alarm function
 * 
 * @param handle PCF8563 handle
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_pcf8563_enable_alarm(pcf8563_handle_t *handle);

/**
 * @brief Disable rtc alarm function
 * 
 * @param handle PCF8563 handle
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_pcf8563_disable_alarm(pcf8563_handle_t *handle);

#ifdef __cplusplus
}
#endif
