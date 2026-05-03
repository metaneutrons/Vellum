/*
 * SPDX-FileCopyrightText: 2024 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <string.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include "driver/gpio.h"
#include "esp_err.h"
#include "esp_log.h"

#include "esp_cam_sensor.h"
#include "esp_cam_sensor_detect.h"
#include "bf2253_settings.h"
#include "bf2253.h"

typedef struct {
    uint8_t digital_gain;
    uint8_t global_gain;
} bf2253_gain_t;

typedef struct {
    uint32_t exposure_val;
    uint32_t exposure_max;
    uint32_t gain_index; // current gain index

    uint32_t vflip_en : 1;
    uint32_t hmirror_en : 1;
} bf2253_para_t;

struct bf2253_cam {
    bf2253_para_t bf2253_para;
};

#define BF2253_IO_MUX_LOCK(mux)
#define BF2253_IO_MUX_UNLOCK(mux)
#define BF2253_ENABLE_OUT_XCLK(pin,clk)
#define BF2253_DISABLE_OUT_XCLK(pin)

#define BF2253_PID         0x2253
#define BF2253_SENSOR_NAME "BF2253"

#ifndef portTICK_RATE_MS
#define portTICK_RATE_MS portTICK_PERIOD_MS
#endif
#define delay_ms(ms)  vTaskDelay((ms > portTICK_PERIOD_MS ? ms/ portTICK_PERIOD_MS : 1))
#define BF2253_SUPPORT_NUM CONFIG_CAMERA_BF2253_MAX_SUPPORT

static const uint32_t s_limited_gain = CONFIG_CAMERA_BF2253_ABSOLUTE_GAIN_LIMIT;
static size_t s_limited_gain_index;
static const uint8_t s_bf2253_exp_min = 1;
static const char *TAG = "bf2253";

static const uint32_t bf2253_total_gain_val_map[] = {
    1024,
    1088,
    1150,
    1214,
    1277,
    1342,
    1403,
    1468,
    1527,
    1594,
    1652,
    1716,
    1775,
    1839,
    1897,
    1960,
    2023,
    2145,
    2273,
    2395,
    2519,
    2641,
    2765,
    2885,
    3006,
    3131,
    3249,
    3373,
    3493,
    3610,
    3730,
    3846,
    3962,
    4206,
    4441,
    4678,
    4906,
    5146,
    5371,
    5601,
    5831,
    6046,
    6259,
    6493,
    6713,
    6928,
    7149,
    7359,
    7564,
    7789,
    8000,
    8216,
    8439,
    8648,
    8859,
    9065,
    9280,
    9482,
    9665,
    9891,
    10073,
    10273,
    10474,
    10663,
    10856,
};

// BF2253 Gain map format: [DIG_GAIN, GLB_GAIN]
static const bf2253_gain_t bf2253_gain_map[] = {
    {32, 15},
    {32, 16},
    {32, 17},
    {32, 18},
    {32, 19},
    {32, 20},
    {32, 21},
    {32, 22},
    {32, 23},
    {32, 24},
    {32, 25},
    {32, 26},
    {32, 27},
    {32, 28},
    {32, 29},
    {32, 30},
    {32, 31},
    {32, 32},
    {32, 33},
    {32, 34},
    {32, 35},
    {32, 36},
    {32, 37},
    {32, 38},
    {32, 39},
    {32, 40},
    {32, 41},
    {32, 42},
    {32, 43},
    {32, 44},
    {32, 45},
    {32, 46},
    {32, 47},
    {32, 48},
    {32, 49},
    {32, 50},
    {32, 51},
    {32, 52},
    {32, 53},
    {32, 54},
    {32, 55},
    {32, 56},
    {32, 57},
    {32, 58},
    {32, 59},
    {32, 60},
    {32, 61},
    {32, 62},
    {32, 63},
    {32, 64},
    {32, 65},
    {32, 66},
    {32, 67},
    {32, 68},
    {32, 69},
    {32, 70},
    {32, 71},
    {32, 72},
    {32, 73},
    {32, 74},
    {32, 75},
    {32, 76},
    {32, 77},
    {32, 78},
    {32, 79},
};

static const esp_cam_sensor_isp_info_t bf2253_isp_info[] = {
    {
        .isp_v1_info = {
            .version = SENSOR_ISP_INFO_VERSION_DEFAULT,
            // .pclk = 66000000,
            .pclk = 53333333,
            .vts = 1236,
            .hts = 1780,
            .gain_def = 0,
            .exp_def = 0x3ED,
            .bayer_type = ESP_CAM_SENSOR_BAYER_BGGR,
        }
    },
};

static const esp_cam_sensor_format_t bf2253_format_info[] = {
    {
        .name = "MIPI_1lane_24Minput_RAW10_1600x1200_30fps",
        .format = ESP_CAM_SENSOR_PIXFORMAT_RAW10,
        .port = ESP_CAM_SENSOR_MIPI_CSI,
        .xclk = 24000000,
        .width = 1600,
        .height = 1200,
        .regs = bf2253_input_24M_MIPI_1lane_raw10_1600x1200_30fps,
        .regs_size = ARRAY_SIZE(bf2253_input_24M_MIPI_1lane_raw10_1600x1200_30fps),
        .fps = 30,
        .isp_info = &bf2253_isp_info[0],
        .mipi_info = {
            .mipi_clk = 660000000,
            .lane_num = 1,
            .line_sync_en = false,
        },
        .reserved = NULL,
    },
    {
    .name = "MIPI_1lane_24Minput_RAW10_1280x720_30fps",
        .format = ESP_CAM_SENSOR_PIXFORMAT_RAW10,
        .port = ESP_CAM_SENSOR_MIPI_CSI,
        .xclk = 24000000,
        .width = 1280,
        .height = 720,
        .regs = bf2253_input_24M_MIPI_1lane_raw10_1280x720_30fps,
        .regs_size = ARRAY_SIZE(bf2253_input_24M_MIPI_1lane_raw10_1280x720_30fps),
        .fps = 30,
        .isp_info = &bf2253_isp_info[0],
        .mipi_info = {
            .mipi_clk = 660000000,
            .lane_num = 1,
            .line_sync_en = false,
        },
        .reserved = NULL,
    },
    {
    .name = "MIPI_1lane_24Minput_RAW10_800x1200_30fps",
        .format = ESP_CAM_SENSOR_PIXFORMAT_RAW10,
        .port = ESP_CAM_SENSOR_MIPI_CSI,
        .xclk = 24000000,
        .width = 800,
        .height = 1200,
        .regs = bf2253_input_24M_MIPI_1lane_raw10_800x1200_30fps,
        .regs_size = ARRAY_SIZE(bf2253_input_24M_MIPI_1lane_raw10_800x1200_30fps),
        .fps = 30,
        .isp_info = &bf2253_isp_info[0],
        .mipi_info = {
            .mipi_clk = 660000000,
            .lane_num = 1,
            .line_sync_en = false,
        },
        .reserved = NULL,
    },
    {
    .name = "MIPI_1lane_24Minput_RAW10_800x800_30fps",
        .format = ESP_CAM_SENSOR_PIXFORMAT_RAW10,
        .port = ESP_CAM_SENSOR_MIPI_CSI,
        .xclk = 24000000,
        .width = 800,
        .height = 800,
        .regs = bf2253_input_24M_MIPI_1lane_raw10_800x800_30fps,
        .regs_size = ARRAY_SIZE(bf2253_input_24M_MIPI_1lane_raw10_800x800_30fps),
        .fps = 30,
        .isp_info = &bf2253_isp_info[0],
        .mipi_info = {
            .mipi_clk = 660000000,
            .lane_num = 1,
            .line_sync_en = false,
        },
        .reserved = NULL,
    },
};

static esp_err_t bf2253_read(esp_sccb_io_handle_t sccb_handle, uint8_t reg, uint8_t *read_buf)
{
    return esp_sccb_transmit_receive_reg_a8v8(sccb_handle, reg, read_buf);
}

static esp_err_t bf2253_write(esp_sccb_io_handle_t sccb_handle, uint8_t reg, uint8_t data)
{
    ESP_LOGD(TAG, "bf2253_write: 0x%02x, 0x%02x", reg, data);
    return esp_sccb_transmit_reg_a8v8(sccb_handle, reg, data);
}

/* write a array of registers  */
static esp_err_t bf2253_write_array(esp_sccb_io_handle_t sccb_handle, bf2253_reginfo_t *regarray, size_t regs_size)
{
    int i = 0;
    esp_err_t ret = ESP_OK;
    while ((ret == ESP_OK) && regarray[i].reg != BF2253_REG_END) {
        if (regarray[i].reg != BF2253_REG_DELAY) {
            ret = bf2253_write(sccb_handle, regarray[i].reg, regarray[i].val);
        } else {
            delay_ms(regarray[i].val);
        }
        i++;
    }
    return ret;
}

