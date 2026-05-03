
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "bsp_lsm6ds3.h"

#define I2C_TIMEOUT_MS (1000)
#define I2C_CLK_SPEED (400000)

static const char *TAG = "LSM6DS3";

static int32_t esp_i2c_read(void *handle, uint8_t reg, uint8_t *buffer, uint16_t length)
{
    i2c_master_dev_handle_t i2c_dev = (i2c_master_dev_handle_t)handle;
    esp_err_t ret;
    
    ret = i2c_master_transmit(i2c_dev, &reg, 1, I2C_TIMEOUT_MS);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to write register address: %s", esp_err_to_name(ret));
        return -1;
    }

    ret = i2c_master_receive(i2c_dev, buffer, length, I2C_TIMEOUT_MS);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to read from device: %s", esp_err_to_name(ret));
        return -1;
    }

    return 0;
}

static int32_t esp_i2c_write(void *handle, uint8_t reg, const uint8_t *buffer, uint16_t length)
{
    i2c_master_dev_handle_t i2c_dev = (i2c_master_dev_handle_t)handle;
    esp_err_t ret;
    
    uint8_t *buf = (uint8_t *)malloc(length + 1);
    if (buf == NULL) {
        ESP_LOGE(TAG, "Failed to allocate memory for write buffer");
        return -1;
    }
    
    buf[0] = reg;
    memcpy(&buf[1], buffer, length);
    
    ret = i2c_master_transmit(i2c_dev, buf, length + 1, I2C_TIMEOUT_MS);
    free(buf);
    
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to write to device: %s", esp_err_to_name(ret));
        return -1;
    }
    
    return 0;
}

esp_err_t bsp_new_i2c_lsm6ds3(i2c_master_bus_handle_t i2c_bus, uint8_t dev_addr, lsm6ds3_handle_t *handle)
{
    esp_err_t ret = ESP_OK;

    ESP_RETURN_ON_FALSE(handle != NULL, ESP_ERR_INVALID_ARG, TAG, "Invalid handle_ret");

    const i2c_device_config_t i2c_dev_cfg = {
        .device_address = dev_addr,
        .scl_speed_hz = I2C_CLK_SPEED,
    };

    ret = i2c_master_bus_add_device(i2c_bus, &i2c_dev_cfg, &handle->i2c_handle);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to add device to I2C bus: %s", esp_err_to_name(ret));
    return ret;
    }

    handle->ctx.write_reg = esp_i2c_write;
    handle->ctx.read_reg = esp_i2c_read;
    handle->ctx.handle = (void *)handle->i2c_handle;

    uint8_t id;
    ret = bsp_lsm6ds3_check_id(handle, &id);
    if (ret != ESP_OK) {
        return ret;
    }

    if (id != LSM6DS3TR_C_ID) {
        ESP_LOGE(TAG, "Device ID mismatch. Expected: 0x%X, Got: 0x%X", LSM6DS3TR_C_ID, id);
        return ESP_ERR_NOT_FOUND;
    }

    uint8_t rst = 1;
    lsm6ds3tr_c_reset_set(&handle->ctx, rst);
    vTaskDelay(pdMS_TO_TICKS(10));

    ret = bsp_lsm6ds3_config_default(handle);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to apply default configuration");
        return ret;
    }
    
    ESP_LOGI(TAG, "Initialized successfully");

    return ret;
}

esp_err_t bsp_lsm6ds3_check_id(lsm6ds3_handle_t *handle, uint8_t *id)
{
    esp_err_t ret = ESP_OK;
    ret = lsm6ds3tr_c_device_id_get(&handle->ctx, id);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to read device ID");
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t bsp_lsm6ds3_config_default(lsm6ds3_handle_t *handle)
{
    esp_err_t ret = ESP_OK;
    
    ret = bsp_lsm6ds3_accel_config(handle, LSM6DS3TR_C_XL_ODR_104Hz, LSM6DS3TR_C_2g);
    if (ret != ESP_OK) {
        return ret;
    }
    
    ret = bsp_lsm6ds3_gyro_config(handle, LSM6DS3TR_C_GY_ODR_104Hz, LSM6DS3TR_C_2000dps);
    if (ret != ESP_OK) {
        return ret;
    }
    
    ret = lsm6ds3tr_c_block_data_update_set(&handle->ctx, PROPERTY_ENABLE);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to set block data update");
        return ESP_FAIL;
    }
    
    return ESP_OK;
}

