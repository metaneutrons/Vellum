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
static it8951_dev_info_t s_info = {0};
static uint32_t s_img_buf_addr = 0;

/* ── Low-level SPI ────────────────────────────────────────────── */

static void wait_busy(void)
{
    while (gpio_get_level(s_busy_pin) == 0) {
        vTaskDelay(pdMS_TO_TICKS(1));
    }
}

static void spi_write_16(uint16_t data)
{
    uint8_t buf[2] = { (data >> 8) & 0xFF, data & 0xFF };
    spi_transaction_t t = { .length = 16, .tx_buffer = buf };
    spi_device_transmit(s_spi, &t);
}

static uint16_t spi_read_16(void)
{
    uint8_t rx[2] = {0};
    spi_transaction_t t = { .length = 16, .rxlength = 16, .tx_buffer = rx, .rx_buffer = rx };
    spi_device_transmit(s_spi, &t);
    return (rx[0] << 8) | rx[1];
}

static void write_cmd(uint16_t cmd)
{
    spi_device_acquire_bus(s_spi, portMAX_DELAY);
    wait_busy();
    spi_write_16(PREAMBLE_CMD);
    wait_busy();
    spi_write_16(cmd);
    spi_device_release_bus(s_spi);
}

static void write_data(uint16_t data)
{
    spi_device_acquire_bus(s_spi, portMAX_DELAY);
    wait_busy();
    spi_write_16(PREAMBLE_WR);
    wait_busy();
    spi_write_16(data);
    spi_device_release_bus(s_spi);
}

static uint16_t read_data(void)
{
    uint16_t val;
    spi_device_acquire_bus(s_spi, portMAX_DELAY);
    wait_busy();
    spi_write_16(PREAMBLE_RD);
    wait_busy();
    spi_read_16(); // dummy
    val = spi_read_16();
    spi_device_release_bus(s_spi);
    return val;
}

static void write_n_data(const uint16_t *buf, uint32_t count)
{
    spi_device_acquire_bus(s_spi, portMAX_DELAY);
    wait_busy();
    spi_write_16(PREAMBLE_WR);
    wait_busy();
    for (uint32_t i = 0; i < count; i++) {
        spi_write_16(buf[i]);
    }
    spi_device_release_bus(s_spi);
}

static void read_n_data(uint16_t *buf, uint32_t count)
{
    spi_device_acquire_bus(s_spi, portMAX_DELAY);
    wait_busy();
    spi_write_16(PREAMBLE_RD);
    wait_busy();
    spi_read_16(); // dummy
    for (uint32_t i = 0; i < count; i++) {
        buf[i] = spi_read_16();
    }
    spi_device_release_bus(s_spi);
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

    gpio_set_direction(s_busy_pin, GPIO_MODE_INPUT);
    gpio_set_direction(s_rst_pin, GPIO_MODE_OUTPUT);

    /* Hardware reset */
    gpio_set_level(s_rst_pin, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(s_rst_pin, 1);
    vTaskDelay(pdMS_TO_TICKS(100));
    wait_busy();

    /* Init SPI */
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
        .spics_io_num = config->pin_cs,
        .queue_size = 1,
    };
    spi_bus_add_device(config->spi_host, &dev, &s_spi);

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

    return ESP_OK;
}

esp_err_t it8951_get_info(it8951_dev_info_t *info)
{
    *info = s_info;
    return ESP_OK;
}

esp_err_t it8951_load_image_4bpp(const uint8_t *data, uint16_t x, uint16_t y, uint16_t w, uint16_t h)
{
    /* Set image buffer base address */
    write_reg(IT8951_REG_LISAR, s_img_buf_addr & 0xFFFF);
    write_reg(IT8951_REG_LISAR + 2, (s_img_buf_addr >> 16) & 0xFFFF);

    /* Load image area */
    uint16_t args[5] = {
        (IT8951_4BPP << 4) | 0, // endian=little, pixel_format=4bpp, rotate=0
        x, y, w, h
    };
    write_cmd(IT8951_CMD_LD_IMG_AREA);
    for (int i = 0; i < 5; i++) write_data(args[i]);

    /* Write pixel data as 16-bit words */
    uint32_t byte_count = (uint32_t)w * h / 2; // 4bpp = 2 pixels per byte
    uint32_t word_count = (byte_count + 1) / 2;

    spi_device_acquire_bus(s_spi, portMAX_DELAY);
    wait_busy();
    spi_write_16(PREAMBLE_WR);
    wait_busy();
    for (uint32_t i = 0; i < word_count; i++) {
        uint16_t word = (data[i * 2] << 8);
        if (i * 2 + 1 < byte_count) word |= data[i * 2 + 1];
        spi_write_16(word);
    }
    spi_device_release_bus(s_spi);

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
    uint16_t args[7] = { x, y, w, h, mode, 0, 0 };
    send_cmd_arg(IT8951_CMD_DPY_AREA, args, 5);

    ESP_LOGI(TAG, "Display area %dx%d at (%d,%d) mode=%d", w, h, x, y, mode);

    /* Wait for display to finish */
    vTaskDelay(pdMS_TO_TICKS(100));
    wait_busy();

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