static esp_err_t bf2253_set_reg_bits(esp_sccb_io_handle_t sccb_handle, uint8_t reg, uint8_t offset, uint8_t length, uint8_t value)
{
    esp_err_t ret = ESP_OK;
    uint8_t reg_data = 0;

    ret = bf2253_read(sccb_handle, reg, &reg_data);
    if (ret != ESP_OK) {
        return ret;
    }
    uint8_t mask = ((1 << length) - 1) << offset;
    value = (reg_data & ~mask) | ((value << offset) & mask);
    ret = bf2253_write(sccb_handle, reg, value);
    return ret;
}

static esp_err_t bf2253_set_test_pattern(esp_cam_sensor_device_t *dev, int enable)
{
    esp_err_t ret = ESP_OK;
    if (enable) {
        ret = bf2253_write(dev->sccb_handle, 0x7e, 0x50);
        ret = bf2253_write(dev->sccb_handle, 0x82, 0xff);
        ret = bf2253_write(dev->sccb_handle, 0x83, 0xff);
        ret = bf2253_write(dev->sccb_handle, 0x84, 0xff);
    } else {
        ret = bf2253_write(dev->sccb_handle, 0x7e, 0x10);
    }
    return ret;
}

static esp_err_t bf2253_hw_reset(esp_cam_sensor_device_t *dev)
{
    if (dev->reset_pin >= 0) {
        gpio_set_level(dev->reset_pin, 0);
        delay_ms(10);
        gpio_set_level(dev->reset_pin, 1);
        delay_ms(10);
    }
    return ESP_OK;
}

