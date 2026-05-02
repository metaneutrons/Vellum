// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
// Ported from Seeed Studio Tcon.cpp (MIT License)
/**
 * @file epaper_it8951.c
 * @brief IT8951 TCON driver for 10.3" E-Paper (reTerminal E1003)
 *
 * The IT8951 uses a 16-bit SPI protocol with preamble bytes:
 * - 0x6000 = Write Command
 * - 0x0000 = Write Data
 * - 0x1000 = Read Data
 * BUSY pin: HIGH = ready
 */

#include "epaper_it8951.h"
#include "driver/spi_master.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <string.h>

static const char *TAG = "it8951";

/* IT8951 Commands */
#define IT8951_CMD_SYS_RUN      0x0001
#define IT8951_CMD_STANDBY      0x0002
#define IT8951_CMD_SLEEP        0x0003
#define IT8951_CMD_REG_RD       0x0010
#define IT8951_CMD_REG_WR       0x0011
#define IT8951_CMD_MEM_BST_RD_T 0x0012
#define IT8951_CMD_MEM_BST_RD_S 0x0013
#define IT8951_CMD_MEM_BST_WR   0x0014
#define IT8951_CMD_MEM_BST_END  0x0015
#define IT8951_CMD_LD_IMG       0x0020
#define IT8951_CMD_LD_IMG_AREA  0x0021
#define IT8951_CMD_LD_IMG_END   0x0022
#define IT8951_CMD_DPY_AREA     0x0034
#define IT8951_CMD_DPY_BUF_AREA 0x0037
#define IT8951_CMD_VCOM         0x0039

/* IT8951 Registers */
#define IT8951_REG_SYS          0x0000
#define IT8951_REG_I80CPCR      0x0004
#define IT8951_REG_MCSR         0x0200
#define IT8951_REG_LISAR        0x0208

/* Preambles */
#define PREAMBLE_CMD  0x6000
#define PREAMBLE_WR   0x0000
#define PREAMBLE_RD   0x1000

/* Pixel formats */
#define IT8951_2BPP  0
#define IT8951_3BPP  1
#define IT8951_4BPP  2
#define IT8951_8BPP  3

static spi_device_handle_t s_spi = NULL;
static int s_busy_pin = -1;
static int s_rst_pin = -1;
static int s_cs_pin = -1;
static it8951_dev_info_t s_info = {0};
static uint32_t s_img_buf_addr = 0;

/* ── Low-level SPI ────────────────────────────────────────────── */

static void wait_busy(void)
{
    int timeout = 5000; // 5 seconds max
    while (gpio_get_level(s_busy_pin) == 0) {
        vTaskDelay(pdMS_TO_TICKS(1));
        if (--timeout <= 0) {
            ESP_LOGW(TAG, "BUSY timeout!");
            return;
        }
    }
}

static void spi_write_16(uint16_t data)
{
    spi_transaction_t t = {
        .length = 16,
        .flags = SPI_TRANS_USE_TXDATA,
    };
    t.tx_data[0] = (data >> 8) & 0xFF;
    t.tx_data[1] = data & 0xFF;
    spi_device_transmit(s_spi, &t);
}

static uint16_t spi_read_16(void)
{
    spi_transaction_t t = {
        .length = 16,
        .rxlength = 16,
        .flags = SPI_TRANS_USE_TXDATA | SPI_TRANS_USE_RXDATA,
    };
    t.tx_data[0] = 0;
    t.tx_data[1] = 0;
    spi_device_transmit(s_spi, &t);
    return (t.rx_data[0] << 8) | t.rx_data[1];
}

static void write_cmd(uint16_t cmd)
{
    gpio_set_level(s_cs_pin, 0);
    wait_busy();
    spi_write_16(PREAMBLE_CMD);
    wait_busy();
    spi_write_16(cmd);
    gpio_set_level(s_cs_pin, 1);
}

static void write_data(uint16_t data)
{
    gpio_set_level(s_cs_pin, 0);
    wait_busy();
    spi_write_16(PREAMBLE_WR);
    wait_busy();
    spi_write_16(data);
    gpio_set_level(s_cs_pin, 1);
}

static uint16_t read_data(void)
{
    uint16_t val;
    gpio_set_level(s_cs_pin, 0);
    wait_busy();
    spi_write_16(PREAMBLE_RD);
    wait_busy();
    spi_read_16(); // dummy
    val = spi_read_16();
    gpio_set_level(s_cs_pin, 1);
    return val;
}

static void write_n_data(const uint16_t *buf, uint32_t count)
{
    gpio_set_level(s_cs_pin, 0);
    wait_busy();
    spi_write_16(PREAMBLE_WR);
    wait_busy();
    for (uint32_t i = 0; i < count; i++) {
        spi_write_16(buf[i]);
    }
    gpio_set_level(s_cs_pin, 1);
}

