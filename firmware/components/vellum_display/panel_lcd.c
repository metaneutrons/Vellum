// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file panel_lcd.c
 * @brief LCD backend (ESP32-P4): JD9365 MIPI-DSI. Implements vellum_panel()
 *        for the shared screen layer (d1001 / 800x1280 RGB565).
 */

#include "vellum_panel.h"

#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_cache.h"
#include "lvgl.h"
#include "esp_lcd_mipi_dsi.h"
#include "d1001_board.h"
#include "lcd_jd9365.h"
#include "jpeg_decoder.h"
#include "lcd_rotation.h"
/* Static image descriptor in flash. Building it in PSRAM at boot (malloc + a
 * full-image memcpy) bought nothing for an asset that never changes, and held
 * ~190 KB of PSRAM for the lifetime of the device. */
extern const lv_image_dsc_t vellum_logo_color_360px;

static const char *TAG = "panel_lcd";

#define LCD_WIDTH  800
#define LCD_HEIGHT 1280
/* LVGL only renders dirty regions into this line buffer. A progress-label or
 * bar update is therefore tens of KiB instead of a 2 MiB full-screen PSRAM
 * read/rotate/write cycle competing with the DSI scanout. */
#define LCD_DRAW_LINES 24

static lv_display_t *s_disp = NULL;
static uint16_t     *s_panel_fb = NULL;
static bool          s_dirty_valid = false;
static int           s_dirty_x1, s_dirty_y1, s_dirty_x2, s_dirty_y2;

static void sync_dirty_panel_area(void)
{
    if (!s_dirty_valid) return;

    const int first_row = LCD_HEIGHT - 1 - s_dirty_x2;
    const int last_row = LCD_HEIGHT - 1 - s_dirty_x1;
    const int column_count = s_dirty_y2 - s_dirty_y1 + 1;
    esp_err_t err = ESP_OK;

    if (column_count >= LCD_WIDTH / 2) {
        /* A screen transition is cheaper as one cache operation. */
        uint16_t *start = s_panel_fb + first_row * LCD_WIDTH;
        size_t bytes = (size_t)(last_row - first_row + 1) * LCD_WIDTH * sizeof(uint16_t);
        err = esp_cache_msync(start, bytes, ESP_CACHE_MSYNC_FLAG_DIR_C2M |
                             ESP_CACHE_MSYNC_FLAG_UNALIGNED);
    } else {
        /* A landscape progress bar becomes a tall, narrow portrait region.
         * Sync only those cache lines; syncing its rectangular 1 MiB bounding
         * box was enough memory pressure to underrun DSI and flash light blue. */
        for (int row = first_row; row <= last_row && err == ESP_OK; row++) {
            uint16_t *start = s_panel_fb + row * LCD_WIDTH + s_dirty_y1;
            err = esp_cache_msync(start, (size_t)column_count * sizeof(uint16_t),
                                  ESP_CACHE_MSYNC_FLAG_DIR_C2M |
                                  ESP_CACHE_MSYNC_FLAG_UNALIGNED);
        }
    }
    if (err != ESP_OK) ESP_LOGE(TAG, "LCD dirty-area flush failed: %s", esp_err_to_name(err));
    s_dirty_valid = false;
}

static void flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map)
{
    /* JD9365's scanout is fixed at 800x1280 and cannot swap X/Y in
     * hardware. Rotate only LVGL's dirty rectangle into the continuous-scan
     * framebuffer. The previous FULL render mode rotated all 1,024,000 pixels
     * for every 10% OTA update; that PSRAM traffic starved DSI and its documented
     * underrun behavior is a blue frame. */
    const uint16_t *src = (const uint16_t *)px_map;
    const int area_width = area->x2 - area->x1 + 1;
    for (int y = area->y1; y <= area->y2; y++) {
        for (int x = area->x1; x <= area->x2; x++) {
            s_panel_fb[lcd_rotation_90_cw_index(x, y, LCD_WIDTH, LCD_HEIGHT)] =
                src[(y - area->y1) * area_width + (x - area->x1)];
        }
    }

    if (!s_dirty_valid) {
        s_dirty_x1 = area->x1; s_dirty_y1 = area->y1;
        s_dirty_x2 = area->x2; s_dirty_y2 = area->y2;
        s_dirty_valid = true;
    } else {
        if (area->x1 < s_dirty_x1) s_dirty_x1 = area->x1;
        if (area->y1 < s_dirty_y1) s_dirty_y1 = area->y1;
        if (area->x2 > s_dirty_x2) s_dirty_x2 = area->x2;
        if (area->y2 > s_dirty_y2) s_dirty_y2 = area->y2;
    }
    /* Multiple chunks can belong to one LVGL refresh. Publish their cache lines
     * together to minimize the interval in which scanout can observe a mixed
     * progress value. */
    if (lv_display_flush_is_last(disp)) sync_dirty_panel_area();
    lv_display_flush_ready(disp);
}

/* ── vtable ops ───────────────────────────────────────────────── */

