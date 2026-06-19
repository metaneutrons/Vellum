// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file vellum_display_lcd.c
 * @brief LCD/LVGL display implementation for D1001 (ESP32-P4 + JD9365).
 *
 * Matches the standalone D1001 firmware approach: LVGL tick task runs
 * independently, display_show_* calls manipulate LVGL objects directly
 * from the main task (same as standalone firmware that works).
 */

#include "vellum_display.h"
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "lvgl.h"
#include "esp_lcd_mipi_dsi.h"
#include "d1001_board.h"
#include "lcd_jd9365.h"
#include "jpeg_decoder.h"

static const char *TAG = "display_lcd";

#define LCD_WIDTH  800
#define LCD_HEIGHT 1280

static lv_display_t *s_display = NULL;

/* ── Logo ─────────────────────────────────────────────────────── */
#include "vellum_logo_rgb565.h"
#define VELLUM_LOGO_W VELLUM_LOGO_RGB565_W
#define VELLUM_LOGO_H VELLUM_LOGO_RGB565_H

static lv_color_t *s_logo_buf = NULL;

static void draw_logo(lv_obj_t *parent)
{
    if (!s_logo_buf) {
        s_logo_buf = heap_caps_malloc(VELLUM_LOGO_W * VELLUM_LOGO_H * 2, MALLOC_CAP_SPIRAM);
        if (!s_logo_buf) return;
        memcpy(s_logo_buf, vellum_logo_rgb565, VELLUM_LOGO_W * VELLUM_LOGO_H * 2);
    }

    static lv_image_dsc_t logo_dsc;
    memset(&logo_dsc, 0, sizeof(logo_dsc));
    logo_dsc.header.w = VELLUM_LOGO_W;
    logo_dsc.header.h = VELLUM_LOGO_H;
    logo_dsc.header.cf = LV_COLOR_FORMAT_RGB565;
    logo_dsc.data_size = VELLUM_LOGO_W * VELLUM_LOGO_H * 2;
    logo_dsc.data = (const uint8_t *)s_logo_buf;

    lv_obj_t *img = lv_image_create(parent);
    lv_image_set_src(img, &logo_dsc);
    lv_obj_align(img, LV_ALIGN_CENTER, 0, -60);
}

/* ── LVGL flush (DPI panel uses direct framebuffer) ───────────── */

static void flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map)
{
    (void)area; (void)px_map;
    lv_display_flush_ready(disp);
}

/* ── Unified API ──────────────────────────────────────────────── */

esp_err_t vellum_display_init(void)
{
    lcd_jd9365_config_t lcd_cfg = {
        .lane_num = D1001_DSI_LANE_NUM,
        .lane_mbps = D1001_DSI_LANE_MBPS,
        .phy_ldo_chan = D1001_DSI_PHY_LDO_CHAN,
        .phy_ldo_mv = D1001_DSI_PHY_LDO_MV,
        .h_res = D1001_LCD_H_RES,
        .v_res = D1001_LCD_V_RES,
        .hsync = D1001_LCD_HSYNC, .hbp = D1001_LCD_HBP, .hfp = D1001_LCD_HFP,
        .vsync = D1001_LCD_VSYNC, .vbp = D1001_LCD_VBP, .vfp = D1001_LCD_VFP,
        .num_fb = 2,
        .io_expander = d1001_io_expander(),
        .rst_mask = D1001_EXP_LCD_RST,
    };
    esp_lcd_panel_handle_t panel = NULL;
    esp_lcd_panel_io_handle_t io = NULL;
    ESP_ERROR_CHECK(lcd_jd9365_init(&lcd_cfg, &panel, &io));

    lv_init();

    void *buf1 = NULL, *buf2 = NULL;
    ESP_ERROR_CHECK(esp_lcd_dpi_panel_get_frame_buffer(panel, 2, &buf1, &buf2));

    s_display = lv_display_create(LCD_WIDTH, LCD_HEIGHT);
    lv_display_set_buffers(s_display, buf1, buf2, LCD_WIDTH * LCD_HEIGHT * 2, LV_DISPLAY_RENDER_MODE_DIRECT);
    lv_display_set_flush_cb(s_display, flush_cb);

    vTaskDelay(pdMS_TO_TICKS(100));
    d1001_backlight_on();
    vellum_display_show_status("Booting...");
    ESP_LOGI(TAG, "LCD initialized: %dx%d", LCD_WIDTH, LCD_HEIGHT);

    return ESP_OK;
}

