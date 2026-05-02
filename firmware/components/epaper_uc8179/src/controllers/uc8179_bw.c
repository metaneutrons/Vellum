/**
 * @file uc8179_bw.c
 * @brief Driver for UC8179 B/W E-Paper (GDEY075T7, 7.5" 800x480)
 *
 * The UC8179 is used in the Seeed reTerminal E1001.
 * Format: 1-bit per pixel (8 pixels per byte), MSB first.
 * Supports fast refresh (~2s full, ~0.5s partial).
 */

#include "../epaper_common.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "uc8179bw";

esp_err_t uc8179bw_init(epd_device_t *dev)
{
    epd_spi_t *spi = epd_get_spi(dev);
    uint16_t w = epd_get_width(dev);
    uint16_t h = epd_get_height(dev);

    RESET(spi);
    vTaskDelay(pdMS_TO_TICKS(20));
    WAIT(dev);

    // Power setting
    CMD(spi, 0x01);
    DATA(spi, 0x07); // VDS_EN, VDG_EN
    DATA(spi, 0x07); // VCOM_HV, VGHL_LV
    DATA(spi, 0x3F); // VDH
    DATA(spi, 0x3F); // VDL

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

    // Panel setting
    CMD(spi, 0x00);
    DATA(spi, 0x0F); // KW mode, scan up, shift right, booster on

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

    ESP_LOGI(TAG, "UC8179 BW init done (%dx%d)", w, h);
    return ESP_OK;
}

esp_err_t uc8179bw_write_ram(epd_device_t *dev, const uint8_t *data, uint32_t len)
{
    epd_spi_t *spi = epd_get_spi(dev);

    // Write B/W data (DTM1)
    CMD(spi, 0x10);
    epd_spi_write_data_bulk(spi, data, len);

    // Write "old" data (DTM2) — same as DTM1 for full refresh
    CMD(spi, 0x13);
    epd_spi_write_data_bulk(spi, data, len);

    return ESP_OK;
}

esp_err_t uc8179bw_update(epd_device_t *dev, epd_update_mode_t mode)
{
    epd_spi_t *spi = epd_get_spi(dev);

    // Display refresh
    CMD(spi, 0x12);
    vTaskDelay(pdMS_TO_TICKS(100));
    WAIT(dev);

    ESP_LOGI(TAG, "Display updated (mode=%d)", mode);
    return ESP_OK;
}

esp_err_t uc8179bw_sleep(epd_device_t *dev)
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

esp_err_t uc8179bw_wake(epd_device_t *dev)
{
    // Full re-init required after deep sleep
    return uc8179bw_init(dev);
}
