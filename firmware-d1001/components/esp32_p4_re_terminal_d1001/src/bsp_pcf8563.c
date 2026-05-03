
#include "bsp_pcf8563.h"

#define I2C_TIMEOUT_MS (1000)
#define I2C_CLK_SPEED (400000)

static const char *TAG = "PCF8563";

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

static int32_t esp_i2c_write(void *handle, uint8_t reg, uint8_t *buffer, uint16_t length)
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

static esp_err_t set_register_bit(void *handle, uint8_t reg, uint8_t bit, bool val)
{
    esp_err_t ret = ESP_OK;
    uint8_t value = 0;

    ret = esp_i2c_read(handle, reg, &value, 1);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to get register value: %s", esp_err_to_name(ret));
        return ESP_FAIL;
    }

    if (val) {
        value = value | (1 << bit);
    } else {
        value = value & (~(1 << bit));
    }

    ret = esp_i2c_write(handle, reg, &value, 1);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Failed to set register value: %s", esp_err_to_name(ret));
        return ESP_FAIL;
    }

    return ESP_OK;
}

static uint8_t BCD2DEC(uint8_t val)
{
    return ((val / 16 * 10) + (val % 16));
}

static uint8_t DEC2BCD(uint8_t val)
{
    return ((val / 10 * 16) + (val % 10));
}

static uint32_t getLeapYear(uint32_t year)
{
    uint32_t val;
    if (((0u == (year % 4Lu)) && (0u != (year % 100Lu))) || (0u == (year % 400Lu))) {
        val = 1uL;
    } else {
        val = 0uL;
    }
    return val;
}

static uint8_t getDaysInMonth(uint8_t month, uint16_t year)
{
    const uint8_t daysInMonthTable[12] = {
        RTC_DAYS_IN_JANUARY,
        RTC_DAYS_IN_FEBRUARY,
        RTC_DAYS_IN_MARCH,
        RTC_DAYS_IN_APRIL,
        RTC_DAYS_IN_MAY,
        RTC_DAYS_IN_JUNE,
        RTC_DAYS_IN_JULY,
        RTC_DAYS_IN_AUGUST,
        RTC_DAYS_IN_SEPTEMBER,
        RTC_DAYS_IN_OCTOBER,
        RTC_DAYS_IN_NOVEMBER,
        RTC_DAYS_IN_DECEMBER
    };

    uint8_t val;
    val = daysInMonthTable[month - 1u];
    if (2 == month) {
        if (0u != getLeapYear(year)) {
            val++;
        }
    }
    return val;
}

static uint32_t getDayOfWeek(uint32_t day, uint32_t month, uint32_t year)
{
    uint32_t val;
    if (month < 3) {
        month = 12u + month;
        year--;
    }

    val = (day + (((month + 1u) * 26u) / 10u) + year + (year / 4u) + (6u * (year / 100u)) + (year / 400u)) % 7u;
    if (0u == val) {
        val = 7;
    }
    return (val - 1);
}

esp_err_t bsp_new_i2c_pcf8563(i2c_master_bus_handle_t i2c_bus, uint8_t dev_addr, pcf8563_handle_t *handle)
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

    rtc_datatime_t datetime = {0};
    ret = bsp_pcf8563_get_datatime(handle, &datetime);
    if (ret == ESP_OK) {
        ESP_LOGI(TAG, "Initialized successfully");
    }

    return ESP_OK;
}

esp_err_t bsp_pcf8563_set_datatime(pcf8563_handle_t *handle, rtc_datatime_t *datetime)
{
    esp_err_t ret = ESP_OK;
    uint8_t buffer[8] = {0};

    buffer[0] = DEC2BCD(datetime->second) & 0x7F;
    buffer[1] = DEC2BCD(datetime->minute);
    buffer[2] = DEC2BCD(datetime->hour);
    buffer[3] = DEC2BCD(datetime->day);
    // buffer[4] = getDayOfWeek(datetime->day, datetime->month, datetime->year); // TODO
    buffer[4] = DEC2BCD(datetime->week);
    buffer[5] = DEC2BCD(datetime->month);
    buffer[6] = DEC2BCD(datetime->year % 100);

    if ((2000 % datetime->year) == 2000) {
        buffer[5] &= 0x7F;
    } else {
        buffer[5] |= 0x80;
    }

    ret = esp_i2c_write(handle->i2c_handle, PCF8563_SEC_REG, buffer, 7);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to set rtc datetime");
        return ESP_FAIL;
    }

    return ESP_OK;
}

