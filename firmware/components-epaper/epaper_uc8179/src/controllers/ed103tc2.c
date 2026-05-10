/**
 * @file ed103tc2.c
 * @brief Controller adapter for ED103TC2 10.3" 16-gray panel via IT8951 TCON.
 *
 * Bridges the epd_controller_ops_t interface to the epaper_it8951 component.
 * The IT8951 handles all waveform/LUT logic internally.
 */

#include "../epaper_common.h"
#include "epaper_it8951.h"
#include "esp_log.h"
#include "sdkconfig.h"

static const char *TAG = "ed103tc2";

/* IT8951 SPI pins (reTerminal E1003) */
#define IT8951_PIN_BUSY  18
#define IT8951_PIN_RST   48
#define IT8951_PIN_CS    10
#define IT8951_PIN_SCK   12
#define IT8951_PIN_MOSI  11
#define IT8951_PIN_MISO  13
#define IT8951_SPI_HOST  SPI2_HOST
#define IT8951_SPI_SPEED (24 * 1000 * 1000)

static bool s_initialized = false;

esp_err_t ed103tc2_init(epd_device_t *dev)
{
    if (s_initialized) return ESP_OK;

    it8951_config_t cfg = {
        .pin_busy = IT8951_PIN_BUSY,
        .pin_rst  = IT8951_PIN_RST,
        .pin_cs   = IT8951_PIN_CS,
        .pin_sck  = IT8951_PIN_SCK,
        .pin_mosi = IT8951_PIN_MOSI,
        .pin_miso = IT8951_PIN_MISO,
        .spi_host = IT8951_SPI_HOST,
        .speed_hz = IT8951_SPI_SPEED,
    };

    esp_err_t ret = it8951_init(&cfg);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "IT8951 init failed: %s", esp_err_to_name(ret));
        return ret;
    }

    it8951_dev_info_t info;
    ret = it8951_get_info(&info);
    if (ret == ESP_OK) {
        ESP_LOGI(TAG, "IT8951: %dx%d, FW=%s, LUT=%s",
                 info.width, info.height, info.fw_version, info.lut_version);
    }

    s_initialized = true;
    return ESP_OK;
}

esp_err_t ed103tc2_update(epd_device_t *dev, epd_update_mode_t mode)
{
    uint16_t w = epd_get_width(dev);
    uint16_t h = epd_get_height(dev);

    /* Map epd_update_mode_t to IT8951 display modes */
    uint16_t it_mode;
    switch (mode) {
        case EPD_UPDATE_FULL:    it_mode = 2; break; /* GC16 */
        case EPD_UPDATE_PARTIAL: it_mode = 1; break; /* DU */
        default:                 it_mode = 2; break;
    }

    return it8951_display_area(0, 0, w, h, it_mode);
}

esp_err_t ed103tc2_write_ram(epd_device_t *dev, const uint8_t *data, uint32_t len)
{
    uint16_t w = epd_get_width(dev);
    uint16_t h = epd_get_height(dev);
    return it8951_load_image_4bpp(data, 0, 0, w, h);
}

esp_err_t ed103tc2_sleep(epd_device_t *dev)
{
    return it8951_sleep();
}

esp_err_t ed103tc2_wake(epd_device_t *dev)
{
    return it8951_wake();
}