static esp_err_t bf2253_soft_reset(esp_cam_sensor_device_t *dev)
{
    esp_err_t ret = bf2253_write(dev->sccb_handle, BF2253_REG_SOFTWARE_STANDBY, 0x01);
    delay_ms(5);
    return ret;
}

static esp_err_t bf2253_get_sensor_id(esp_cam_sensor_device_t *dev, esp_cam_sensor_id_t *id)
{
    esp_err_t ret = ESP_FAIL;
    uint8_t pid_h, pid_l;

    ret = bf2253_read(dev->sccb_handle, BF2253_REG_CHIP_ID_H, &pid_h);
    if (ret != ESP_OK) {
        return ret;
    }
    ret = bf2253_read(dev->sccb_handle, BF2253_REG_CHIP_ID_L, &pid_l);
    if (ret != ESP_OK) {
        return ret;
    }
    id->pid = (pid_h << 8) | pid_l;

    return ret;
}

static esp_err_t bf2253_set_stream(esp_cam_sensor_device_t *dev, int enable)
{
    esp_err_t ret = ESP_OK;
    // ret = bf2253_set_reg_bits(dev->sccb_handle, 0x7d, 4, 0x01, enable != 0); // base on datasheet
    ret = bf2253_set_reg_bits(dev->sccb_handle, 0x7d, 4, 0x01, enable == 0); // why ???
    ESP_LOGD(TAG, "Set stream to: %d", enable);
    dev->stream_status = enable;
    return ret;
}

static esp_err_t bf2253_set_mirror(esp_cam_sensor_device_t *dev, int enable)
{
    esp_err_t ret = ESP_OK;
    ret = bf2253_set_reg_bits(dev->sccb_handle, 0x00, 3, 0x01, enable != 0);
    if (ret == ESP_OK) {
        ESP_LOGD(TAG, "Set h-mirror to: %d", enable);
    }
    return ret;
}