esp_err_t bsp_pcf8563_get_datatime(pcf8563_handle_t *handle, rtc_datatime_t *datetime)
{
    esp_err_t ret = ESP_OK;
    uint8_t buffer[8] = {0};

    ret = esp_i2c_read(handle->i2c_handle, PCF8563_SEC_REG, buffer, 7);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to get rtc datetime");
        return ESP_FAIL;
    }

    datetime->available = ((buffer[0] & 0x80) == 0x80) ? false : true;
    datetime->second = BCD2DEC(buffer[0] & 0x7F);
    datetime->minute = BCD2DEC(buffer[1] & 0x7F);
    datetime->hour   = BCD2DEC(buffer[2] & 0x3F);
    datetime->day    = BCD2DEC(buffer[3] & 0x3F);
    datetime->week   = BCD2DEC(buffer[4] & 0x07);
    datetime->month  = BCD2DEC(buffer[5] & 0x1F);
    datetime->year   = BCD2DEC(buffer[6]);
    datetime->year += (buffer[5] & PCF8563_CENTURY_MASK)? 1900:2000; // cetury:  0 = 1900 , 1 = 2000

    return ESP_OK;
}

esp_err_t bsp_pcf8563_set_alarm(pcf8563_handle_t *handle, rtc_alarm_t *alarm)
{
    esp_err_t ret = ESP_OK;
    uint8_t buffer[4] = {0};
    rtc_datatime_t datetime = {0};
    uint8_t daysInMonth = 0;

    bsp_pcf8563_get_datatime(handle, &datetime);
    daysInMonth = getDaysInMonth(datetime.month, datetime.year);

    if (datetime.minute != PCF8563_NO_ALARM) {
        if (datetime.minute > 59) {
            datetime.minute = 59;
        }
        buffer[0] = DEC2BCD(datetime.minute);
        buffer[0] &= ~PCF8563_ALARM_ENABLE;
    } else {
        buffer[0] = PCF8563_ALARM_ENABLE;
    }

    if (datetime.hour != PCF8563_NO_ALARM) {
        if (datetime.hour > 23) {
            datetime.hour = 23;
        }
        buffer[1] = DEC2BCD(datetime.hour);
        buffer[1] &= ~PCF8563_ALARM_ENABLE;
    } else {
        buffer[1] = PCF8563_ALARM_ENABLE;
    }

    if (datetime.day != PCF8563_NO_ALARM) {
        buffer[2] = DEC2BCD(((datetime.day) < (1) ? (1) : ((datetime.day) > (daysInMonth) ? (daysInMonth) : (datetime.day))));
        buffer[2] &= ~PCF8563_ALARM_ENABLE;
    } else {
        buffer[2] = PCF8563_ALARM_ENABLE;
    }

    if (datetime.week != PCF8563_NO_ALARM) {
        if (datetime.week > 6) {
            datetime.week = 6;
        }
        buffer[3] = DEC2BCD(datetime.week);
        buffer[3] &= ~PCF8563_ALARM_ENABLE;
    } else {
        buffer[3] = PCF8563_ALARM_ENABLE;
    }

    ret = esp_i2c_write(handle->i2c_handle, PCF8563_ALRM_MIN_REG, buffer, 4);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to set rtc alarm");
        return ESP_FAIL;
    }

    return ESP_OK;
}

esp_err_t bsp_pcf8563_get_alarm(pcf8563_handle_t *handle, rtc_alarm_t *alarm)
{
    esp_err_t ret = ESP_OK;
    uint8_t buffer[4] = {0};

    ret = esp_i2c_read(handle->i2c_handle, PCF8563_ALRM_MIN_REG, buffer, 4);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to get rtc alarm");
        return ESP_FAIL;
    }

    alarm->minute = BCD2DEC(buffer[0] & 0x80);
    alarm->hour = BCD2DEC(buffer[1] & 0x40);
    alarm->day = BCD2DEC(buffer[2] & 0x40);
    alarm->week = BCD2DEC(buffer[3] & 0x08);

    return ESP_OK;
}

esp_err_t bsp_pcf8563_enable_alarm(pcf8563_handle_t *handle)
{
    esp_err_t ret = ESP_OK;
    ret = set_register_bit(handle->i2c_handle, PCF8563_STAT2_REG, 1, true);
    return ret;
}

esp_err_t bsp_pcf8563_disable_alarm(pcf8563_handle_t *handle)
{
    esp_err_t ret = ESP_OK;
    ret = set_register_bit(handle->i2c_handle, PCF8563_STAT2_REG, 1, false);
    return ret;
}
