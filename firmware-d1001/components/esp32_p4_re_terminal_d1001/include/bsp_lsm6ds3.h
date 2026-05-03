
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include "esp_err.h"
#include "esp_check.h"
#include "esp_log.h"
#include "driver/i2c_master.h"
#include "lsm6ds3tr-c_reg.h"

#ifdef __cplusplus
extern "C" {
#endif

#define LSM6DS3_I2C_ADDRESS     (0x6a)

typedef struct {
    i2c_master_dev_handle_t i2c_handle;
    stmdev_ctx_t ctx;
} lsm6ds3_handle_t;

typedef enum {
    LSM6DS3_INT_DRDY_XL          = 0x01, // Accelerometer data ready
    LSM6DS3_INT_DRDY_G           = 0x02, // Gyroscope data ready
    LSM6DS3_INT_SIGN_MOT         = 0x04, // Significant motion
    LSM6DS3_INT_STEP_DET         = 0x08, // Step detector
    LSM6DS3_INT_TILT             = 0x10, // Tilt
    LSM6DS3_INT_FF               = 0x20, // Free fall event
    LSM6DS3_INT_WAKE_UP          = 0x40, // Wake up event
    LSM6DS3_INT_SINGLE_TAP       = 0x80, // Single-tap event
    LSM6DS3_INT_DOUBLE_TAP       = 0x100, // Double-tap event
    LSM6DS3_INT_6D               = 0x200, // 6D orientation change
} lsm6ds3_interrupt_type_t;

typedef enum {
    LSM6DS3_POWER_HIGH_PERFORMANCE,    /*!< Both accel and gyro in high performance mode */
    LSM6DS3_POWER_NORMAL,              /*!< Both accel and gyro in normal mode */
    LSM6DS3_POWER_ULTRA_LOW,           /*!< Accel in normal mode, gyro in sleep mode */
    LSM6DS3_POWER_SUSPEND              /*!< Both accel and gyro in sleep mode */
} lsm6ds3_power_mode_t;

/**
 * @brief Initialize the LSM6DS3 sensor with I2C interface
 * 
 * @param i2c_bus The I2C bus handle
 * @param dev_addr I2C device address
 * @param handle Pointer to store the sensor handle
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_new_i2c_lsm6ds3(i2c_master_bus_handle_t i2c_bus, uint8_t dev_addr, lsm6ds3_handle_t *handle);

/**
 * @brief Read the device ID to verify correct sensor connection
 * 
 * @param handle LSM6DS3 handle
 * @param id Pointer to store the device ID (should be 0x6C for LSM6DS3)
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_lsm6ds3_check_id(lsm6ds3_handle_t *handle, uint8_t *id);

/**
 * @brief Configure the sensor with default settings
 * 
 * @param handle LSM6DS3 handle
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_lsm6ds3_config_default(lsm6ds3_handle_t *handle);

/**
 * @brief Configure accelerometer with specific settings
 * 
 * @param handle LSM6DS3 handle
 * @param odr Output data rate
 * @param fs Full scale range
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_lsm6ds3_accel_config(lsm6ds3_handle_t *handle, lsm6ds3tr_c_odr_xl_t odr, lsm6ds3tr_c_fs_xl_t fs);

/**
 * @brief Configure gyroscope with specific settings
 * 
 * @param handle LSM6DS3 handle
 * @param odr Output data rate
 * @param fs Full scale range
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_lsm6ds3_gyro_config(lsm6ds3_handle_t *handle, lsm6ds3tr_c_odr_g_t odr, lsm6ds3tr_c_fs_g_t fs);

/**
 * @brief Read accelerometer data
 * 
 * @param handle LSM6DS3 handle
 * @param x_mg Pointer to store x-axis acceleration in mg
 * @param y_mg Pointer to store y-axis acceleration in mg
 * @param z_mg Pointer to store z-axis acceleration in mg
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_lsm6ds3_read_accel(lsm6ds3_handle_t *handle, float *x_mg, float *y_mg, float *z_mg);

/**
 * @brief Read gyroscope data
 * 
 * @param handle LSM6DS3 handle
 * @param x_mdps Pointer to store x-axis angular rate in mdps
 * @param y_mdps Pointer to store y-axis angular rate in mdps
 * @param z_mdps Pointer to store z-axis angular rate in mdps
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_lsm6ds3_read_gyro(lsm6ds3_handle_t *handle, float *x_mdps, float *y_mdps, float *z_mdps);

/**
 * @brief Read temperature data
 * 
 * @param handle LSM6DS3 handle
 * @param temp_c Pointer to store temperature in celsius
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_lsm6ds3_read_temp(lsm6ds3_handle_t *handle, float *temp_c);

/**
 * @brief Check if new accelerometer data is available
 * 
 * @param handle LSM6DS3 handle
 * @param val Pointer to store the flag (1 if data available, 0 otherwise)
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_lsm6ds3_accel_data_ready(lsm6ds3_handle_t *handle, uint8_t *val);

/**
 * @brief Check if new gyroscope data is available
 * 
 * @param handle LSM6DS3 handle
 * @param val Pointer to store the flag (1 if data available, 0 otherwise)
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_lsm6ds3_gyro_data_ready(lsm6ds3_handle_t *handle, uint8_t *val);

/**
 * @brief Check if new temperature data is available
 * 
 * @param handle LSM6DS3 handle
 * @param val Pointer to store the flag (1 if data available, 0 otherwise)
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_lsm6ds3_temp_data_ready(lsm6ds3_handle_t *handle, uint8_t *val);

/**
 * @brief Configure general interrupt control settings
 * 
 * @param handle LSM6DS3 handle
 * @param active_low Set to 1 for active-low, 0 for active-high
 * @param open_drain Set to 1 for open-drain, 0 for push-pull
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_lsm6ds3_interrupt_pin_config(lsm6ds3_handle_t *handle, uint8_t active_low, uint8_t open_drain);

/**
 * @brief Configure interrupts for INT1 pin
 * 
 * @param handle LSM6DS3 handle
 * @param int_types Bitwise OR of interrupt types to be enabled on INT1
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_lsm6ds3_interrupt_enable_int1(lsm6ds3_handle_t *handle, uint32_t int_types);

/**
 * @brief Read the interrupt source to determine which interrupt occurred
 * 
 * @param handle LSM6DS3 handle
 * @param int_src Pointer to store interrupt source info
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_lsm6ds3_interrupt_source_get(lsm6ds3_handle_t *handle, lsm6ds3tr_c_all_sources_t *int_src);

/**
 * @brief Configure power mode for both accelerometer and gyroscope
 * 
 * @param handle LSM6DS3 handle
 * @param mode Power mode to set
 * 
 * @return 
 *      - ESP_OK on success
 *      - Otherwise on error
 */
esp_err_t bsp_lsm6ds3_set_power_mode(lsm6ds3_handle_t *handle, lsm6ds3_power_mode_t mode);

#ifdef __cplusplus
}
#endif