esp_err_t bsp_lsm6ds3_accel_config(lsm6ds3_handle_t *handle, lsm6ds3tr_c_odr_xl_t odr, lsm6ds3tr_c_fs_xl_t fs)
{
    esp_err_t ret = ESP_OK;

    ret = lsm6ds3tr_c_xl_data_rate_set(&handle->ctx, odr);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to set accelerometer data rate");
        return ESP_FAIL;
    }
    
    ret = lsm6ds3tr_c_xl_full_scale_set(&handle->ctx, fs);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to set accelerometer full scale");
        return ESP_FAIL;
    }

    return ESP_OK;
}

esp_err_t bsp_lsm6ds3_gyro_config(lsm6ds3_handle_t *handle, lsm6ds3tr_c_odr_g_t odr, lsm6ds3tr_c_fs_g_t fs)
{
    esp_err_t ret = ESP_OK;

    ret = lsm6ds3tr_c_gy_data_rate_set(&handle->ctx, odr);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to set gyroscope data rate");
        return ESP_FAIL;
    }
    
    ret = lsm6ds3tr_c_gy_full_scale_set(&handle->ctx, fs);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to set gyroscope full scale");
        return ESP_FAIL;
    }

    return ESP_OK;
}

esp_err_t bsp_lsm6ds3_read_accel(lsm6ds3_handle_t *handle, float *x_mg, float *y_mg, float *z_mg)
{
    esp_err_t ret = ESP_OK;
    int16_t raw_accel[3] = {0};
    
    ret = lsm6ds3tr_c_acceleration_raw_get(&handle->ctx, raw_accel);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to read accelerometer data");
        return ESP_FAIL;
    }
    
    lsm6ds3tr_c_fs_xl_t fs;
    ret = lsm6ds3tr_c_xl_full_scale_get(&handle->ctx, &fs);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to get accelerometer full scale");
        return ESP_FAIL;
    }
    
    // Convert raw data to mg based on the current full scale
    switch (fs) {
        case LSM6DS3TR_C_2g:
            *x_mg = lsm6ds3tr_c_from_fs2g_to_mg(raw_accel[0]);
            *y_mg = lsm6ds3tr_c_from_fs2g_to_mg(raw_accel[1]);
            *z_mg = lsm6ds3tr_c_from_fs2g_to_mg(raw_accel[2]);
            break;
            
        case LSM6DS3TR_C_4g:
            *x_mg = lsm6ds3tr_c_from_fs4g_to_mg(raw_accel[0]);
            *y_mg = lsm6ds3tr_c_from_fs4g_to_mg(raw_accel[1]);
            *z_mg = lsm6ds3tr_c_from_fs4g_to_mg(raw_accel[2]);
            break;
            
        case LSM6DS3TR_C_8g:
            *x_mg = lsm6ds3tr_c_from_fs8g_to_mg(raw_accel[0]);
            *y_mg = lsm6ds3tr_c_from_fs8g_to_mg(raw_accel[1]);
            *z_mg = lsm6ds3tr_c_from_fs8g_to_mg(raw_accel[2]);
            break;
            
        case LSM6DS3TR_C_16g:
            *x_mg = lsm6ds3tr_c_from_fs16g_to_mg(raw_accel[0]);
            *y_mg = lsm6ds3tr_c_from_fs16g_to_mg(raw_accel[1]);
            *z_mg = lsm6ds3tr_c_from_fs16g_to_mg(raw_accel[2]);
            break;
            
        default:
            ESP_LOGE(TAG, "Unknown accelerometer full scale");
            return ESP_FAIL;
    }

    return ESP_OK;
}