static void read_n_data(uint16_t *buf, uint32_t count)
{
    gpio_set_level(s_cs_pin, 0);
    wait_busy();
    spi_write_16(PREAMBLE_RD);
    wait_busy();
    spi_read_16(); // dummy
    for (uint32_t i = 0; i < count; i++) {
        buf[i] = spi_read_16();
    }
    gpio_set_level(s_cs_pin, 1);
}

static void send_cmd_arg(uint16_t cmd, const uint16_t *args, uint16_t n_args)
{
    write_cmd(cmd);
    for (uint16_t i = 0; i < n_args; i++) {
        write_data(args[i]);
    }
}

static void write_reg(uint16_t reg, uint16_t val)
{
    write_cmd(IT8951_CMD_REG_WR);
    write_data(reg);
    write_data(val);
}

/* ── Public API ───────────────────────────────────────────────── */

esp_err_t it8951_init(const it8951_config_t *config)
{
    s_busy_pin = config->pin_busy;
    s_rst_pin = config->pin_rst;
    s_cs_pin = config->pin_cs;

    gpio_set_direction(s_busy_pin, GPIO_MODE_INPUT);
    gpio_set_direction(s_rst_pin, GPIO_MODE_OUTPUT);

    /* Enable IT8951 TCON power (ITE_ENABLE = GPIO21 on E1003) */
    gpio_set_direction(GPIO_NUM_21, GPIO_MODE_OUTPUT);
    gpio_set_level(GPIO_NUM_21, 1);

    /* Enable TFT (TFT_ENABLE = GPIO11 / DC pin on E1003) */
    gpio_set_direction(GPIO_NUM_11, GPIO_MODE_OUTPUT);
    gpio_set_level(GPIO_NUM_11, 1);

    vTaskDelay(pdMS_TO_TICKS(100));
    ESP_LOGI(TAG, "Resetting IT8951...");

    /* Hardware reset */
    gpio_set_level(s_rst_pin, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(s_rst_pin, 1);
    vTaskDelay(pdMS_TO_TICKS(100));

    ESP_LOGI(TAG, "Waiting for TCON ready (BUSY pin=%d)...", gpio_get_level(s_busy_pin));
    wait_busy();
    ESP_LOGI(TAG, "TCON ready");

    /* Init SPI */
    ESP_LOGI(TAG, "Initializing SPI...");
    spi_bus_config_t bus = {
        .mosi_io_num = config->pin_mosi,
        .miso_io_num = config->pin_miso,
        .sclk_io_num = config->pin_sck,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = 65536,
    };
    spi_bus_initialize(config->spi_host, &bus, SPI_DMA_CH_AUTO);

    spi_device_interface_config_t dev = {
        .clock_speed_hz = config->speed_hz,
        .mode = 0,
        .spics_io_num = -1, /* Manual CS control — IT8951 needs CS held during preamble+data */
        .queue_size = 1,
    };
    spi_bus_add_device(config->spi_host, &dev, &s_spi);

    /* Configure CS pin manually */
    gpio_set_direction(config->pin_cs, GPIO_MODE_OUTPUT);
    gpio_set_level(config->pin_cs, 1);

    /* Get device info */
    write_cmd(0x0302); // GET_DEV_INFO
    uint16_t info_buf[20];
    read_n_data(info_buf, 20);

    s_info.width = info_buf[0];
    s_info.height = info_buf[1];
    s_img_buf_addr = ((uint32_t)info_buf[3] << 16) | info_buf[2];
    s_info.img_buf_addr = s_img_buf_addr;
    memcpy(s_info.fw_version, &info_buf[4], 16);
    memcpy(s_info.lut_version, &info_buf[12], 16);

    ESP_LOGI(TAG, "IT8951 initialized: %dx%d, buf=0x%08lx", s_info.width, s_info.height, (unsigned long)s_img_buf_addr);
    ESP_LOGI(TAG, "FW: %.16s, LUT: %.16s", s_info.fw_version, s_info.lut_version);

    /* Enable packed write mode */
    write_reg(IT8951_REG_I80CPCR, 0x0001);

    /* Verify register write works */
    write_cmd(IT8951_CMD_REG_RD);
    write_data(IT8951_REG_I80CPCR);
    uint16_t verify = read_data();
    ESP_LOGI(TAG, "I80CPCR read-back: 0x%04X (expected 0x0001)", verify);

    /* Also read MCSR base register for sanity */
    write_cmd(IT8951_CMD_REG_RD);
    write_data(0x0200); /* MCSR */
    uint16_t mcsr = read_data();
    ESP_LOGI(TAG, "MCSR: 0x%04X", mcsr);

    /* Set temperature for waveform selection (required for display refresh) */
    write_cmd(0x0040); /* USDEF_I80_CMD_TEMP */
    write_data(0x0001); /* external temp mode */
    write_data(25);     /* 25°C */

    ESP_LOGI(TAG, "Temperature set to 25C for waveform");

    return ESP_OK;
}

esp_err_t it8951_get_info(it8951_dev_info_t *info)
{
    *info = s_info;
    return ESP_OK;
}

esp_err_t it8951_load_image_4bpp(const uint8_t *data, uint16_t x, uint16_t y, uint16_t w, uint16_t h)
{
    /* Set image buffer base address (high word first, then low) */
    write_reg(IT8951_REG_LISAR + 2, (s_img_buf_addr >> 16) & 0xFFFF);
    write_reg(IT8951_REG_LISAR, s_img_buf_addr & 0xFFFF);

    /* Clear UP1SR bit 2 (required for 4bpp mode per ESPHome reference) */
    write_cmd(IT8951_CMD_REG_RD);
    write_data(0x113A); /* UP1SR + 2 */
    uint16_t up1sr2 = read_data();
    write_reg(0x113A, up1sr2 & ~(1 << 2));

    /* Load image area: endian=little(0), pixel_format=4bpp(2), rotate=0 */
    uint16_t arg0 = (0 << 8) | (IT8951_4BPP << 4) | 0;
    write_cmd(IT8951_CMD_LD_IMG_AREA);
    write_data(arg0);
    write_data(x);
    write_data(y);
    write_data(w);
    write_data(h);

    /* Write pixel data — simple bulk transfer (no row reverse for now) */
    uint32_t total_bytes = (uint32_t)w * h / 2; /* 4bpp */

    gpio_set_level(s_cs_pin, 0);
    wait_busy();
    spi_write_16(PREAMBLE_WR);
    wait_busy();

    /* Send in chunks */
    uint32_t chunk_size = 1024;
    uint8_t *chunk_buf = heap_caps_malloc(chunk_size, MALLOC_CAP_DMA);
    for (uint32_t offset = 0; offset < total_bytes; offset += chunk_size) {
        uint32_t len = (offset + chunk_size > total_bytes) ? (total_bytes - offset) : chunk_size;
        memcpy(chunk_buf, data + offset, len);
        spi_transaction_t t = { .length = len * 8, .tx_buffer = chunk_buf };
        spi_device_transmit(s_spi, &t);
    }
    heap_caps_free(chunk_buf);

    gpio_set_level(s_cs_pin, 1);

    /* End load */
    write_cmd(IT8951_CMD_LD_IMG_END);

    ESP_LOGI(TAG, "Loaded 4bpp image %dx%d at (%d,%d)", w, h, x, y);
    return ESP_OK;
}

esp_err_t it8951_load_image_1bpp(const uint8_t *data, uint16_t x, uint16_t y, uint16_t w, uint16_t h)
{
    /* For 1bpp, convert to 4bpp on the fly or use DPY_BUF_AREA with 1bpp mode */
    /* Simplified: use the IT8951 1bpp display command directly */
    // TODO: implement 1bpp path
    return ESP_ERR_NOT_SUPPORTED;
}

esp_err_t it8951_display_area(uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint16_t mode)
{
    /* Read LUTAFSR before to check state */
    write_cmd(IT8951_CMD_REG_RD);
    write_data(0x1224);
    uint16_t lutafsr_before = read_data();
    ESP_LOGI(TAG, "LUTAFSR before: 0x%04X", lutafsr_before);

    write_cmd(IT8951_CMD_DPY_AREA);
    write_data(x);
    write_data(y);
    write_data(w);
    write_data(h);
    write_data(mode);

    ESP_LOGI(TAG, "Display area %dx%d at (%d,%d) mode=%d — waiting...", w, h, x, y, mode);

    /* Wait for display refresh to complete */
    vTaskDelay(pdMS_TO_TICKS(500));

    /* Read LUTAFSR after */
    write_cmd(IT8951_CMD_REG_RD);
    write_data(0x1224);
    uint16_t lutafsr_after = read_data();
    ESP_LOGI(TAG, "LUTAFSR after: 0x%04X", lutafsr_after);

    /* Wait for LUTAFSR to clear (refresh complete) */
    for (int i = 0; i < 100; i++) {
        write_cmd(IT8951_CMD_REG_RD);
        write_data(0x1224);
        uint16_t val = read_data();
        if (val == 0) {
            ESP_LOGI(TAG, "Display refresh complete (%d ms)", (i + 1) * 100 + 500);
            return ESP_OK;
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
    ESP_LOGW(TAG, "Display refresh timeout (LUTAFSR never cleared)");
    return ESP_OK;
}

esp_err_t it8951_sleep(void)
{
    write_cmd(IT8951_CMD_SLEEP);
    ESP_LOGI(TAG, "Sleep");
    return ESP_OK;
}

esp_err_t it8951_wake(void)
{
    gpio_set_level(s_rst_pin, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(s_rst_pin, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
    wait_busy();
    write_cmd(IT8951_CMD_SYS_RUN);
    ESP_LOGI(TAG, "Wake");
    return ESP_OK;
}

esp_err_t it8951_set_vcom(uint16_t vcom)
{
    write_cmd(IT8951_CMD_VCOM);
    write_data(0x0001); // write mode
    write_data(vcom);
    return ESP_OK;
}

esp_err_t it8951_set_temp(uint16_t temp)
{
    /* Write temperature to force register for waveform selection */
    write_reg(0x0320, temp);
    return ESP_OK;
}
