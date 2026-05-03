// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#include "lcd_jd9365.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_ldo_regulator.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_jd9365_8.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "lcd_jd9365";

esp_err_t lcd_jd9365_init(const lcd_jd9365_config_t *config, esp_lcd_panel_handle_t *ret_panel)
{
    /* Power MIPI-DSI PHY via LDO */
    esp_ldo_channel_handle_t phy_pwr = NULL;
    esp_ldo_channel_config_t ldo_cfg = {
        .chan_id = config->phy_ldo_chan,
        .voltage_mv = config->phy_ldo_mv,
    };
    ESP_RETURN_ON_ERROR(esp_ldo_acquire_channel(&ldo_cfg, &phy_pwr), TAG, "LDO failed");
    ESP_LOGI(TAG, "MIPI-DSI PHY powered on");

    /* Create DSI bus */
    esp_lcd_dsi_bus_handle_t dsi_bus = NULL;
    esp_lcd_dsi_bus_config_t bus_cfg = {
        .bus_id = 0,
        .num_data_lanes = config->lane_num,
        .phy_clk_src = MIPI_DSI_PHY_CLK_SRC_DEFAULT,
        .lane_bit_rate_mbps = config->lane_mbps,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_dsi_bus(&bus_cfg, &dsi_bus), TAG, "DSI bus failed");

    /* DBI command interface */
    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_dbi_io_config_t dbi_cfg = {
        .virtual_channel = 0,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_dbi(dsi_bus, &dbi_cfg, &io), TAG, "Panel IO failed");

    /* DPI panel config for v6.0 */
    esp_lcd_dpi_panel_config_t dpi_cfg = {
        .virtual_channel = 0,
        .dpi_clk_src = MIPI_DSI_DPI_CLK_SRC_DEFAULT,
        .dpi_clock_freq_mhz = 52,
        .in_color_format = LCD_COLOR_FMT_RGB565,
        .out_color_format = LCD_COLOR_FMT_RGB565,
        .num_fbs = config->num_fb,
        .video_timing = {
            .h_size = config->h_res,
            .v_size = config->v_res,
            .hsync_back_porch = config->hbp,
            .hsync_front_porch = config->hfp,
            .hsync_pulse_width = config->hsync,
            .vsync_back_porch = config->vbp,
            .vsync_front_porch = config->vfp,
            .vsync_pulse_width = config->vsync,
        },
    };

    /* JD9365 vendor config */
    jd9365_8_vendor_config_t vendor_cfg = {
        .mipi_config = {
            .dsi_bus = dsi_bus,
            .dpi_config = &dpi_cfg,
            .lane_num = config->lane_num,
        },
    };
    esp_lcd_panel_dev_config_t dev_cfg = {
        .reset_gpio_num = -1,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
        .vendor_config = &vendor_cfg,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_jd9365_8(io, &dev_cfg, ret_panel), TAG, "JD9365 failed");

    /* Hardware reset via IO-expander */
    if (config->io_expander && config->rst_mask) {
        esp_io_expander_set_level(config->io_expander, config->rst_mask, 1);
        vTaskDelay(pdMS_TO_TICKS(5));
        esp_io_expander_set_level(config->io_expander, config->rst_mask, 0);
        vTaskDelay(pdMS_TO_TICKS(10));
        esp_io_expander_set_level(config->io_expander, config->rst_mask, 1);
        vTaskDelay(pdMS_TO_TICKS(120));
    }

    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(*ret_panel), TAG, "Panel init failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(*ret_panel, true), TAG, "Panel ON failed");

    ESP_LOGI(TAG, "JD9365 %dx%d initialized", config->h_res, config->v_res);
    return ESP_OK;
}