static lv_display_t *lcd_init(void)
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
        /* One continuously scanned framebuffer. Flicker prevention comes from
         * bounded dirty-region writes below, not from an uninitialized second
         * buffer or an unsafe framebuffer switch in the GDMA ISR. */
        .num_fb = 1,
        .io_expander = d1001_io_expander(),
        .rst_mask = D1001_EXP_LCD_RST,
    };
    esp_lcd_panel_handle_t panel = NULL;
    esp_lcd_panel_io_handle_t io = NULL;
    if (lcd_jd9365_init(&lcd_cfg, &panel, &io) != ESP_OK) {
        ESP_LOGE(TAG, "lcd_jd9365_init failed");
        return NULL;
    }

    lv_init();

    /* Single framebuffer — see .num_fb above. */
    void *buf1 = NULL;
    if (esp_lcd_dpi_panel_get_frame_buffer(panel, 1, &buf1) != ESP_OK) return NULL;

    const size_t render_bytes = (size_t)LCD_HEIGHT * LCD_DRAW_LINES * sizeof(uint16_t);
    uint16_t *render_buf = heap_caps_malloc(render_bytes, MALLOC_CAP_SPIRAM);
    if (!render_buf) {
        ESP_LOGE(TAG, "Unable to allocate landscape render buffer");
        return NULL;
    }

    s_panel_fb = buf1;
    memset(s_panel_fb, 0, LCD_WIDTH * LCD_HEIGHT * 2);
    ESP_ERROR_CHECK(esp_cache_msync(s_panel_fb, LCD_WIDTH * LCD_HEIGHT * 2,
                                    ESP_CACHE_MSYNC_FLAG_DIR_C2M |
                                    ESP_CACHE_MSYNC_FLAG_UNALIGNED));

    s_disp = lv_display_create(LCD_HEIGHT, LCD_WIDTH);
    lv_display_set_color_format(s_disp, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(s_disp, render_buf, NULL,
                           render_bytes, LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(s_disp, flush_cb);

    vTaskDelay(pdMS_TO_TICKS(100));
    d1001_backlight_on();
    ESP_LOGI(TAG, "LCD initialized: %dx%d", LCD_WIDTH, LCD_HEIGHT);
    return s_disp;
}

static void lcd_refresh(void)
{
    if (s_disp) lv_refr_now(s_disp);
}

static esp_err_t lcd_draw_raw(const uint8_t *data, size_t len)
{
    if (!data || !s_disp) return ESP_ERR_INVALID_STATE;

    static uint8_t *s_rgb_buf = NULL;
    if (!s_rgb_buf)
        s_rgb_buf = heap_caps_malloc(LCD_WIDTH * LCD_HEIGHT * 2, MALLOC_CAP_SPIRAM);
    if (!s_rgb_buf) return ESP_ERR_NO_MEM;

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

    lv_obj_t *scr = lv_display_get_screen_active(s_disp);
    lv_obj_clean(scr);
    lv_obj_t *img = lv_image_create(scr);
    static lv_image_dsc_t img_dsc;
    memset(&img_dsc, 0, sizeof(img_dsc));
    img_dsc.header.w = out.width;
    img_dsc.header.h = out.height;
    img_dsc.header.cf = LV_COLOR_FORMAT_RGB565;
    img_dsc.data_size = out.width * out.height * 2;
    img_dsc.data = s_rgb_buf;
    lv_image_set_src(img, &img_dsc);
    lv_obj_align(img, LV_ALIGN_TOP_LEFT, 0, 0);
    lv_refr_now(s_disp);
    return ESP_OK;
}

static void lcd_off(void) { d1001_backlight_off(); }
static void lcd_wake(void) { d1001_backlight_on(); }

/* ── Panel descriptor ─────────────────────────────────────────── */

static vellum_panel_t s_panel = {
    .init = lcd_init,
    .refresh = lcd_refresh,
    .draw_raw = lcd_draw_raw,
    .sleep = lcd_off,
    .wake = lcd_wake,
    .off = lcd_off,
    .width = LCD_HEIGHT,
    .height = LCD_WIDTH,
    .bpp = 16,
    .model = "d1001",
    .color_mode = "fullcolor",
    .fast_refresh = true,
    .needs_tick_timer = true,
    /* Fonts enabled in the P4 LVGL config (sdkconfig.defaults.p4). */
    .font_lg = &lv_font_montserrat_48,
    .font_md = &lv_font_montserrat_32,
    .font_sm = &lv_font_montserrat_24,
    .font_xs = &lv_font_montserrat_16,
};

const vellum_panel_t *vellum_panel(void)
{
    /* lv_color_t isn't a constant expression — set the (dark) theme here. */
    s_panel.bg    = lv_color_black();
    s_panel.fg    = lv_color_white();
    s_panel.muted = lv_color_hex(0x999999);
    s_panel.dim   = lv_color_hex(0x666666);
    s_panel.logo  = &vellum_logo_color_360px;
    return &s_panel;
}
