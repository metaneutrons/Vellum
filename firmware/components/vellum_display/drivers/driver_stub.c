/**
 * @file driver_stub.c
 * @brief Stub display driver — logs operations without hardware.
 */

#include "display_driver.h"
#include "esp_log.h"

static const char *TAG = "drv_stub";

static esp_err_t stub_init(void) { ESP_LOGI(TAG, "init (stub)"); return ESP_OK; }
static esp_err_t stub_draw(const uint8_t *buf, size_t len) { ESP_LOGI(TAG, "draw %zu bytes (stub)", len); return ESP_OK; }
static esp_err_t stub_draw_bitmap(const uint8_t *bmp, uint16_t bw, uint16_t bh, int16_t x, int16_t y) {
    ESP_LOGI(TAG, "draw_bitmap %dx%d at (%d,%d) (stub)", bw, bh, x, y); return ESP_OK;
}
static esp_err_t stub_sleep(void) { ESP_LOGI(TAG, "sleep (stub)"); return ESP_OK; }
static esp_err_t stub_refresh(void) { ESP_LOGI(TAG, "refresh (stub)"); return ESP_OK; }

static const display_driver_t s_driver = {
    .model = "stub",
    .width = 800,
    .height = 480,
    .palette_size = 2,
    .quantize = "mono",
    .init = stub_init,
    .draw = stub_draw,
    .draw_bitmap = stub_draw_bitmap,
    .sleep = stub_sleep,
    .refresh = stub_refresh,
};

const display_driver_t *display_get_driver(void) { return &s_driver; }