static esp_err_t bf2253_set_vflip(esp_cam_sensor_device_t *dev, int enable)
{
    esp_err_t ret = ESP_OK;
    ret = bf2253_set_reg_bits(dev->sccb_handle, 0x00, 2, 0x01, enable != 0);
    if (ret == 0) {
        ESP_LOGD(TAG, "Set vflip to: %d", enable);
    }
    return ret;
}

static esp_err_t bf2253_set_exp_val(esp_cam_sensor_device_t *dev, uint32_t u32_val)
{
    esp_err_t ret = ESP_OK;
    struct bf2253_cam *cam_bf2253 = (struct bf2253_cam *)dev->priv;
    uint32_t value_buf = MAX(u32_val, s_bf2253_exp_min);
    value_buf = MIN(value_buf, cam_bf2253->bf2253_para.exposure_max);

    ESP_LOGD(TAG, "set exposure 0x%" PRIx32, value_buf);
    ret = bf2253_write(dev->sccb_handle,
                       0x6b, // Real integration time MSB
                       ((value_buf >> 8) & 0xff));
    ret |= bf2253_write(dev->sccb_handle,
                       0x6c, // Real integration time LSB
                       (value_buf & 0xff));
    if (ret == ESP_OK) {
        cam_bf2253->bf2253_para.exposure_val = value_buf;
    }                   
    return ret;
}

static esp_err_t bf2253_set_total_gain_val(esp_cam_sensor_device_t *dev, uint32_t u32_val)
{
    esp_err_t ret = ESP_OK;
    struct bf2253_cam *cam_bf2253= (struct bf2253_cam *)dev->priv;

    ESP_LOGD(TAG, "dig_gain %" PRIx8 ", ana_gain_coarse %" PRIx8, bf2253_gain_map[u32_val].digital_gain, bf2253_gain_map[u32_val].global_gain);
    ret = bf2253_write(dev->sccb_handle,
                       0x6f, // digtal gain
                       bf2253_gain_map[u32_val].digital_gain);
    ret |= bf2253_write(dev->sccb_handle,
                        0x6a, // Global gain
                        bf2253_gain_map[u32_val].global_gain);
    if (ret == ESP_OK) {
        cam_bf2253->bf2253_para.gain_index = u32_val;
    }

    return ret;
}

static esp_err_t bf2253_query_para_desc(esp_cam_sensor_device_t *dev, esp_cam_sensor_param_desc_t *qdesc)
{
    esp_err_t ret = ESP_OK;
    switch (qdesc->id) {
    case ESP_CAM_SENSOR_EXPOSURE_VAL:
        qdesc->type = ESP_CAM_SENSOR_PARAM_TYPE_NUMBER;
        qdesc->number.minimum = s_bf2253_exp_min;
        qdesc->number.maximum = dev->cur_format->isp_info->isp_v1_info.vts - 6;
        qdesc->number.step = 1;
        qdesc->default_value = dev->cur_format->isp_info->isp_v1_info.exp_def;
        break;
    case ESP_CAM_SENSOR_GAIN:
        qdesc->type = ESP_CAM_SENSOR_PARAM_TYPE_ENUMERATION;
        qdesc->enumeration.count = s_limited_gain_index;
        qdesc->enumeration.elements = bf2253_total_gain_val_map;
        qdesc->default_value = dev->cur_format->isp_info->isp_v1_info.gain_def; // gain index
        break;
    case ESP_CAM_SENSOR_VFLIP:
    case ESP_CAM_SENSOR_HMIRROR:
        qdesc->type = ESP_CAM_SENSOR_PARAM_TYPE_NUMBER;
        qdesc->number.minimum = 0;
        qdesc->number.maximum = 1;
        qdesc->number.step = 1;
        qdesc->default_value = 0;
        break;
    default: {
        ESP_LOGD(TAG, "id=%"PRIx32" is not supported", qdesc->id);
        ret = ESP_ERR_INVALID_ARG;
        break;
    }
    }
    return ret;
}

