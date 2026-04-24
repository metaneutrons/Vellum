/**
 * @file driver_e1002.c
 * @brief reTerminal E1002 display driver — 7.3" Spectra 6 (UC8179C).
 *
 * 800x480, 7 colors: Black, White, Green, Blue, Red, Yellow, Orange.
 * SPI interface, shared bus with SD card.
 */

#include "display_driver.h"
#include "esp_log.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "drv_e1002";

/* reTerminal E1002 SPI pin assignments */
#define EPD_SPI_HOST  SPI2_HOST
#define EPD_PIN_SCK   GPIO_NUM_7
#define EPD_PIN_MOSI  GPIO_NUM_9
#define EPD_PIN_CS    GPIO_NUM_10
#define EPD_PIN_DC    GPIO_NUM_11
#define EPD_PIN_RST   GPIO_NUM_12
#define EPD_PIN_BUSY  GPIO_NUM_13

/* SD card pins (shared SPI bus) */
#define SD_PIN_CS     GPIO_NUM_14
#define SD_PIN_EN     GPIO_NUM_16

#define EPD_WIDTH     800
#define EPD_HEIGHT    480

static spi_device_handle_t s_spi;

static void eink_cmd(uint8_t cmd)
{
    gpio_set_level(EPD_PIN_DC, 0);
    spi_transaction_t t = { .length = 8, .tx_buffer = &cmd };
    spi_device_transmit(s_spi, &t);
}

static void eink_data(const uint8_t *data, size_t len)
{
    gpio_set_level(EPD_PIN_DC, 1);
    /* SPI max transfer is limited; send in chunks */
    while (len > 0) {
        size_t chunk = len > 4096 ? 4096 : len;
        spi_transaction_t t = { .length = chunk * 8, .tx_buffer = data };
        spi_device_transmit(s_spi, &t);
        data += chunk;
        len -= chunk;
    }
}

static void eink_data_byte(uint8_t val)
{
    eink_data(&val, 1);
}

static void eink_wait_busy(void)
{
    while (gpio_get_level(EPD_PIN_BUSY) == 1) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

static void eink_reset(void)
{
    gpio_set_level(EPD_PIN_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(EPD_PIN_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(2));
    gpio_set_level(EPD_PIN_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(20));
    eink_wait_busy();
}

static void sd_deselect(void)
{
    /* Ensure SD card CS is HIGH to avoid SPI bus conflict */
    gpio_set_direction(SD_PIN_CS, GPIO_MODE_OUTPUT);
    gpio_set_level(SD_PIN_CS, 1);
    gpio_set_direction(SD_PIN_EN, GPIO_MODE_OUTPUT);
    gpio_set_level(SD_PIN_EN, 0); /* Disable SD power */
}

static esp_err_t e1002_init(void)
{
    ESP_LOGI(TAG, "Initializing E1002 (UC8179C, 800x480 Spectra 6)");

    sd_deselect();

    /* Configure control GPIOs */
    gpio_config_t out_conf = {
        .pin_bit_mask = (1ULL << EPD_PIN_DC) | (1ULL << EPD_PIN_RST) | (1ULL << EPD_PIN_CS),
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&out_conf);

    gpio_config_t busy_conf = {
        .pin_bit_mask = (1ULL << EPD_PIN_BUSY),
        .mode = GPIO_MODE_INPUT,
    };
    gpio_config(&busy_conf);

    /* Initialize SPI bus */
    spi_bus_config_t bus = {
        .mosi_io_num = EPD_PIN_MOSI,
        .sclk_io_num = EPD_PIN_SCK,
        .miso_io_num = -1,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = EPD_WIDTH * EPD_HEIGHT,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(EPD_SPI_HOST, &bus, SPI_DMA_CH_AUTO));

    spi_device_interface_config_t dev = {
        .clock_speed_hz = 2 * 1000 * 1000, /* 2 MHz — safe for e-paper */
        .mode = 0,
        .spics_io_num = EPD_PIN_CS,
        .queue_size = 1,
    };
    ESP_ERROR_CHECK(spi_bus_add_device(EPD_SPI_HOST, &dev, &s_spi));

    eink_reset();

    /* UC8179C init sequence for Spectra 6 */
    /* Panel-specific init commands would go here */
    /* For now, basic power-on sequence */

    ESP_LOGI(TAG, "E1002 initialized");
    return ESP_OK;
}

static esp_err_t e1002_draw(const uint8_t *buffer, size_t len)
{
    size_t expected = (size_t)EPD_WIDTH * EPD_HEIGHT;
    if (len != expected) {
        ESP_LOGW(TAG, "Buffer size mismatch: got %zu, expected %zu", len, expected);
        return ESP_ERR_INVALID_SIZE;
    }

    ESP_LOGI(TAG, "Drawing %zu bytes to display", len);

    /*
     * Spectra 6 pixel format: each byte is a palette index (0-6).
     * The UC8179C expects packed pixel data in its native format.
     * For now, send raw palette indices — the actual packing
     * depends on the panel's command set.
     */
    eink_cmd(0x10); /* Start data transmission */
    eink_data(buffer, len);
    eink_cmd(0x12); /* Display refresh */
    eink_wait_busy();

    ESP_LOGI(TAG, "Display updated");
    return ESP_OK;
}

static esp_err_t e1002_draw_bitmap(const uint8_t *bitmap, uint16_t bw, uint16_t bh, int16_t ox, int16_t oy)
{
    /* Allocate full framebuffer, clear to white (palette index 1) */
    size_t fb_len = (size_t)EPD_WIDTH * EPD_HEIGHT;
    uint8_t *fb = calloc(1, fb_len);
    if (!fb) return ESP_ERR_NO_MEM;
    memset(fb, 1, fb_len); /* White */

    /* Blit 1-bit bitmap as black (0) on white (1) */
    for (int y = 0; y < bh; y++) {
        for (int x = 0; x < bw; x++) {
            int src_byte = y * (bw / 8) + (x / 8);
            int src_bit = 7 - (x % 8);
            if (bitmap[src_byte] & (1 << src_bit)) {
                int dx = ox + x;
                int dy = oy + y;
                if (dx >= 0 && dx < EPD_WIDTH && dy >= 0 && dy < EPD_HEIGHT) {
                    fb[dy * EPD_WIDTH + dx] = 0; /* Black */
                }
            }
        }
    }

    esp_err_t ret = e1002_draw(fb, fb_len);
    free(fb);
    return ret;
}

static esp_err_t e1002_sleep(void)
{
    eink_cmd(0x07); /* Deep sleep */
    eink_data_byte(0xA5);
    ESP_LOGI(TAG, "Display entering sleep");
    return ESP_OK;
}

static esp_err_t e1002_refresh(void)
{
    eink_cmd(0x12);
    eink_wait_busy();
    return ESP_OK;
}

static const display_driver_t s_driver = {
    .model = "e1002",
    .width = EPD_WIDTH,
    .height = EPD_HEIGHT,
    .palette_size = 7,
    .quantize = "color",
    .init = e1002_init,
    .draw = e1002_draw,
    .draw_bitmap = e1002_draw_bitmap,
    .sleep = e1002_sleep,
    .refresh = e1002_refresh,
};

const display_driver_t *display_get_driver(void) { return &s_driver; }
