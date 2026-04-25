/**
 * @file driver_e1003.c
 * @brief reTerminal E1003 display driver — 10.3" 16-Gray (UC8179).
 *
 * 800x480, 4-level grayscale. Same SPI pins as E1002.
 */

#include "display_driver.h"
#include "esp_log.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "drv_e1003";

#define EPD_SPI_HOST  SPI2_HOST
#define EPD_PIN_SCK   GPIO_NUM_7
#define EPD_PIN_MOSI  GPIO_NUM_9
#define EPD_PIN_CS    GPIO_NUM_10
#define EPD_PIN_DC    GPIO_NUM_11
#define EPD_PIN_RST   GPIO_NUM_12
#define EPD_PIN_BUSY  GPIO_NUM_13
#define SD_PIN_CS     GPIO_NUM_14
#define SD_PIN_EN     GPIO_NUM_16

#define EPD_WIDTH     1404
#define EPD_HEIGHT    1872

static spi_device_handle_t s_spi;

static void eink_cmd(uint8_t cmd) {
    gpio_set_level(EPD_PIN_DC, 0);
    spi_transaction_t t = { .length = 8, .tx_buffer = &cmd };
    spi_device_transmit(s_spi, &t);
}

static void eink_data(const uint8_t *data, size_t len) {
    gpio_set_level(EPD_PIN_DC, 1);
    while (len > 0) {
        size_t chunk = len > 4096 ? 4096 : len;
        spi_transaction_t t = { .length = chunk * 8, .tx_buffer = data };
        spi_device_transmit(s_spi, &t);
        data += chunk; len -= chunk;
    }
}

static void eink_data_byte(uint8_t val) { eink_data(&val, 1); }

static void eink_wait_busy(void) {
    while (gpio_get_level(EPD_PIN_BUSY) == 1) vTaskDelay(pdMS_TO_TICKS(10));
}

static void eink_reset(void) {
    gpio_set_level(EPD_PIN_RST, 1); vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(EPD_PIN_RST, 0); vTaskDelay(pdMS_TO_TICKS(2));
    gpio_set_level(EPD_PIN_RST, 1); vTaskDelay(pdMS_TO_TICKS(20));
    eink_wait_busy();
}

static esp_err_t e1003_init(void) {
    ESP_LOGI(TAG, "Initializing E1003 (ED103TC2, 1404x1872 16-Gray)");

    gpio_set_direction(SD_PIN_CS, GPIO_MODE_OUTPUT); gpio_set_level(SD_PIN_CS, 1);
    gpio_set_direction(SD_PIN_EN, GPIO_MODE_OUTPUT); gpio_set_level(SD_PIN_EN, 0);

    gpio_config_t out = { .pin_bit_mask = (1ULL<<EPD_PIN_DC)|(1ULL<<EPD_PIN_RST)|(1ULL<<EPD_PIN_CS), .mode = GPIO_MODE_OUTPUT };
    gpio_config(&out);
    gpio_config_t in = { .pin_bit_mask = (1ULL<<EPD_PIN_BUSY), .mode = GPIO_MODE_INPUT };
    gpio_config(&in);

    spi_bus_config_t bus = { .mosi_io_num=EPD_PIN_MOSI, .sclk_io_num=EPD_PIN_SCK, .miso_io_num=-1, .quadwp_io_num=-1, .quadhd_io_num=-1, .max_transfer_sz=EPD_WIDTH*EPD_HEIGHT };
    ESP_ERROR_CHECK(spi_bus_initialize(EPD_SPI_HOST, &bus, SPI_DMA_CH_AUTO));

    spi_device_interface_config_t dev = { .clock_speed_hz=2000000, .mode=0, .spics_io_num=EPD_PIN_CS, .queue_size=1 };
    ESP_ERROR_CHECK(spi_bus_add_device(EPD_SPI_HOST, &dev, &s_spi));

    eink_reset();
    ESP_LOGI(TAG, "E1003 initialized");
    return ESP_OK;
}

static esp_err_t e1003_draw(const uint8_t *buffer, size_t len) {
    size_t expected = (size_t)EPD_WIDTH * EPD_HEIGHT;
    if (len != expected) { ESP_LOGW(TAG, "Size mismatch: %zu vs %zu", len, expected); return ESP_ERR_INVALID_SIZE; }

    /* Pack palette indices (0-15) into 4bpp: 2 pixels per byte */
    size_t packed_len = expected / 2;
    uint8_t *packed = malloc(packed_len);
    if (!packed) return ESP_ERR_NO_MEM;

    for (size_t i = 0; i < packed_len; i++) {
        packed[i] = (buffer[i*2] << 4) | (buffer[i*2+1] & 0x0F);
    }

    eink_cmd(0x24);
    eink_data(packed, packed_len);
    eink_cmd(0x20);
    eink_wait_busy();
    free(packed);
    return ESP_OK;
}

static esp_err_t e1003_draw_bitmap(const uint8_t *bitmap, uint16_t bw, uint16_t bh, int16_t ox, int16_t oy) {
    size_t fb_len = (size_t)EPD_WIDTH * EPD_HEIGHT / 8;
    uint8_t *fb = calloc(1, fb_len);
    if (!fb) return ESP_ERR_NO_MEM;

    for (int y = 0; y < bh; y++) {
        for (int x = 0; x < bw; x++) {
            int src_byte = y * (bw / 8) + (x / 8);
            int src_bit = 7 - (x % 8);
            if (bitmap[src_byte] & (1 << src_bit)) {
                int dx = ox + x, dy = oy + y;
                if (dx >= 0 && dx < EPD_WIDTH && dy >= 0 && dy < EPD_HEIGHT) {
                    int dst_byte = (dy * EPD_WIDTH + dx) / 8;
                    int dst_bit = 7 - ((dy * EPD_WIDTH + dx) % 8);
                    fb[dst_byte] |= (1 << dst_bit);
                }
            }
        }
    }

    eink_cmd(0x24); eink_data(fb, fb_len); eink_cmd(0x20); eink_wait_busy();
    free(fb);
    return ESP_OK;
}

static esp_err_t e1003_sleep(void) { eink_cmd(0x07); eink_data_byte(0xA5); return ESP_OK; }
static esp_err_t e1003_refresh(void) { eink_cmd(0x20); eink_wait_busy(); return ESP_OK; }

static const display_driver_t s_driver = {
    .model="e1003", .width=EPD_WIDTH, .height=EPD_HEIGHT, .palette_size=16, .quantize="grayscale",
    .init=e1003_init, .draw=e1003_draw, .draw_bitmap=e1003_draw_bitmap, .sleep=e1003_sleep, .refresh=e1003_refresh,
};

const display_driver_t *display_get_driver(void) { return &s_driver; }