esp_err_t bsp_lsm6ds3_read_gyro(lsm6ds3_handle_t *handle, float *x_mdps, float *y_mdps, float *z_mdps)
{
    esp_err_t ret = ESP_OK;
    int16_t raw_gyro[3] = {0};
    
    ret = lsm6ds3tr_c_angular_rate_raw_get(&handle->ctx, raw_gyro);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to read gyroscope data");
        return ESP_FAIL;
    }
    
    lsm6ds3tr_c_fs_g_t fs;
    ret = lsm6ds3tr_c_gy_full_scale_get(&handle->ctx, &fs);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to get gyroscope full scale");
        return ESP_FAIL;
    }
    
    switch (fs) {
        case LSM6DS3TR_C_125dps:
            *x_mdps = lsm6ds3tr_c_from_fs125dps_to_mdps(raw_gyro[0]);
            *y_mdps = lsm6ds3tr_c_from_fs125dps_to_mdps(raw_gyro[1]);
            *z_mdps = lsm6ds3tr_c_from_fs125dps_to_mdps(raw_gyro[2]);
            break;
            
        case LSM6DS3TR_C_250dps:
            *x_mdps = lsm6ds3tr_c_from_fs250dps_to_mdps(raw_gyro[0]);
            *y_mdps = lsm6ds3tr_c_from_fs250dps_to_mdps(raw_gyro[1]);
            *z_mdps = lsm6ds3tr_c_from_fs250dps_to_mdps(raw_gyro[2]);
            break;
            
        case LSM6DS3TR_C_500dps:
            *x_mdps = lsm6ds3tr_c_from_fs500dps_to_mdps(raw_gyro[0]);
            *y_mdps = lsm6ds3tr_c_from_fs500dps_to_mdps(raw_gyro[1]);
            *z_mdps = lsm6ds3tr_c_from_fs500dps_to_mdps(raw_gyro[2]);
            break;
            
        case LSM6DS3TR_C_1000dps:
            *x_mdps = lsm6ds3tr_c_from_fs1000dps_to_mdps(raw_gyro[0]);
            *y_mdps = lsm6ds3tr_c_from_fs1000dps_to_mdps(raw_gyro[1]);
            *z_mdps = lsm6ds3tr_c_from_fs1000dps_to_mdps(raw_gyro[2]);
            break;
            
        case LSM6DS3TR_C_2000dps:
            *x_mdps = lsm6ds3tr_c_from_fs2000dps_to_mdps(raw_gyro[0]);
            *y_mdps = lsm6ds3tr_c_from_fs2000dps_to_mdps(raw_gyro[1]);
            *z_mdps = lsm6ds3tr_c_from_fs2000dps_to_mdps(raw_gyro[2]);
            break;
            
        default:
            ESP_LOGE(TAG, "Unknown gyroscope full scale");
            return ESP_FAIL;
    }

    return ESP_OK;
}

esp_err_t bsp_lsm6ds3_read_temp(lsm6ds3_handle_t *handle, float *temp_c)
{
    esp_err_t ret = ESP_OK;
    int16_t raw_temp;
    
    ret = lsm6ds3tr_c_temperature_raw_get(&handle->ctx, &raw_temp);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to read temperature data");
        return ESP_FAIL;
    }
    
    *temp_c = lsm6ds3tr_c_from_lsb_to_celsius(raw_temp);

    return ESP_OK;
}

