// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file vellum_lcd.c
 * @brief LCD display driver for reTerminal D1001 (8" 800x1280 MIPI-DSI)
 *
 * Uses ESP-IDF esp_lcd MIPI-DSI interface with hardware JPEG decoder.
 * Based on Seeed Studio reTerminal-D1001 BSP.
 */

#include "vellum_lcd.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_mipi_dsi.h"
#include "jpeg_decoder.h"
#include "esp_heap_caps.h"
#include <string.h>

static const char *TAG = "lcd";

#define LCD_WIDTH   800
#define LCD_HEIGHT  1280
#define LCD_BPP     16  /* RGB565 */

/* MIPI-DSI configuration for D1001 panel */
#define MIPI_DSI_LANE_NUM       2
#define MIPI_DSI_LANE_BITRATE   (1000 * 1000 * 500) /* 500 Mbps */

static esp_lcd_panel_handle_t s_panel = NULL;
static uint8_t *s_fb = NULL; /* Framebuffer in PSRAM */

esp_err_t vellum_lcd_init(void)
{
    ESP_LOGI(TAG, "Initializing %dx%d MIPI-DSI LCD", LCD_WIDTH, LCD_HEIGHT);

    /* Allocate framebuffer in PSRAM */
    s_fb = heap_caps_calloc(1, LCD_WIDTH * LCD_HEIGHT * (LCD_BPP / 8), MALLOC_CAP_SPIRAM);
    if (!s_fb) {
        ESP_LOGE(TAG, "Failed to allocate framebuffer");
        return ESP_ERR_NO_MEM;
    }

    /* MIPI-DSI bus configuration */
    esp_lcd_dsi_bus_handle_t dsi_bus = NULL;
    esp_lcd_dsi_bus_config_t bus_config = {
        .bus_id = 0,
        .num_data_lanes = MIPI_DSI_LANE_NUM,
        .phy_clk_src = MIPI_DSI_PHY_CLK_SRC_DEFAULT,
        .lane_bit_rate_mbps = MIPI_DSI_LANE_BITRATE / 1000000,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_dsi_bus(&bus_config, &dsi_bus), TAG, "DSI bus init failed");

    /* Panel IO (DBI interface over DSI) */
    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_dbi_io_config_t dbi_config = {
        .virtual_channel = 0,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_dbi(dsi_bus, &dbi_config, &io), TAG, "DBI IO init failed");

    /* Panel configuration */
    esp_lcd_dpi_panel_config_t dpi_config = {
        .virtual_channel = 0,
        .dpi_clk_src = MIPI_DSI_DPI_CLK_SRC_DEFAULT,
        .dpi_clock_freq_mhz = 52,
        .in_color_format = LCD_COLOR_FMT_RGB565,
        .out_color_format = LCD_COLOR_FMT_RGB565,
        .num_fbs = 1,
        .video_timing = {
            .h_size = LCD_WIDTH,
            .v_size = LCD_HEIGHT,
            .hsync_back_porch = 40,
            .hsync_pulse_width = 4,
            .hsync_front_porch = 40,
            .vsync_back_porch = 16,
            .vsync_pulse_width = 4,
            .vsync_front_porch = 16,
        },
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_dpi(dsi_bus, &dpi_config, &s_panel), TAG, "DPI panel init failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(s_panel), TAG, "Panel init failed");

    /* Clear to white */
    memset(s_fb, 0xFF, LCD_WIDTH * LCD_HEIGHT * (LCD_BPP / 8));
    esp_lcd_panel_draw_bitmap(s_panel, 0, 0, LCD_WIDTH, LCD_HEIGHT, s_fb);

    ESP_LOGI(TAG, "LCD initialized successfully");
    return ESP_OK;
}

esp_err_t vellum_lcd_show_jpeg(const uint8_t *data, uint32_t len)
{
    if (!s_panel || !s_fb) return ESP_ERR_INVALID_STATE;

    /* Decode JPEG to RGB565 framebuffer */
    esp_jpeg_image_cfg_t cfg = {
        .indata = (uint8_t *)data,
        .indata_size = len,
        .outbuf = s_fb,
        .outbuf_size = LCD_WIDTH * LCD_HEIGHT * (LCD_BPP / 8),
        .out_format = JPEG_IMAGE_FORMAT_RGB565,
        .out_scale = JPEG_IMAGE_SCALE_0,
    };
    esp_jpeg_image_output_t out = {};

    esp_err_t ret = esp_jpeg_decode(&cfg, &out);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "JPEG decode failed: %s", esp_err_to_name(ret));
        return ret;
    }

    ESP_LOGI(TAG, "JPEG decoded: %dx%d (%u bytes)", out.width, out.height, (unsigned)out.output_len);

    /* Draw to LCD */
    esp_lcd_panel_draw_bitmap(s_panel, 0, 0, LCD_WIDTH, LCD_HEIGHT, s_fb);

    return ESP_OK;
}

void vellum_lcd_get_size(uint16_t *width, uint16_t *height)
{
    *width = LCD_WIDTH;
    *height = LCD_HEIGHT;
}
