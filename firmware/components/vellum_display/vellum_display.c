/**
 * @file vellum_display.c
 * @brief E-Ink display driver implementation (ESP-IDF SPI).
 *
 * When CONFIG_VELLUM_HAS_DISPLAY is enabled, this drives the actual
 * 800x480 E-Ink panel via SPI. Otherwise, all operations are logged
 * but no hardware is touched — useful for host-side testing.
 */

#include "vellum_display.h"
#include "fallback_icons.h"

#include <string.h>
#include "esp_log.h"

#if CONFIG_VELLUM_HAS_DISPLAY
#include "driver/spi_master.h"
#include "driver/gpio.h"

/* SPI pin assignments — adjust for your board */
#define EINK_SPI_HOST   SPI2_HOST
#define EINK_PIN_MOSI   GPIO_NUM_11
#define EINK_PIN_CLK    GPIO_NUM_12
#define EINK_PIN_CS     GPIO_NUM_5
#define EINK_PIN_DC     GPIO_NUM_17
#define EINK_PIN_RST    GPIO_NUM_16
#define EINK_PIN_BUSY   GPIO_NUM_4

static spi_device_handle_t s_spi_dev;
#endif /* CONFIG_VELLUM_HAS_DISPLAY */

static const char *TAG = "display";

/* ---- SPI helpers (only compiled with display hardware) ----------------- */

#if CONFIG_VELLUM_HAS_DISPLAY
static void eink_send_cmd(uint8_t cmd)
{
    gpio_set_level(EINK_PIN_DC, 0);
    spi_transaction_t t = { .length = 8, .tx_buffer = &cmd };
    spi_device_transmit(s_spi_dev, &t);
}

static void eink_send_data(const uint8_t *data, size_t len)
{
    gpio_set_level(EINK_PIN_DC, 1);
    spi_transaction_t t = { .length = len * 8, .tx_buffer = data };
    spi_device_transmit(s_spi_dev, &t);
}