static esp_err_t bf2253_get_para_value(esp_cam_sensor_device_t *dev, uint32_t id, void *arg, size_t size)
{
    esp_err_t ret = ESP_OK;
    struct bf2253_cam *cam_bf2253 = (struct bf2253_cam *)dev->priv;
    switch (id) {
    case ESP_CAM_SENSOR_EXPOSURE_VAL: {
        *(uint32_t *)arg = cam_bf2253->bf2253_para.exposure_val;
        break;
    }
    case ESP_CAM_SENSOR_GAIN: {
        *(uint32_t *)arg = cam_bf2253->bf2253_para.gain_index;
        break;
    }
    default: {
        ret = ESP_ERR_NOT_SUPPORTED;
        break;
    }
    }
    return ret;
}

static esp_err_t bf2253_set_para_value(esp_cam_sensor_device_t *dev, uint32_t id, const void *arg, size_t size)
{
    esp_err_t ret = ESP_OK;

    switch (id) {
    case ESP_CAM_SENSOR_EXPOSURE_VAL: {
        uint32_t u32_val = *(uint32_t *)arg;
        ret = bf2253_set_exp_val(dev, u32_val);
        break;
    }
    case ESP_CAM_SENSOR_GAIN: {
        uint32_t u32_val = *(uint32_t *)arg;
        ret = bf2253_set_total_gain_val(dev, u32_val);
        break;
    }
    case ESP_CAM_SENSOR_VFLIP: {
        int *value = (int *)arg;
        ret = bf2253_set_vflip(dev, *value);
        break;
    }
    case ESP_CAM_SENSOR_HMIRROR: {
        int *value = (int *)arg;
        ret = bf2253_set_mirror(dev, *value);
        break;
    }
    default: {
        ESP_LOGE(TAG, "set id=%" PRIx32 " is not supported", id);
        ret = ESP_ERR_INVALID_ARG;
        break;
    }
    }

    return ret;
}

static esp_err_t bf2253_query_support_formats(esp_cam_sensor_device_t *dev, esp_cam_sensor_format_array_t *formats)
{
    ESP_CAM_SENSOR_NULL_POINTER_CHECK(TAG, dev);
    ESP_CAM_SENSOR_NULL_POINTER_CHECK(TAG, formats);

    formats->count = ARRAY_SIZE(bf2253_format_info);
    formats->format_array = &bf2253_format_info[0];
    return ESP_OK;
}

static esp_err_t bf2253_query_support_capability(esp_cam_sensor_device_t *dev, esp_cam_sensor_capability_t *sensor_cap)
{
    ESP_CAM_SENSOR_NULL_POINTER_CHECK(TAG, dev);
    ESP_CAM_SENSOR_NULL_POINTER_CHECK(TAG, sensor_cap);

    sensor_cap->fmt_yuv = 1;
    return 0;
}

static esp_err_t bf2253_set_format(esp_cam_sensor_device_t *dev, const esp_cam_sensor_format_t *format)
{
    ESP_CAM_SENSOR_NULL_POINTER_CHECK(TAG, dev);
    struct bf2253_cam *cam_bf2253 = (struct bf2253_cam *)dev->priv;
    esp_err_t ret = ESP_OK;
    /* Depending on the interface type, an available configuration is automatically loaded.
    You can set the output format of the sensor without using query_format().*/
    if (format == NULL) {
        format = &bf2253_format_info[CONFIG_CAMERA_BF2253_MIPI_IF_FORMAT_INDEX_DEFAULT];
    }

    ret = bf2253_write_array(dev->sccb_handle, (bf2253_reginfo_t *)format->regs, format->regs_size);

    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Set format regs fail");
        return ESP_CAM_SENSOR_ERR_FAILED_SET_FORMAT;
    }

    dev->cur_format = format;
    // init para
    cam_bf2253->bf2253_para.exposure_val = dev->cur_format->isp_info->isp_v1_info.exp_def;
    cam_bf2253->bf2253_para.gain_index = dev->cur_format->isp_info->isp_v1_info.gain_def;
    cam_bf2253->bf2253_para.exposure_max = dev->cur_format->isp_info->isp_v1_info.vts - 6;

    return ret;
}