esp_err_t vellum_display_show_status(const char *text)
{
    if (!s_display) return ESP_ERR_INVALID_STATE;

    lv_obj_t *scr = lv_display_get_screen_active(s_display);
    lv_obj_clean(scr);
    lv_obj_set_style_bg_color(scr, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);

    draw_logo(scr);

    lv_obj_t *label = lv_label_create(scr);
    lv_label_set_text(label, text);
    lv_obj_set_style_text_font(label, &lv_font_montserrat_48, 0);
    lv_obj_set_style_text_color(label, lv_color_make(180, 180, 180), 0);
    lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(label, LV_ALIGN_CENTER, 0, VELLUM_LOGO_H / 2 + 60);

    /* Force immediate render */
    lv_tick_inc(10);
    lv_timer_handler();

    return ESP_OK;
}

esp_err_t vellum_display_show_image(const uint8_t *data, size_t len, const char *format)
{
    if (!data || !s_display) return ESP_ERR_INVALID_STATE;

    static uint8_t *s_rgb_buf = NULL;
    if (!s_rgb_buf)
        s_rgb_buf = heap_caps_malloc(LCD_WIDTH * LCD_HEIGHT * 2, MALLOC_CAP_SPIRAM);
    if (!s_rgb_buf) return ESP_ERR_NO_MEM;

    if (!format || strcmp(format, "jpeg") == 0) {
        esp_jpeg_image_cfg_t jpeg_cfg = {
            .indata = (uint8_t *)data, .indata_size = len,
            .outbuf = s_rgb_buf, .outbuf_size = LCD_WIDTH * LCD_HEIGHT * 2,
            .out_format = JPEG_IMAGE_FORMAT_RGB565,
            .out_scale = JPEG_IMAGE_SCALE_0,
        };
        esp_jpeg_image_output_t out;
        esp_err_t ret = esp_jpeg_decode(&jpeg_cfg, &out);
        if (ret != ESP_OK) {
            ESP_LOGE(TAG, "JPEG decode failed: %s", esp_err_to_name(ret));
            return ret;
        }

        uint16_t disp_w = out.width, disp_h = out.height;
        if (out.width > out.height && LCD_HEIGHT > LCD_WIDTH) {
            uint16_t *src = (uint16_t *)s_rgb_buf;
            uint16_t *dst = heap_caps_malloc(out.width * out.height * 2, MALLOC_CAP_SPIRAM);
            if (dst) {
                for (int y = 0; y < out.height; y++)
                    for (int x = 0; x < out.width; x++)
                        dst[x * out.height + (out.height - 1 - y)] = src[y * out.width + x];
                memcpy(s_rgb_buf, dst, out.width * out.height * 2);
                free(dst);
                disp_w = out.height; disp_h = out.width;
            }
        }

        lv_obj_t *scr = lv_display_get_screen_active(s_display);
        lv_obj_clean(scr);
        lv_obj_t *img = lv_image_create(scr);
        static lv_image_dsc_t img_dsc;
        memset(&img_dsc, 0, sizeof(img_dsc));
        img_dsc.header.w = disp_w;
        img_dsc.header.h = disp_h;
        img_dsc.header.cf = LV_COLOR_FORMAT_RGB565;
        img_dsc.data_size = disp_w * disp_h * 2;
        img_dsc.data = s_rgb_buf;
        lv_image_set_src(img, &img_dsc);
        lv_obj_align(img, LV_ALIGN_TOP_LEFT, 0, 0);
        lv_refr_now(s_display);
    }

    return ESP_OK;
}

void vellum_display_off(void)
{
    d1001_backlight_off();
}

int vellum_display_width(void)  { return LCD_WIDTH; }
int vellum_display_height(void) { return LCD_HEIGHT; }

/* ── Legacy API wrappers ──────────────────────────────────────── */

esp_err_t display_init(void) { return vellum_display_init(); }

esp_err_t display_get_info(display_info_t *info)
{
    if (!info) return ESP_ERR_INVALID_ARG;
    info->model = "d1001";
    info->width = LCD_WIDTH;
    info->height = LCD_HEIGHT;
    info->bpp = 16;
    info->color_mode = "fullcolor";
    return ESP_OK;
}

void display_show_boot(const char *version)       { vellum_display_show_status(version); }
void display_show_wifi_setup(const char *ssid, const char *url) { (void)url; vellum_display_show_status(ssid); }
void display_show_connecting(const char *ssid)    { vellum_display_show_status(ssid); }
void display_show_ota_progress(uint8_t percent)   { (void)percent; vellum_display_show_status("Updating..."); }
void display_show_error(const char *message)      { vellum_display_show_status(message); }
void display_show_low_battery(void)               { vellum_display_show_status("Low Battery"); }
esp_err_t display_update_raw(const uint8_t *buf, size_t len) { return vellum_display_show_image(buf, len, "jpeg"); }
esp_err_t display_sleep(void)  { ESP_LOGW(TAG, "display_sleep called!"); vellum_display_off(); return ESP_OK; }
esp_err_t display_wake(void)   { d1001_backlight_on(); return ESP_OK; }