static void eink_wait_busy(void)
{
    while (gpio_get_level(EINK_PIN_BUSY) == 1) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

static void eink_reset(void)
{
    gpio_set_level(EINK_PIN_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(EINK_PIN_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
    eink_wait_busy();
}
#endif /* CONFIG_VELLUM_HAS_DISPLAY */

/* ---- Public API -------------------------------------------------------- */

void display_init(void)
{
    ESP_LOGI(TAG, "Initializing display (%dx%d)", DISPLAY_WIDTH, DISPLAY_HEIGHT);

#if CONFIG_VELLUM_HAS_DISPLAY
    /* Configure control GPIOs */
    gpio_config_t io_conf = {
        .pin_bit_mask = (1ULL << EINK_PIN_DC) | (1ULL << EINK_PIN_RST),
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&io_conf);

    gpio_config_t busy_conf = {
        .pin_bit_mask = (1ULL << EINK_PIN_BUSY),
        .mode = GPIO_MODE_INPUT,
    };
    gpio_config(&busy_conf);

    /* Initialize SPI bus */
    spi_bus_config_t bus_cfg = {
        .mosi_io_num = EINK_PIN_MOSI,
        .sclk_io_num = EINK_PIN_CLK,
        .miso_io_num = -1,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = DISPLAY_WIDTH * DISPLAY_HEIGHT / 8 + 64,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(EINK_SPI_HOST, &bus_cfg, SPI_DMA_CH_AUTO));

    spi_device_interface_config_t dev_cfg = {
        .clock_speed_hz = 10 * 1000 * 1000, /* 10 MHz */
        .mode = 0,
        .spics_io_num = EINK_PIN_CS,
        .queue_size = 1,
    };
    ESP_ERROR_CHECK(spi_bus_add_device(EINK_SPI_HOST, &dev_cfg, &s_spi_dev));

    eink_reset();
    /* Panel-specific init sequence would go here */
#endif
}

bool display_draw_pixel_buffer(const uint8_t *buffer, size_t length)
{
    if (!buffer) {
        ESP_LOGW(TAG, "draw_pixel_buffer: null buffer");
        return false;
    }

    size_t expected = (size_t)DISPLAY_WIDTH * DISPLAY_HEIGHT;
    if (length != expected) {
        ESP_LOGW(TAG, "draw_pixel_buffer: unexpected length %zu (expected %zu)", length, expected);
        return false;
    }

#if CONFIG_VELLUM_HAS_DISPLAY
    /*
     * Pack palette indices into 1bpp for BW panel.
     * Index 0 = white, index 1 = black.
     */
    size_t packed_len = expected / 8;
    uint8_t *packed = malloc(packed_len);
    if (!packed) {
        ESP_LOGE(TAG, "OOM allocating packed buffer");
        return false;
    }

    for (size_t i = 0; i < packed_len; i++) {
        uint8_t byte = 0;
        for (int bit = 7; bit >= 0; bit--) {
            size_t px = i * 8 + (7 - bit);
            if (buffer[px] != 0) {
                byte |= (1 << bit);
            }
        }
        packed[i] = byte;
    }

    /* Send to display */
    eink_send_cmd(0x24); /* Write RAM (BW) — panel-specific */
    eink_send_data(packed, packed_len);
    eink_send_cmd(0x20); /* Display Update */
    eink_wait_busy();

    free(packed);
#else
    ESP_LOGI(TAG, "draw_pixel_buffer: %zu bytes (no display hardware)", length);
#endif

    return true;
}

void display_draw_fallback_icon(uint8_t icon_id)
{
    if (icon_id >= FALLBACK_ICON_COUNT) {
        ESP_LOGW(TAG, "draw_fallback_icon: invalid id %d", icon_id);
        return;
    }

    ESP_LOGI(TAG, "Drawing fallback icon %d", icon_id);

#if CONFIG_VELLUM_HAS_DISPLAY
    const uint8_t *bitmap = fallback_icons[icon_id];

    /* Clear display and draw 64x64 icon centered */
    size_t fb_len = (size_t)DISPLAY_WIDTH * DISPLAY_HEIGHT / 8;
    uint8_t *fb = calloc(1, fb_len); /* all white */
    if (!fb) return;

    int ox = (DISPLAY_WIDTH - ICON_BITMAP_WIDTH) / 2;
    int oy = (DISPLAY_HEIGHT - ICON_BITMAP_HEIGHT) / 2;

    for (int y = 0; y < ICON_BITMAP_HEIGHT; y++) {
        for (int x = 0; x < ICON_BITMAP_WIDTH; x++) {
            int src_byte = y * (ICON_BITMAP_WIDTH / 8) + (x / 8);
            int src_bit = 7 - (x % 8);
            if (bitmap[src_byte] & (1 << src_bit)) {
                int dx = ox + x;
                int dy = oy + y;
                int dst_byte = (dy * DISPLAY_WIDTH + dx) / 8;
                int dst_bit = 7 - ((dy * DISPLAY_WIDTH + dx) % 8);
                fb[dst_byte] |= (1 << dst_bit);
            }
        }
    }

    eink_send_cmd(0x24);
    eink_send_data(fb, fb_len);
    eink_send_cmd(0x20);
    eink_wait_busy();
    free(fb);
#endif
}

void display_draw_qr_code(const char *data)
{
    ESP_LOGI(TAG, "Drawing QR code: %s", data);
    /* TODO: Integrate a QR code library (e.g. qrcodegen) */
#if CONFIG_VELLUM_HAS_DISPLAY
    /* Placeholder: would render QR code bitmap here */
#endif
}

void display_show_loading(void)
{
    ESP_LOGI(TAG, "Showing loading indicator");
    /* TODO: Partial update with "Loading..." text */
}

void display_refresh(void)
{
#if CONFIG_VELLUM_HAS_DISPLAY
    eink_send_cmd(0x20);
    eink_wait_busy();
#endif
    ESP_LOGI(TAG, "Display refreshed");
}

void display_sleep(void)
{
#if CONFIG_VELLUM_HAS_DISPLAY
    eink_send_cmd(0x10); /* Enter deep sleep */
    uint8_t param = 0x01;
    eink_send_data(&param, 1);
#endif
    ESP_LOGI(TAG, "Display entering sleep");
}