esp_err_t bsp_lsm6ds3_accel_data_ready(lsm6ds3_handle_t *handle, uint8_t *val)
{
    esp_err_t ret = ESP_OK;
    ret = lsm6ds3tr_c_xl_flag_data_ready_get(&handle->ctx, val);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to get accelerometer data ready flag");
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t bsp_lsm6ds3_gyro_data_ready(lsm6ds3_handle_t *handle, uint8_t *val)
{
    esp_err_t ret = ESP_OK;
    ret = lsm6ds3tr_c_gy_flag_data_ready_get(&handle->ctx, val);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to get gyroscope data ready flag");
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t bsp_lsm6ds3_temp_data_ready(lsm6ds3_handle_t *handle, uint8_t *val)
{
    esp_err_t ret = ESP_OK;
    ret = lsm6ds3tr_c_temp_flag_data_ready_get(&handle->ctx, val);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to get temperature data ready flag");
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t bsp_lsm6ds3_interrupt_pin_config(lsm6ds3_handle_t *handle, uint8_t active_low, uint8_t open_drain)
{
    esp_err_t ret = ESP_OK;
    lsm6ds3tr_c_lir_t int_mode = 0;

    ret = lsm6ds3tr_c_pin_mode_set(&handle->ctx, open_drain ? LSM6DS3TR_C_OPEN_DRAIN : LSM6DS3TR_C_PUSH_PULL);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to set pin mode");
        return ESP_FAIL;
    }
    
    ret = lsm6ds3tr_c_pin_polarity_set(&handle->ctx, active_low ? LSM6DS3TR_C_ACTIVE_LOW : LSM6DS3TR_C_ACTIVE_HIGH);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to set pin polarity");
        return ESP_FAIL;
    }
    
    int_mode = LSM6DS3TR_C_INT_PULSED;  // 0 = pulsed, 1 = latched
    ret = lsm6ds3tr_c_int_notification_set(&handle->ctx, int_mode);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to set interrupt mode");
        return ESP_FAIL;
    }
    
    return ESP_OK;
}

esp_err_t bsp_lsm6ds3_interrupt_enable_int1(lsm6ds3_handle_t *handle, uint32_t int_types)
{
    esp_err_t ret = ESP_OK;
    lsm6ds3tr_c_int1_route_t int1_route = {0};

    if (int_types & LSM6DS3_INT_DRDY_XL) int1_route.int1_drdy_xl = 1;
    if (int_types & LSM6DS3_INT_DRDY_G) int1_route.int1_drdy_g = 1;
    if (int_types & LSM6DS3_INT_SIGN_MOT) int1_route.int1_sign_mot = 1;
    if (int_types & LSM6DS3_INT_STEP_DET) int1_route.int1_step_detector = 1;
    if (int_types & LSM6DS3_INT_TILT) int1_route.int1_tilt = 1;
    if (int_types & LSM6DS3_INT_FF) int1_route.int1_ff = 1;
    if (int_types & LSM6DS3_INT_WAKE_UP) int1_route.int1_wu = 1;
    if (int_types & LSM6DS3_INT_SINGLE_TAP) int1_route.int1_single_tap = 1;
    if (int_types & LSM6DS3_INT_DOUBLE_TAP) int1_route.int1_double_tap = 1;
    if (int_types & LSM6DS3_INT_6D) int1_route.int1_6d = 1;

    ret = lsm6ds3tr_c_pin_int1_route_set(&handle->ctx, int1_route);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to set INT1 pin routing");
        return ESP_FAIL;
    }

    return ESP_OK;
}

