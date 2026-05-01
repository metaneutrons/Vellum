/**
 * @file ed103tc2.c
 * @brief Driver for ED103TC2 16-Grayscale E-Paper (10.3" 1404x1872)
 *
 * Used in the Seeed reTerminal E1003.
 * Format: 4-bit per pixel (2 pixels per byte), MSB first.
 * 16 gray levels (0x0=black, 0xF=white).
 * Supports fast refresh (~3s full).
 */

#include "../epaper_common.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "ed103tc2";

esp_err_t ed103tc2_init(epd_device_t *dev)
{
    epd_spi_t *spi = epd_get_spi(dev);
    uint16_t w = epd_get_width(dev);
    uint16_t h = epd_get_height(dev);

    RESET(spi);
    vTaskDelay(pdMS_TO_TICKS(20));
    WAIT(dev);

    // Power setting
    CMD(spi, 0x01);
    DATA(spi, 0x07);
    DATA(spi, 0x07);
    DATA(spi, 0x3F);
    DATA(spi, 0x3F);
    DATA(spi, 0x03);

    // Booster soft start
    CMD(spi, 0x06);
    DATA(spi, 0x17);
    DATA(spi, 0x17);
    DATA(spi, 0x28);
    DATA(spi, 0x17);

    // Power on
    CMD(spi, 0x04);
    vTaskDelay(pdMS_TO_TICKS(100));
    WAIT(dev);

    // Panel setting — 16-gray mode
    CMD(spi, 0x00);
    DATA(spi, 0x1F); // KW mode, 16-gray, scan up, shift right

    // Resolution setting
    CMD(spi, 0x61);
    DATA(spi, (w >> 8) & 0xFF);
    DATA(spi, w & 0xFF);
    DATA(spi, (h >> 8) & 0xFF);
    DATA(spi, h & 0xFF);

    // VCOM and data interval
    CMD(spi, 0x50);
    DATA(spi, 0x10);
    DATA(spi, 0x07);

    // TCON setting
    CMD(spi, 0x60);
    DATA(spi, 0x22);

    // Gate/Source start setting
    CMD(spi, 0x65);
    DATA(spi, 0x00);
    DATA(spi, 0x00);
    DATA(spi, 0x00);
    DATA(spi, 0x00);

    ESP_LOGI(TAG, "ED103TC2 16-gray init done (%dx%d)", w, h);
    return ESP_OK;
}

esp_err_t ed103tc2_write_ram(epd_device_t *dev, const uint8_t *data, uint32_t len)
{
    epd_spi_t *spi = epd_get_spi(dev);

    // Write 4-bit grayscale data (DTM1)
    CMD(spi, 0x10);
    epd_spi_write_data_bulk(spi, data, len);

    return ESP_OK;
}

esp_err_t ed103tc2_update(epd_device_t *dev, epd_update_mode_t mode)
{
    epd_spi_t *spi = epd_get_spi(dev);

    // Display refresh
    CMD(spi, 0x12);
    vTaskDelay(pdMS_TO_TICKS(100));
    WAIT(dev);

    ESP_LOGI(TAG, "Display updated (mode=%d)", mode);
    return ESP_OK;
}

esp_err_t ed103tc2_sleep(epd_device_t *dev)
{
    epd_spi_t *spi = epd_get_spi(dev);

    // Power off
    CMD(spi, 0x02);
    WAIT(dev);

    // Deep sleep
    CMD(spi, 0x07);
    DATA(spi, 0xA5);

    ESP_LOGI(TAG, "Entering deep sleep");
    return ESP_OK;
}

esp_err_t ed103tc2_wake(epd_device_t *dev)
{
    return ed103tc2_init(dev);
}
