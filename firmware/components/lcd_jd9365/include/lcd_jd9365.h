// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
#pragma once

#include "esp_lcd_panel_ops.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_io_expander.h"

typedef struct {
    int lane_num;
    int lane_mbps;
    int phy_ldo_chan;
    int phy_ldo_mv;
    int h_res;
    int v_res;
    int hsync, hbp, hfp;
    int vsync, vbp, vfp;
    int num_fb;
    esp_io_expander_handle_t io_expander;
    uint32_t rst_mask; /* IO-expander pin mask for LCD reset */
} lcd_jd9365_config_t;

/**
 * @brief Initialize JD9365 LCD panel over MIPI-DSI
 * @param config Panel configuration
 * @param[out] ret_panel Panel handle for esp_lcd operations
 * @return ESP_OK on success
 */
esp_err_t lcd_jd9365_init(const lcd_jd9365_config_t *config, esp_lcd_panel_handle_t *ret_panel);