static esp_err_t bf2253_get_format(esp_cam_sensor_device_t *dev, esp_cam_sensor_format_t *format)
{
    ESP_CAM_SENSOR_NULL_POINTER_CHECK(TAG, dev);
    ESP_CAM_SENSOR_NULL_POINTER_CHECK(TAG, format);

    esp_err_t ret = ESP_FAIL;

    if (dev->cur_format != NULL) {
        memcpy(format, dev->cur_format, sizeof(esp_cam_sensor_format_t));
        ret = ESP_OK;
    }
    return ret;
}

static esp_err_t bf2253_priv_ioctl(esp_cam_sensor_device_t *dev, uint32_t cmd, void *arg)
{
    esp_err_t ret = ESP_OK;
    uint8_t regval;
    esp_cam_sensor_reg_val_t *sensor_reg;
    BF2253_IO_MUX_LOCK(mux);

    switch (cmd) {
    case ESP_CAM_SENSOR_IOC_HW_RESET:
        ret = bf2253_hw_reset(dev);
        break;
    case ESP_CAM_SENSOR_IOC_SW_RESET:
        ret = bf2253_soft_reset(dev);
        break;
    case ESP_CAM_SENSOR_IOC_S_REG:
        sensor_reg = (esp_cam_sensor_reg_val_t *)arg;
        ret = bf2253_write(dev->sccb_handle, sensor_reg->regaddr, sensor_reg->value);
        break;
    case ESP_CAM_SENSOR_IOC_S_STREAM:
        ret = bf2253_set_stream(dev, *(int *)arg);
        break;
    case ESP_CAM_SENSOR_IOC_S_TEST_PATTERN:
        ret = bf2253_set_test_pattern(dev, *(int *)arg);
        break;
    case ESP_CAM_SENSOR_IOC_G_REG:
        sensor_reg = (esp_cam_sensor_reg_val_t *)arg;
        ret = bf2253_read(dev->sccb_handle, sensor_reg->regaddr, &regval);
        if (ret == ESP_OK) {
            sensor_reg->value = regval;
        }
        break;
    case ESP_CAM_SENSOR_IOC_G_CHIP_ID:
        ret = bf2253_get_sensor_id(dev, arg);
        break;
    default:
        break;
    }

    BF2253_IO_MUX_UNLOCK(mux);
    return ret;
}

static esp_err_t bf2253_power_on(esp_cam_sensor_device_t *dev)
{
    esp_err_t ret = ESP_OK;

    if (dev->xclk_pin >= 0) {
        BF2253_ENABLE_OUT_XCLK(dev->xclk_pin, dev->xclk_freq_hz);
    }

    if (dev->pwdn_pin >= 0) {
        gpio_config_t conf = { 0 };
        conf.pin_bit_mask = 1LL << dev->pwdn_pin;
        conf.mode = GPIO_MODE_OUTPUT;
        gpio_config(&conf);

        // carefully, logic is inverted compared to reset pin
        gpio_set_level(dev->pwdn_pin, 1);
        delay_ms(10);
        gpio_set_level(dev->pwdn_pin, 0);
        delay_ms(10);
    }

    if (dev->reset_pin >= 0) {
        gpio_config_t conf = { 0 };
        conf.pin_bit_mask = 1LL << dev->reset_pin;
        conf.mode = GPIO_MODE_OUTPUT;
        gpio_config(&conf);

        gpio_set_level(dev->reset_pin, 0);
        delay_ms(10);
        gpio_set_level(dev->reset_pin, 1);
        delay_ms(10);
    }

    return ret;
}