esp_err_t bsp_lsm6ds3_interrupt_source_get(lsm6ds3_handle_t *handle, lsm6ds3tr_c_all_sources_t *int_src)
{
    esp_err_t ret = ESP_OK;
    ret = lsm6ds3tr_c_all_sources_get(&handle->ctx, int_src);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to get interrupt sources");
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t bsp_lsm6ds3_set_power_mode(lsm6ds3_handle_t *handle, lsm6ds3_power_mode_t mode)
{
    esp_err_t ret = ESP_OK;

    switch (mode) {
        case LSM6DS3_POWER_HIGH_PERFORMANCE:
        {
            ret = lsm6ds3tr_c_xl_power_mode_set(&handle->ctx, LSM6DS3TR_C_XL_HIGH_PERFORMANCE);
            if (ret != 0) {
                ESP_LOGE(TAG, "Failed to set accelerometer to high performance mode");
                return ESP_FAIL;
            }

            ret = lsm6ds3tr_c_gy_power_mode_set(&handle->ctx, LSM6DS3TR_C_GY_HIGH_PERFORMANCE);
            if (ret != 0) {
                ESP_LOGE(TAG, "Failed to set gyroscope to high performance mode");
                return ESP_FAIL;
            }

            ret = lsm6ds3tr_c_gy_sleep_mode_set(&handle->ctx, 0);
            if (ret != 0) {
                ESP_LOGE(TAG, "Failed to wake up gyroscope");
                return ESP_FAIL;
            }
            break;
        }

        case LSM6DS3_POWER_NORMAL:
        {
            ret = lsm6ds3tr_c_xl_power_mode_set(&handle->ctx, LSM6DS3TR_C_XL_NORMAL);
            if (ret != 0) {
                ESP_LOGE(TAG, "Failed to set accelerometer to high normal mode");
                return ESP_FAIL;
            }

            ret = lsm6ds3tr_c_gy_power_mode_set(&handle->ctx, LSM6DS3TR_C_GY_NORMAL);
            if (ret != 0) {
                ESP_LOGE(TAG, "Failed to set gyroscope to high normal mode");
                return ESP_FAIL;
            }

            ret = lsm6ds3tr_c_gy_sleep_mode_set(&handle->ctx, 0);
            if (ret != 0) {
                ESP_LOGE(TAG, "Failed to wake up gyroscope");
                return ESP_FAIL;
            }
            break;
        }
        case LSM6DS3_POWER_ULTRA_LOW:
        {
            ret = lsm6ds3tr_c_xl_power_mode_set(&handle->ctx, LSM6DS3TR_C_XL_NORMAL);
            if (ret != 0) {
                ESP_LOGE(TAG, "Failed to set accelerometer to high normal mode");
                return ESP_FAIL;
            }

            ret = lsm6ds3tr_c_gy_sleep_mode_set(&handle->ctx, 1);
            if (ret != 0) {
                ESP_LOGE(TAG, "Failed to put gyroscope in sleep mode");
                return ESP_FAIL;
            }

            ret = lsm6ds3tr_c_gy_data_rate_set(&handle->ctx, LSM6DS3TR_C_GY_ODR_12Hz5);
            if (ret != 0) {
                ESP_LOGE(TAG, "Failed to set gyroscope to lowest ODR");
                return ESP_FAIL;
            }

            break;
        }
        case LSM6DS3_POWER_SUSPEND:
        {
            ret = lsm6ds3tr_c_xl_power_mode_set(&handle->ctx, LSM6DS3TR_C_XL_NORMAL);
            if (ret != 0) {
                ESP_LOGE(TAG, "Failed to set accelerometer to high normal mode");
                return ESP_FAIL;
            }

            ret = lsm6ds3tr_c_xl_data_rate_set(&handle->ctx, LSM6DS3TR_C_XL_ODR_1Hz6);
            if (ret != 0) {
                ESP_LOGE(TAG, "Failed to set accelerometer to lowest ODR");
                return ESP_FAIL;
            }

            ret = lsm6ds3tr_c_gy_sleep_mode_set(&handle->ctx, 1);
            if (ret != 0) {
                ESP_LOGE(TAG, "Failed to put gyroscope in sleep mode");
                return ESP_FAIL;
            }

            ret = lsm6ds3tr_c_gy_data_rate_set(&handle->ctx, LSM6DS3TR_C_GY_ODR_12Hz5);
            if (ret != 0) {
                ESP_LOGE(TAG, "Failed to set gyroscope to lowest ODR");
                return ESP_FAIL;
            }

            break;
        }
        default:
        {
            ESP_LOGE(TAG, "Invalid power mode");
            return ESP_ERR_INVALID_ARG;
        }
    }

    return ESP_OK;
}