static esp_err_t bf2253_power_off(esp_cam_sensor_device_t *dev)
{
    esp_err_t ret = ESP_OK;

    if (dev->xclk_pin >= 0) {
        BF2253_DISABLE_OUT_XCLK(dev->xclk_pin);
    }

    if (dev->pwdn_pin >= 0) {
        gpio_set_level(dev->pwdn_pin, 0);
        delay_ms(10);
        gpio_set_level(dev->pwdn_pin, 1);
        delay_ms(10);
    }

    if (dev->reset_pin >= 0) {
        gpio_set_level(dev->reset_pin, 1);
        delay_ms(10);
        gpio_set_level(dev->reset_pin, 0);
        delay_ms(10);
    }

    return ret;
}

static esp_err_t bf2253_delete(esp_cam_sensor_device_t *dev)
{
    ESP_LOGD(TAG, "del bf2253 (%p)", dev);
    if (dev) {
        free(dev);
        dev = NULL;
    }

    return ESP_OK;
}

static const esp_cam_sensor_ops_t bf2253_ops = {
    .query_para_desc = bf2253_query_para_desc,
    .get_para_value = bf2253_get_para_value,
    .set_para_value = bf2253_set_para_value,
    .query_support_formats = bf2253_query_support_formats,
    .query_support_capability = bf2253_query_support_capability,
    .set_format = bf2253_set_format,
    .get_format = bf2253_get_format,
    .priv_ioctl = bf2253_priv_ioctl,
    .del = bf2253_delete
};

esp_cam_sensor_device_t *bf2253_detect(esp_cam_sensor_config_t *config)
{
    esp_cam_sensor_device_t *dev = NULL;
    struct bf2253_cam *cam_bf2253;
    s_limited_gain_index = ARRAY_SIZE(bf2253_total_gain_val_map);
    if (config == NULL) {
        return NULL;
    }

    dev = calloc(1, sizeof(esp_cam_sensor_device_t));
    if (dev == NULL) {
        ESP_LOGE(TAG, "No memory for camera");
        return NULL;
    }

    cam_bf2253 = heap_caps_calloc(1, sizeof(struct bf2253_cam), MALLOC_CAP_DEFAULT);
    if (!cam_bf2253) {
        ESP_LOGE(TAG, "failed to calloc cam");
        free(dev);
        return NULL;
    }

    dev->name = (char *)BF2253_SENSOR_NAME;
    dev->sccb_handle = config->sccb_handle;
    dev->xclk_pin = config->xclk_pin;
    dev->reset_pin = config->reset_pin;
    dev->pwdn_pin = config->pwdn_pin;
    dev->sensor_port = config->sensor_port;
    dev->ops = &bf2253_ops;
    dev->priv = cam_bf2253;
    for (size_t i = 0; i < ARRAY_SIZE(bf2253_total_gain_val_map); i++) {
        if (bf2253_total_gain_val_map[i] > s_limited_gain) {
            s_limited_gain_index = i - 1;
            break;
        }
    }
    dev->cur_format = &bf2253_format_info[CONFIG_CAMERA_BF2253_MIPI_IF_FORMAT_INDEX_DEFAULT];

    // Configure sensor power, clock, and SCCB port
    if (bf2253_power_on(dev) != ESP_OK) {
        ESP_LOGE(TAG, "Camera power on failed");
        goto err_free_handler;
    }

    if (bf2253_get_sensor_id(dev, &dev->id) != ESP_OK) {
        ESP_LOGE(TAG, "Get sensor ID failed");
        goto err_free_handler;
    } else if (dev->id.pid != BF2253_PID) {
        ESP_LOGE(TAG, "Camera sensor is not BF2253, PID=0x%x", dev->id.pid);
        goto err_free_handler;
    }
    ESP_LOGI(TAG, "Detected Camera sensor PID=0x%x", dev->id.pid);

    return dev;

err_free_handler:
    bf2253_power_off(dev);
    free(dev);

    return NULL;
}

#if CONFIG_CAMERA_BF2253_AUTO_DETECT_MIPI_INTERFACE_SENSOR
ESP_CAM_SENSOR_DETECT_FN(bf2253_detect, ESP_CAM_SENSOR_MIPI_CSI, BF2253_SCCB_ADDR)
{
    ((esp_cam_sensor_config_t *)config)->sensor_port = ESP_CAM_SENSOR_MIPI_CSI;
    return bf2253_detect(config);
}
#endif
